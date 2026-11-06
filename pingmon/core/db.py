"""SQLite : connexions, schema versionne (PRAGMA user_version), sauvegardes."""
import logging
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

from .config import CFG

log = logging.getLogger("db")

# Chaque entree fait passer le schema de la version i a i+1. Ne jamais modifier
# une migration deja publiee : en ajouter une nouvelle a la fin.
MIGRATIONS = [
    # v1 : schema de PingMon 1.0
    """
    CREATE TABLE IF NOT EXISTS targets(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      host TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      interval_ms INTEGER NOT NULL DEFAULT 1000,
      timeout_ms INTEGER NOT NULL DEFAULT 2000,
      active INTEGER NOT NULL DEFAULT 1,
      color INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS samples(
      target_id INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      rtt REAL,
      PRIMARY KEY(target_id, ts)
    ) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS tags(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER,
      ts INTEGER NOT NULL,
      ts_end INTEGER,
      label TEXT NOT NULL,
      color INTEGER NOT NULL DEFAULT 1,
      note TEXT NOT NULL DEFAULT '',
      created INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS tags_ts ON tags(ts);
    """,
    # v2 : etat actif/pause/arrete, IP resolue, type d'echec, tags automatiques
    """
    ALTER TABLE targets ADD COLUMN state TEXT NOT NULL DEFAULT 'active';
    UPDATE targets SET state = CASE WHEN active=1 THEN 'active' ELSE 'paused' END;
    ALTER TABLE targets ADD COLUMN ip TEXT;
    ALTER TABLE targets ADD COLUMN ip_checked INTEGER;
    ALTER TABLE samples ADD COLUMN err INTEGER;
    ALTER TABLE samples ADD COLUMN src TEXT;
    UPDATE samples SET err=1 WHERE rtt IS NULL;
    ALTER TABLE tags ADD COLUMN auto INTEGER NOT NULL DEFAULT 0;
    """,
    # v3 : instant de l'arret (la timeline d'une cible arretee s'y fige)
    """
    ALTER TABLE targets ADD COLUMN stopped_at INTEGER;
    UPDATE targets SET stopped_at = COALESCE((SELECT MAX(ts) FROM samples WHERE target_id=targets.id), created)
      WHERE state='stopped';
    """,
    # v4 : site, seuil de coupure, type de tag auto, periodes non surveillees, etat du serveur
    """
    ALTER TABLE targets ADD COLUMN site TEXT NOT NULL DEFAULT '';
    ALTER TABLE targets ADD COLUMN outage_n INTEGER NOT NULL DEFAULT 3;
    ALTER TABLE tags ADD COLUMN kind TEXT NOT NULL DEFAULT '';
    UPDATE tags SET kind='ip' WHERE auto=1;
    CREATE TABLE gaps(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      target_id INTEGER,
      start INTEGER NOT NULL,
      end INTEGER,
      reason TEXT NOT NULL
    );
    CREATE INDEX gaps_t ON gaps(target_id, start);
    CREATE TABLE meta(k TEXT PRIMARY KEY, v TEXT);
    INSERT INTO gaps(target_id, start, end, reason)
      SELECT id, COALESCE(stopped_at, (SELECT MAX(ts) FROM samples WHERE target_id=targets.id), created), NULL,
             CASE state WHEN 'paused' THEN 'pause' ELSE 'stop' END
      FROM targets WHERE state!='active';
    """,
    # v5 : ordre d'affichage choisi par l'utilisateur
    """
    ALTER TABLE targets ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE targets SET position = id;
    """,
    # v6 : intervalle minimal porte a 1 s (garde-fou de charge)
    """
    UPDATE targets SET interval_ms = 1000 WHERE interval_ms < 1000;
    """,
    # v7 : resumes par minute (longues fenetres rapides, base de taille stable)
    """
    CREATE TABLE minutes(
      target_id INTEGER NOT NULL, ts INTEGER NOT NULL,
      n INTEGER NOT NULL, ok INTEGER NOT NULL, sum REAL NOT NULL, sumsq REAL NOT NULL, min REAL, max REAL,
      e1 INTEGER NOT NULL, e2 INTEGER NOT NULL, e3 INTEGER NOT NULL, e4 INTEGER NOT NULL, e5 INTEGER NOT NULL,
      jsum REAL NOT NULL, jn INTEGER NOT NULL, first_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
      lead INTEGER NOT NULL, lead_end INTEGER, trail INTEGER NOT NULL, trail_start INTEGER,
      inner_runs INTEGER NOT NULL, inner_max_ms INTEGER NOT NULL, hist TEXT NOT NULL,
      PRIMARY KEY(target_id, ts)
    ) WITHOUT ROWID;
    """,
    # v8 : coupures >= N et temps d'indisponibilite dans les resumes (recalcules depuis le brut)
    """
    ALTER TABLE minutes ADD COLUMN inner_out INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE minutes ADD COLUMN inner_down_ms INTEGER NOT NULL DEFAULT 0;
    DELETE FROM minutes;
    """,
]
SCHEMA_VERSION = len(MIGRATIONS)


def connect():
    c = sqlite3.connect(CFG["db"], timeout=15)
    c.row_factory = sqlite3.Row
    return c


@contextmanager
def db():
    c = connect()
    try:
        yield c
        c.commit()
    except Exception:
        c.rollback()
        raise
    finally:
        c.close()


def migrate():
    """Cree ou met a jour le schema. Sauvegarde la base avant toute migration."""
    Path(CFG["db"]).parent.mkdir(parents=True, exist_ok=True)
    c = connect()
    try:
        c.execute("PRAGMA journal_mode=WAL")
        ver = c.execute("PRAGMA user_version").fetchone()[0]
        if ver > SCHEMA_VERSION:
            raise RuntimeError("base creee par une version plus recente de PingMon (schema v%d, "
                               "cette version gere jusqu'a v%d)" % (ver, SCHEMA_VERSION))
        if ver < SCHEMA_VERSION:
            existing = c.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='targets'").fetchone()[0]
            if existing:
                path = backup("avant-migration-v%d" % SCHEMA_VERSION, conn=c)
                log.warning("Migration du schema v%d -> v%d (sauvegarde : %s)", ver, SCHEMA_VERSION, path)
            for i in range(ver, SCHEMA_VERSION):
                try:
                    c.executescript("BEGIN;\n%s\nPRAGMA user_version=%d;\nCOMMIT;" % (MIGRATIONS[i], i + 1))
                except sqlite3.Error:
                    try:
                        c.execute("ROLLBACK")
                    except sqlite3.Error:
                        pass
                    raise
        t0 = time.time()
        res = c.execute("PRAGMA quick_check").fetchone()[0]
        if res != "ok":
            log.error("Controle d'integrite de la base : %s", res)
        else:
            log.info("Base OK (schema v%d, controle en %.1f s)", SCHEMA_VERSION, time.time() - t0)
        return res
    finally:
        c.close()


def list_backups():
    d = Path(CFG["backup_dir"])
    if not d.is_dir():
        return []
    return sorted(d.glob("pingmon-*.db"), key=lambda p: p.stat().st_mtime)


def last_backup_time():
    b = list_backups()
    return b[-1].stat().st_mtime if b else None


def backup(kind="auto", conn=None):
    """Copie a chaud (API backup de SQLite). kind : auto, manuel, avant-migration-vN."""
    d = Path(CFG["backup_dir"])
    d.mkdir(parents=True, exist_ok=True)
    dst_path = d / ("pingmon-%s-%s.db" % (time.strftime("%Y%m%d-%H%M%S"), kind))
    src = conn or connect()
    try:
        dst = sqlite3.connect(str(dst_path))
        try:
            src.backup(dst)
        finally:
            dst.close()
    finally:
        if conn is None:
            src.close()
    prune_backups()
    return str(dst_path)


def prune_backups():
    """Ne garde que les N dernieres sauvegardes automatiques (les manuelles restent)."""
    keep = CFG["backups_keep"]
    auto = [p for p in list_backups() if p.name.endswith("-auto.db")]
    for p in (auto[:-keep] if keep > 0 else auto):
        try:
            p.unlink()
        except OSError as e:
            log.warning("Suppression de %s impossible : %s", p, e)


def db_size():
    p = Path(CFG["db"])
    return sum(f.stat().st_size for f in (p, p.with_name(p.name + "-wal")) if f.exists())
