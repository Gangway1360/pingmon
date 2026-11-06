"""Vie du serveur : battement de coeur, detection de veille, reprise apres arret."""
import logging
import sqlite3
import threading
import time

from .db import db
from .hub import HUB
from .monitor import now_ms
from .stats import fmt_dur

log = logging.getLogger("lifecycle")

BEAT_S = 5
SERVER_GAP_MS = 15000     # trou minimal pour noter "PingMon arrete"
SLEEP_GAP_MS = 45000      # battement en retard de plus de 45 s = poste en veille


def _beat(c, ts):
    c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('last_beat',?)", (str(ts),))


def add_gap(c, start, end, reason, target_id=None):
    c.execute("INSERT INTO gaps(target_id,start,end,reason) VALUES(?,?,?,?)", (target_id, start, end, reason))


def startup():
    """Note la periode d'arret du serveur et ferme les coupures restees ouvertes."""
    now = now_ms()
    with db() as c:
        r = c.execute("SELECT v FROM meta WHERE k='last_beat'").fetchone()
        if r:
            last = int(r[0])
            if now - last > SERVER_GAP_MS:
                add_gap(c, last, now, "server")
                log.info("PingMon etait arrete depuis %d s", (now - last) // 1000)
        for tg in c.execute("SELECT id,target_id,ts,label FROM tags WHERE kind='outage' AND ts_end IS NULL").fetchall():
            end = c.execute("SELECT MAX(ts) FROM samples WHERE target_id=? AND ts>=?", (tg[1], tg[2])).fetchone()[0]
            end = end or tg[2]
            kind = tg[3].split(" · ", 1)[1] if " · " in tg[3] else ""
            label = "Coupure interrompue (≥ %s)%s" % (fmt_dur(end - tg[2]), " · " + kind if kind else "")
            c.execute("UPDATE tags SET ts_end=?, label=? WHERE id=?", (end, label[:80], tg[0]))
        _beat(c, now)


def shutdown():
    try:
        with db() as c:
            _beat(c, now_ms())
    except sqlite3.Error:
        pass


def heartbeat_loop():
    prev = now_ms()
    while True:
        time.sleep(BEAT_S)
        now = now_ms()
        try:
            with db() as c:
                if now - prev > SLEEP_GAP_MS:
                    add_gap(c, prev, now, "sleep")
                    log.warning("Poste en veille ou bloque pendant %d s", (now - prev) // 1000)
                _beat(c, now)
            if now - prev > SLEEP_GAP_MS:
                HUB.publish("gaps", {})
        except sqlite3.Error as e:
            log.warning("Battement non enregistre : %s", e)
        prev = now


def start_heartbeat():
    threading.Thread(target=heartbeat_loop, daemon=True, name="heartbeat").start()
