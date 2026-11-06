"""Boucles de ping par cible, ecriture groupee en base, maintenance."""
import logging
import math
import queue
import random
import sqlite3
import threading
import time

from . import db as dbm
from . import pinger, resolver
from .stats import fmt_dur
from .config import (CFG, DNS_REFRESH_S, DNS_RETRY_KNOWN_S, DNS_RETRY_S,
                     MIN_INTERVAL_MS)
from .hub import HUB

log = logging.getLogger("monitor")

WQ = queue.Queue(maxsize=200000)
STATS = {"dropped": 0, "written": 0}
_writer = None


def now_ms():
    return int(time.time() * 1000)


# ------------------------------------------------------------ ecriture
def enqueue(item):
    try:
        WQ.put_nowait(item)
    except queue.Full:
        STATS["dropped"] += 1
        if STATS["dropped"] % 1000 == 1:
            log.error("File d'ecriture pleine : %d mesures perdues au total", STATS["dropped"])


def _write(c, batch):
    c.executemany("INSERT OR REPLACE INTO samples(target_id,ts,rtt,err,src) VALUES(?,?,?,?,?)", batch)
    c.commit()


def writer_loop():
    c = None
    stop = False
    while not stop:
        item = WQ.get()
        if item is None:
            break
        batch = [item]
        deadline = time.time() + 0.5
        while True:
            try:
                it = WQ.get(timeout=max(0.0, deadline - time.time()))
            except queue.Empty:
                break
            if it is None:
                stop = True
                break
            batch.append(it)
        for attempt in range(3):
            try:
                if c is None:
                    c = dbm.connect()
                _write(c, batch)
                STATS["written"] += len(batch)
                break
            except sqlite3.Error as e:
                log.warning("Ecriture SQLite echouee (essai %d/3) : %s", attempt + 1, e)
                try:
                    c.close()
                except Exception:
                    pass
                c = None
                time.sleep(1)
        else:
            STATS["dropped"] += len(batch)
            log.error("%d mesures perdues (base inaccessible)", len(batch))
    if c is not None:
        c.close()


def start_writer():
    global _writer
    _writer = threading.Thread(target=writer_loop, daemon=True, name="writer")
    _writer.start()


def stop_writer():
    try:
        WQ.put(None, timeout=2)
    except queue.Full:
        pass
    if _writer:
        _writer.join(timeout=5)


# ------------------------------------------------------- DNS / tags auto
def add_auto_tag(c, target_id, ts, label, color, note="", kind="ip"):
    cur = c.execute("INSERT INTO tags(target_id,ts,ts_end,label,color,note,created,auto,kind) "
                    "VALUES(?,?,NULL,?,?,?,?,1,?)", (target_id, ts, label[:80], color, note[:500], now_ms(), kind))
    return cur.lastrowid


# ----------------------------------------------------- coupures (tags auto)
class Outage:
    """Suit les echecs consecutifs d'une cible ; au seuil, ouvre un tag de coupure."""

    NOTE_EVERY_MS = 15000   # mise a jour de la note d'une coupure en cours

    def __init__(self, t):
        self.t = t
        self.n = t.get("outage_n", 3)
        self.interval = max(t["interval_ms"], MIN_INTERVAL_MS)
        self.brk = max(3 * self.interval, CFG["backoff_s"] * 3000, 10000)   # trou de mesures : la serie repart a zero
        self.slowed = False
        self.reset()

    def reset(self):
        self.fails = 0
        self.first = self.last = None
        self.counts = {}
        self.order = []
        self.tag = None
        self.noted = 0

    def snapshot(self):
        """Serie d'echecs en cours (depuis la derniere reponse, sans franchir un trou de surveillance)."""
        if not self.fails:
            return None
        return {"since": self.first, "order": list(self.order), "fails": self.fails,
                "counts": {str(k): v for k, v in self.counts.items()}, "slowed": self.slowed}

    def _dominant(self):
        return pinger.LABELS.get(max(self.counts, key=self.counts.get), "Échec") if self.counts else "Échec"

    def _note(self):
        parts = ["%d %s" % (v, pinger.LABELS.get(k, "?").lower()) for k, v in sorted(self.counts.items(), key=lambda x: -x[1])]
        return "%d échecs consécutifs : %s" % (self.fails, ", ".join(parts))

    def fail(self, ts, err):
        if self.last is not None and ts - self.last > self.brk:
            # veille du poste ou blocage : on ne relie pas les echecs d'avant et d'apres
            if self.tag is not None:
                self.close(self.last + self.interval, interrupted=True)
            self.reset()
        self.fails += 1
        if self.fails == 1:
            self.first = ts
        self.last = ts
        if err not in self.counts:
            self.order.append(err)
        self.counts[err] = self.counts.get(err, 0) + 1
        if self.tag is not None and ts - self.noted >= self.NOTE_EVERY_MS:
            self._update_note(ts)
        if self.n and self.fails >= self.n and self.tag is None:
            try:
                with dbm.db() as c:
                    self.tag = add_auto_tag(c, self.t["id"], self.first, "Coupure en cours · " + self._dominant(),
                                            7, self._note(), kind="outage")
                self.noted = ts
                log.warning("%s : coupure detectee (%d echecs)", self.t["host"], self.fails)
                HUB.publish("tags", {})
            except sqlite3.Error as e:
                log.warning("Tag de coupure impossible : %s", e)

    def _update_note(self, ts):
        self.noted = ts
        try:
            with dbm.db() as c:
                c.execute("UPDATE tags SET label=?, note=? WHERE id=?",
                          (("Coupure en cours · " + self._dominant())[:80], self._note()[:500], self.tag))
            HUB.publish("tags", {})
        except sqlite3.Error as e:
            log.warning("Mise a jour du tag de coupure impossible : %s", e)

    def ok(self, ts):
        if self.tag is not None:
            self.close(ts, interrupted=False)
        self.reset()

    def close(self, end, interrupted):
        if self.tag is None:
            return
        dur = fmt_dur(end - self.first)
        label = ("Coupure interrompue (≥ %s) · %s" if interrupted else "Coupure de %s · %s") % (dur, self._dominant())
        note = self._note() + (" · surveillance interrompue" if interrupted else "")
        try:
            with dbm.db() as c:
                c.execute("UPDATE tags SET ts_end=?, label=?, note=? WHERE id=?", (end, label[:80], note[:500], self.tag))
            log.info("%s : %s", self.t["host"], label)
            HUB.publish("tags", {})
        except sqlite3.Error as e:
            log.warning("Fermeture du tag de coupure impossible : %s", e)
        self.tag = None


def set_ip(tid, host, new, old):
    ts = now_ms()
    with dbm.db() as c:
        c.execute("UPDATE targets SET ip=?, ip_checked=? WHERE id=?", (new, ts, tid))
        if old and old != new:
            add_auto_tag(c, tid, ts, "IP changée : %s → %s" % (old, new), 6,
                         "Nouvelle résolution DNS de %s" % host)
    if old != new:
        if old:
            log.warning("%s : IP changee %s -> %s", host, old, new)
            HUB.publish("tags", {})
        HUB.publish("targets", {})


def touch_ip(tid):
    with dbm.db() as c:
        c.execute("UPDATE targets SET ip_checked=? WHERE id=?", (now_ms(), tid))


# ------------------------------------------------------------- monitor
class Monitor:
    def __init__(self):
        self.lock = threading.Lock()
        self.workers = {}  # id -> (thread, stop_event)
        self.outages = {}  # id -> Outage de la boucle en cours

    def _refresh_dns(self, t, ip):
        host, tid = t["host"], t["id"]
        mono = time.monotonic()
        ips = resolver.resolve(host)
        if not ips:
            if ip:
                log.warning("%s : resolution DNS impossible, on garde %s", host, ip)
                return ip, mono + DNS_RETRY_KNOWN_S
            return None, mono + DNS_RETRY_S
        try:
            if ip in ips:                  # round-robin : on reste sur la meme IP
                touch_ip(tid)
                return ip, mono + DNS_REFRESH_S
            set_ip(tid, host, ips[0], ip)
        except sqlite3.Error as e:
            log.warning("%s : enregistrement de l'IP impossible : %s", host, e)
        return ips[0], mono + DNS_REFRESH_S

    def _run(self, t, stop):
        tid, host = t["id"], t["host"]
        literal = resolver.is_ip(host)
        ip = host if literal else t.get("ip")
        next_dns = math.inf if literal else 0.0
        nxt = time.monotonic()
        outage = Outage(t)
        self.outages[tid] = outage
        log.info("Demarrage %s (#%d), toutes les %d ms", host, tid, t["interval_ms"])
        try:
            self._loop(t, stop, ip, literal, next_dns, nxt, outage)
        finally:
            if self.outages.get(tid) is outage:
                self.outages.pop(tid, None)
            if outage.tag is not None:
                outage.close(outage.last + t["interval_ms"], interrupted=True)
        log.info("Arret %s (#%d)", host, tid)

    def _loop(self, t, stop, ip, literal, next_dns, nxt, outage):
        tid, host = t["id"], t["host"]
        interval = max(t["interval_ms"], MIN_INTERVAL_MS) / 1000.0
        timeout = t["timeout_ms"]   # un seul ping en vol par cible : le suivant attend la reponse ou le timeout
        # demarrage decale : 50 cibles lancees ensemble ne partent pas toutes a la meme milliseconde
        if stop.wait(random.uniform(0, min(interval, 2.0))):
            return
        nxt = time.monotonic()
        slow = False
        while not stop.is_set():
            try:
                if time.monotonic() >= next_dns:
                    ip, next_dns = self._refresh_dns(t, ip)
                    if stop.is_set():
                        break
                ts = now_ms()
                if ip is None:
                    rtt, err, src = None, pinger.DNS, None
                else:
                    rtt, err, src = pinger.ping(ip, timeout)
            except Exception:
                log.exception("Erreur inattendue sur %s", host)
                ts, rtt, err, src = now_ms(), None, pinger.OTHER, None
            if stop.is_set():
                break
            e = None if err == pinger.OK else err
            enqueue((tid, ts, rtt, e, src))
            if e is None:
                outage.ok(ts)
            else:
                outage.fail(ts, e)
            # cible injoignable depuis longtemps : ping ralenti jusqu'a son retour
            # (moins d'ARP diffuses par la passerelle pour un hote eteint)
            was = slow
            slow = CFG["backoff"] and outage.fails >= CFG["backoff_after"]
            outage.slowed = slow and ip is not None     # echec DNS : aucun ping envoye, rien a ralentir
            if slow != was and ip is not None:
                log.info("%s : ping %s", host, "ralenti a %d s (cible injoignable)" % CFG["backoff_s"] if slow else "retour a la cadence normale")
            HUB.publish("sample", {"t": tid, "ts": ts, "rtt": rtt, "err": e, "src": src,
                                   "fs": outage.first if e else None, "slow": outage.slowed})
            nxt += max(interval, CFG["backoff_s"]) if slow else interval
            cur = time.monotonic()
            if nxt < cur:   # retard (veille, ping long) : on repart de maintenant, jamais de rattrapage en rafale
                nxt = cur
            stop.wait(nxt - cur)

    def start(self, t):
        self.stop(t["id"])
        ev = threading.Event()
        th = threading.Thread(target=self._run, args=(t, ev), daemon=True, name="ping-%d" % t["id"])
        with self.lock:
            self.workers[t["id"]] = (th, ev)
        th.start()

    def stop(self, tid):
        with self.lock:
            w = self.workers.pop(tid, None)
        if w:
            w[1].set()

    def stop_all(self):
        for tid in list(self.workers):
            self.stop(tid)

    def streak(self, tid):
        o = self.outages.get(tid)
        return o.snapshot() if o else None

    def count(self):
        with self.lock:
            return len(self.workers)


MON = Monitor()


# ---------------------------------------------------------- maintenance
def maintenance_loop():
    while True:
        try:
            from .rollup import purge
            with dbm.db() as c:
                n_raw, n_min = purge(c, now_ms())
                c.execute("PRAGMA optimize")
            if n_raw or n_min:
                log.info("Purge : %d mesures brutes (> %d j) et %d minutes (> %d j) supprimees",
                         n_raw, CFG["raw_days"], n_min, CFG["retention_days"])
        except sqlite3.Error as e:
            log.error("Purge impossible : %s", e)
        try:
            if CFG["backups_keep"] > 0:
                last = dbm.last_backup_time()
                if last is None or time.time() - last > 86400:
                    log.info("Sauvegarde automatique : %s", dbm.backup("auto"))
        except Exception:
            log.exception("Sauvegarde automatique echouee")
        time.sleep(3600)


def start_maintenance():
    threading.Thread(target=maintenance_loop, daemon=True, name="maintenance").start()
