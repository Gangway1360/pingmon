"""Point d'entree : options, verrou, migration, demarrage des services."""
import argparse
import logging
import signal
import sys
import threading
import time
import webbrowser
from pathlib import Path

from . import db as dbm
from . import instance, lifecycle, logs, monitor, rollup, settings, store
from .api import Handler, Server
from .config import CFG, VERSION

log = logging.getLogger("main")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(description="PingMon %s - monitoring de latence par ping" % VERSION)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="adresse d'ecoute (defaut 127.0.0.1 = ce poste uniquement)")
    ap.add_argument("--db", default=CFG["db"], help="fichier SQLite (defaut : a cote de run.py)")
    ap.add_argument("--retention-days", type=int, default=None,
                    help="duree de conservation de l'historique (resume par minute), en jours (tags conserves)")
    ap.add_argument("--raw-days", type=int, default=None,
                    help="duree de conservation des mesures brutes (chaque ping), en jours")
    ap.add_argument("--backups", type=int, default=None,
                    help="nombre de sauvegardes quotidiennes gardees (0 = desactive)")
    ap.add_argument("--no-backoff", action="store_true",
                    help="ne pas ralentir le ping d'une cible injoignable (defaut : 5 s apres 30 echecs)")
    ap.add_argument("--demo", action="store_true", help="latences simulees, aucun ping reel")
    ap.add_argument("--no-browser", action="store_true", help="ne pas ouvrir le navigateur")
    ap.add_argument("--verbose", action="store_true", help="journal detaille, aussi en console")
    return ap.parse_args(argv)


def main(argv=None):
    a = parse_args(argv)
    dbp = Path(a.db).resolve()
    # options passees explicitement : elles priment sur les parametres de l'interface (et y sont verrouillees)
    cli = {}
    if a.retention_days is not None:
        cli["retention_days"] = max(1, a.retention_days)
    if a.raw_days is not None:
        cli["raw_days"] = max(1, a.raw_days)
    if a.backups is not None:
        cli["backups_keep"] = max(0, a.backups)
    if a.no_backoff:
        cli["backoff"] = False
    CFG.update(db=str(dbp), demo=a.demo, backup_dir=str(dbp.parent / "backups"),
               log_file=str(dbp.parent / "logs" / "pingmon.log"), started=int(time.time() * 1000))
    dbp.parent.mkdir(parents=True, exist_ok=True)
    logs.setup(CFG["log_file"], a.verbose)
    url_file = Path(str(dbp) + ".url")

    if not instance.acquire(str(dbp) + ".lock"):
        url = url_file.read_text().strip() if url_file.exists() else ""
        print("PingMon tourne deja sur cette base%s." % (" : " + url if url else ""))
        if url and not a.no_browser:
            webbrowser.open(url)
        sys.exit(0)

    log.info("=== PingMon %s, base %s ===", VERSION, dbp)
    try:
        dbm.migrate()
        settings.load(cli)
    except Exception as e:
        log.exception("Base inutilisable")
        print("Base de donnees inutilisable : %s" % e)
        sys.exit(2)

    if a.host in ("127.0.0.1", "localhost", "::1"):
        CFG["allowed_hosts"] = {"127.0.0.1:%d" % a.port, "localhost:%d" % a.port, "[::1]:%d" % a.port}
    else:
        CFG["strict_host"] = False
    try:
        srv = Server((a.host, a.port), Handler)
    except OSError as e:
        log.error("Ecoute impossible sur %s:%d : %s", a.host, a.port, e)
        print("Impossible d'ecouter sur %s:%d (%s). Port deja utilise ? Essaie --port %d"
              % (a.host, a.port, e, a.port + 1))
        sys.exit(1)

    url = "http://%s:%d/" % ("127.0.0.1" if a.host in ("0.0.0.0", "") else a.host, a.port)
    CFG["url"] = url
    try:
        url_file.write_text(url)
    except OSError:
        pass

    lifecycle.startup()
    monitor.start_writer()
    monitor.start_maintenance()
    lifecycle.start_heartbeat()
    rollup.start()
    for t in store.active_targets():
        monitor.MON.start(t)

    print("PingMon %s demarre : %s" % (VERSION, url))
    print("Base : %s | brut %d j, historique %d j | sauvegardes %s%s" % (
        dbp, CFG["raw_days"], CFG["retention_days"], CFG["backups_keep"] or "desactivees", " | MODE DEMO" if a.demo else ""))
    print("Journal : %s" % CFG["log_file"])
    print("Ctrl+C pour arreter.")
    if not a.no_browser:
        threading.Timer(0.6, webbrowser.open, [url]).start()

    def _stop(*_):
        raise KeyboardInterrupt
    for sig in ("SIGTERM", "SIGBREAK"):   # SIGBREAK : fermeture de la console Windows
        if hasattr(signal, sig):
            try:
                signal.signal(getattr(signal, sig), _stop)
            except (ValueError, OSError):
                pass
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nArret...")
    finally:
        monitor.MON.stop_all()
        time.sleep(0.3)   # laisse les boucles fermer leurs coupures en cours
        monitor.stop_writer()
        lifecycle.shutdown()
        srv.server_close()
        try:
            url_file.unlink()
        except OSError:
            pass
        log.info("Arret propre")
