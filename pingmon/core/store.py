"""Operations metier : cibles, mesures, tags."""
import logging
import re

from . import resolver, rollup, stats
from .config import CFG, MAX_TARGETS, MIN_INTERVAL_MS
from .db import db
from .hub import HUB
from .monitor import MON, now_ms

log = logging.getLogger("store")

HOST_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:%\-]{0,252}$")
STATES = ("active", "paused", "stopped")
N_COLORS = 7   # couleurs de cible (la 8e, rouge, est reservee aux echecs)
TS_MAX = 4102444800000  # 2100-01-01


class ApiError(Exception):
    def __init__(self, status, msg, **extra):
        super().__init__(msg)
        self.status = status
        self.extra = extra


def clean_int(v, lo, hi, name, default=None):
    if v is None or v == "":
        if default is None:
            raise ApiError(400, "%s manquant" % name)
        return default
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        raise ApiError(400, "%s invalide" % name)
    if n < lo or n > hi:
        raise ApiError(400, "%s hors limites (%d à %d)" % (name, lo, hi))
    return n


# -------------------------------------------------------------- cibles
def row_target(r):
    return {"id": r["id"], "host": r["host"], "label": r["label"],
            "interval_ms": r["interval_ms"], "timeout_ms": r["timeout_ms"],
            "state": r["state"], "active": r["state"] == "active", "color": r["color"],
            "ip": r["ip"], "ip_checked": r["ip_checked"], "is_ip": resolver.is_ip(r["host"]),
            "stopped_at": r["stopped_at"], "site": r["site"], "outage_n": r["outage_n"], "position": r["position"]}


def get_target(c, tid):
    r = c.execute("SELECT * FROM targets WHERE id=?", (tid,)).fetchone()
    if not r:
        raise ApiError(404, "Cible introuvable")
    return r


def _live_count(c, exclude=None):
    return c.execute("SELECT COUNT(*) FROM targets WHERE state!='stopped' AND id!=?",
                     (exclude or 0,)).fetchone()[0]


def _apply_state(t, restart=True):
    if t["state"] != "active":
        MON.stop(t["id"])
    elif restart:
        MON.start(t)
    HUB.publish("targets", {})


GAP_REASON = {"paused": "pause", "stopped": "stop"}


def _transition(c, tid, old, new, ts):
    """Journalise les periodes de pause / arret (table gaps) lors d'un changement d'etat."""
    if old == new:
        return
    c.execute("UPDATE gaps SET end=? WHERE target_id=? AND end IS NULL AND reason IN ('pause','stop')", (ts, tid))
    if new in GAP_REASON:
        c.execute("INSERT INTO gaps(target_id,start,end,reason) VALUES(?,?,NULL,?)", (tid, ts, GAP_REASON[new]))


def clean_site(v):
    return " ".join(str(v or "").split())[:40]


def list_targets():
    with db() as c:
        out = []
        for r in c.execute("SELECT * FROM targets ORDER BY position, id").fetchall():
            t = row_target(r)
            rec = c.execute("SELECT ts,rtt,err FROM samples WHERE target_id=? ORDER BY ts DESC LIMIT 60",
                            (r["id"],)).fetchall()
            t["recent"] = [[x[0], x[1], x[2]] for x in reversed(rec)]
            t["fail"] = MON.streak(r["id"]) if r["state"] == "active" else None
            out.append(t)
        return out


def reorder(d):
    """Nouvel ordre d'affichage (liste d'id) et, optionnellement, nouveaux sites {id: site}."""
    ids, sites = d.get("ids"), d.get("sites") or {}
    if not isinstance(ids, list) or not isinstance(sites, dict):
        raise ApiError(400, "Ordre invalide")
    try:
        ids = [int(i) for i in ids]
        sites = {int(k): clean_site(v) for k, v in sites.items()}
    except (TypeError, ValueError):
        raise ApiError(400, "Ordre invalide")
    with db() as c:
        all_ids = [r[0] for r in c.execute("SELECT id FROM targets ORDER BY position, id")]
        known = set(all_ids)
        seen, order = set(), []
        for i in ids + all_ids:
            if i in known and i not in seen:
                seen.add(i)
                order.append(i)
        c.executemany("UPDATE targets SET position=? WHERE id=?", [(p, i) for p, i in enumerate(order)])
        for i, s in sites.items():
            if i in known:
                c.execute("UPDATE targets SET site=? WHERE id=?", (s, i))
                log.info("Cible #%d deplacee vers le site %r", i, s)
    HUB.publish("targets", {})
    return {"ok": True}


def active_targets():
    with db() as c:
        return [row_target(r) for r in c.execute("SELECT * FROM targets WHERE state='active'")]


def create_target(d):
    host = str(d.get("host", "")).strip()
    if not HOST_RE.match(host):
        raise ApiError(400, "Adresse ou nom d'hôte invalide")
    label = str(d.get("label", "")).strip()[:60]
    interval = clean_int(d.get("interval_ms"), MIN_INTERVAL_MS, 3600000, "Intervalle", CFG["def_interval_ms"])
    timeout = clean_int(d.get("timeout_ms"), 200, 10000, "Timeout", CFG["def_timeout_ms"])
    site = clean_site(d.get("site"))
    reactivated = False
    with db() as c:
        ex = c.execute("SELECT * FROM targets WHERE lower(host)=lower(?)", (host,)).fetchone()
        if ex and ex["state"] == "active":
            # deja surveillee : on applique simplement le nom et le site saisis
            upd = {}
            if label and label != ex["label"]:
                upd["label"] = label
            if site and site != ex["site"]:
                upd["site"] = site
            if not upd:
                raise ApiError(409, "%s est déjà surveillée" % host, id=ex["id"])
            c.execute("UPDATE targets SET label=?, site=? WHERE id=?",
                      (upd.get("label", ex["label"]), upd.get("site", ex["site"]), ex["id"]))
            t = row_target(get_target(c, ex["id"]))
            t.update(recent=[], reactivated=False, updated=sorted(upd))
            HUB.publish("targets", {})
            return t
        if (not ex or ex["state"] == "stopped") and _live_count(c, ex["id"] if ex else None) >= MAX_TARGETS:
            raise ApiError(400, "Limite de %d cibles actives ou en pause atteinte" % MAX_TARGETS)
        if ex:
            c.execute("UPDATE targets SET state='active', active=1, stopped_at=NULL, "
                      "label=CASE WHEN ?='' THEN label ELSE ? END, site=CASE WHEN ?='' THEN site ELSE ? END "
                      "WHERE id=?", (label, label, site, site, ex["id"]))
            _transition(c, ex["id"], ex["state"], "active", now_ms())
            tid, reactivated = ex["id"], True
        else:
            # couleur la moins utilisee (a egalite : la premiere), pour limiter les doublons
            use = [0] * N_COLORS
            for (col,) in c.execute("SELECT color FROM targets WHERE state!='stopped'"):
                use[col % N_COLORS] += 1
            color = use.index(min(use))
            pos = c.execute("SELECT COALESCE(MAX(position),0)+1 FROM targets").fetchone()[0]
            cur = c.execute("INSERT INTO targets(host,label,interval_ms,timeout_ms,active,state,color,created,site,position,outage_n) "
                            "VALUES(?,?,?,?,1,'active',?,?,?,?,?)",
                            (host, label, interval, timeout, color, now_ms(), site, pos, CFG["def_outage_n"]))
            tid = cur.lastrowid
        t = row_target(get_target(c, tid))
    _apply_state(t)
    t["recent"] = []
    t["reactivated"] = reactivated
    return t


def update_target(tid, d):
    with db() as c:
        r = get_target(c, tid)
        label = str(d["label"]).strip()[:60] if "label" in d else r["label"]
        interval = clean_int(d.get("interval_ms"), MIN_INTERVAL_MS, 3600000, "Intervalle", r["interval_ms"])
        timeout = clean_int(d.get("timeout_ms"), 200, 10000, "Timeout", r["timeout_ms"])
        site = clean_site(d["site"]) if "site" in d else r["site"]
        outage_n = clean_int(d.get("outage_n"), 0, 1000, "Seuil de coupure", r["outage_n"])
        color = clean_int(d.get("color"), 0, N_COLORS - 1, "Couleur", r["color"] % N_COLORS)
        state = d.get("state", r["state"])
        if state not in STATES:
            raise ApiError(400, "État invalide")
        if r["state"] == "stopped" and state != "stopped" and _live_count(c, tid) >= MAX_TARGETS:
            raise ApiError(400, "Limite de %d cibles actives ou en pause atteinte" % MAX_TARGETS)
        if state != "stopped":
            stopped_at = None
        elif r["state"] != "stopped":
            stopped_at = now_ms()
        else:
            stopped_at = r["stopped_at"]
        c.execute("UPDATE targets SET label=?,interval_ms=?,timeout_ms=?,state=?,active=?,stopped_at=?,site=?,"
                  "outage_n=?,color=? WHERE id=?",
                  (label, interval, timeout, state, int(state == "active"), stopped_at, site, outage_n, color, tid))
        _transition(c, tid, r["state"], state, now_ms())
        t = row_target(get_target(c, tid))
    changes = ["%s %r -> %r" % (k, r[k], t[k]) for k in ("label", "site", "state", "interval_ms", "timeout_ms", "outage_n", "color")
               if r[k] != t[k]]
    if changes:
        log.info("Cible #%d (%s) : %s", tid, r["host"], ", ".join(changes))
    # renommer ou changer de site ne relance pas le ping (une coupure en cours continue)
    restart = (r["state"] != state or r["interval_ms"] != interval or r["timeout_ms"] != timeout
               or r["outage_n"] != outage_n)
    _apply_state(t, restart)
    return t


def bulk_create(d):
    """Ajout en lot : items = [{host, label, site}] ; erreurs par ligne, sans tout annuler."""
    items = d.get("items")
    if not isinstance(items, list) or not items:
        raise ApiError(400, "Liste vide")
    if len(items) > MAX_TARGETS:
        raise ApiError(400, "%d lignes au maximum" % MAX_TARGETS)
    out = {"created": [], "reactivated": [], "errors": []}
    for it in items:
        if not isinstance(it, dict):
            continue
        body = {"host": it.get("host"), "label": it.get("label", ""), "site": it.get("site") or d.get("site", ""),
                "interval_ms": d.get("interval_ms"), "timeout_ms": d.get("timeout_ms")}
        try:
            t = create_target(body)
            out["reactivated" if t["reactivated"] else "created"].append(t["host"])
        except ApiError as e:
            out["errors"].append({"host": str(it.get("host", ""))[:80], "error": str(e)})
    return out


def delete_target(tid):
    MON.stop(tid)
    with db() as c:
        get_target(c, tid)
        c.execute("DELETE FROM samples WHERE target_id=?", (tid,))
        c.execute("DELETE FROM minutes WHERE target_id=?", (tid,))
        c.execute("DELETE FROM tags WHERE target_id=?", (tid,))
        c.execute("DELETE FROM gaps WHERE target_id=?", (tid,))
        c.execute("DELETE FROM targets WHERE id=?", (tid,))
    HUB.publish("targets", {})


# ------------------------------------------------------------- mesures
NICE = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 900000,
        1800000, 3600000, 7200000, 10800000, 21600000, 43200000, 86400000]


RAW_STATS_SPAN = 6 * 3600000   # au-dela, stats calculees sur les resumes par minute


def _raw_limit():
    return now_ms() - CFG["raw_days"] * 86400000


def query_samples(tid, t0, t1, maxpts):
    """Brut : [ts, rtt, err, src]. Agrege : [ts, moy, min, max, pertes, n, [timeout,injoignable,ttl,dns,autre]].

    Fenetre courte et recente : mesures brutes. Sinon : cases de temps, calculees sur le brut
    tant qu'elles font moins d'une minute, sur les resumes par minute au-dela (rapide sur 7 jours).
    """
    with db() as c:
        iv = max(get_target(c, tid)["interval_ms"], MIN_INTERVAL_MS)
        span = max(1, t1 - t0)
        raw_ok = t0 >= _raw_limit()
        if raw_ok and span / iv <= maxpts:
            rows = c.execute("SELECT ts,rtt,err,src FROM samples WHERE target_id=? AND ts BETWEEN ? AND ? "
                             "ORDER BY ts LIMIT ?", (tid, t0, t1, int(maxpts * 1.5) + 1)).fetchall()
            if len(rows) <= maxpts * 1.5:
                return {"bucket": 0, "rows": [[r[0], r[1], r[2], r[3]] for r in rows]}
        b = next((x for x in NICE if span / x <= maxpts), NICE[-1])
        if raw_ok and b < rollup.MIN:
            rows = c.execute(
                "SELECT (ts/:b)*:b AS bt, AVG(rtt), MIN(rtt), MAX(rtt), SUM(rtt IS NULL), COUNT(*), "
                " SUM(CASE WHEN rtt IS NULL AND COALESCE(err,1)=1 THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN err=2 THEN 1 ELSE 0 END), SUM(CASE WHEN err=3 THEN 1 ELSE 0 END),"
                " SUM(CASE WHEN err=4 THEN 1 ELSE 0 END), SUM(CASE WHEN err=5 THEN 1 ELSE 0 END) "
                "FROM samples WHERE target_id=:t AND ts BETWEEN :f AND :to GROUP BY ts/:b ORDER BY bt",
                {"b": b, "t": tid, "f": t0, "to": t1}).fetchall()
            return {"bucket": b, "rows": [[r[0], None if r[1] is None else round(r[1], 2), r[2], r[3], r[4] or 0, r[5],
                                           [r[6], r[7], r[8], r[9], r[10]]] for r in rows]}
        b = max(b, rollup.MIN)
        acc = {}

        def add(bt, sm, ok, mn, mx, n, errs):
            a = acc.get(bt)
            if a is None:
                acc[bt] = [sm, ok, mn, mx, n, list(errs)]
                return
            a[0] += sm
            a[1] += ok
            if mn is not None:
                a[2] = mn if a[2] is None else min(a[2], mn)
                a[3] = mx if a[3] is None else max(a[3], mx)
            a[4] += n
            for i in range(5):
                a[5][i] += errs[i]
        for r in c.execute("SELECT (ts/:b)*:b, SUM(sum), SUM(ok), MIN(min), MAX(max), SUM(n), "
                           "SUM(e1), SUM(e2), SUM(e3), SUM(e4), SUM(e5) FROM minutes "
                           "WHERE target_id=:t AND ts BETWEEN :f AND :to GROUP BY ts/:b",
                           {"b": b, "t": tid, "f": t0 // rollup.MIN * rollup.MIN, "to": t1}):
            add(r[0], r[1], r[2], r[3], r[4], r[5], r[6:11])
        for m in rollup.tail_minutes(c, tid, iv, t0, t1 + 1):
            add(m["ts"] // b * b, m["sum"], m["ok"], m["min"], m["max"], m["n"],
                [m["e1"], m["e2"], m["e3"], m["e4"], m["e5"]])
        out = [[bt, round(a[0] / a[1], 2) if a[1] else None, a[2], a[3], a[4] - a[1], a[4], a[5]]
               for bt, a in sorted(acc.items())]
        return {"bucket": b, "rows": out}


def compute_stats(tid, t0, t1):
    with db() as c:
        tgt = get_target(c, tid)
        iv = max(tgt["interval_ms"], MIN_INTERVAL_MS)
        n_out = rollup.outage_rule(tgt["outage_n"])
        if t1 - t0 <= RAW_STATS_SPAN and t0 >= _raw_limit():
            cur = c.execute("SELECT ts,rtt,err FROM samples WHERE target_id=? AND ts BETWEEN ? AND ? ORDER BY ts",
                            (tid, t0, t1))
            s = stats.compute(cur, iv, n_out)
            s["approx"] = False
        else:
            mins = rollup.load_minutes(c, tid, t0, t1) + rollup.tail_minutes(c, tid, iv, t0, t1 + 1, n_out)
            s = rollup.combine(mins, iv, n_out)
    gaps = [(g["start"], g["end"] or now_ms()) for g in list_gaps(tid, t0, t1)]
    end = min(t1, now_ms())
    s["unmonitored_ms"] = stats.covered(gaps, t0, end)
    # Disponibilite = 1 - indisponibilite / temps reellement surveille.
    # Temps surveille : du premier ping de la fenetre a sa fin (ou au dernier ping d'une cible
    # arretee / en pause), moins les periodes non surveillees (pause, arret, veille, PingMon ferme).
    s["monitored_ms"] = 0
    s["availability"] = None
    if s["first_ts"] is not None:
        start = max(t0, s["first_ts"])
        stop = end if tgt["state"] == "active" else min(end, s["last_ts"] + iv)
        mon = max(0, stop - start - stats.covered(gaps, start, stop))
        s["monitored_ms"] = mon
        s["downtime_ms"] = min(s["downtime_ms"], mon)   # coupure en cours : on ne compte pas au-dela de maintenant
        if mon > 0:
            s["availability"] = round(max(0.0, min(100.0, 100.0 * (1 - s["downtime_ms"] / mon))), 3)
    return s


def list_gaps(tid, t0, t1):
    """Periodes non surveillees : pause / arret (par cible), serveur arrete / poste en veille (globales)."""
    with db() as c:
        rows = c.execute("SELECT * FROM gaps WHERE (target_id IS NULL OR target_id=?) AND start<=? "
                         "AND COALESCE(end, ?)>=? ORDER BY start", (tid or 0, t1, now_ms(), t0)).fetchall()
        return [{"id": r["id"], "target_id": r["target_id"], "start": r["start"], "end": r["end"],
                 "reason": r["reason"]} for r in rows]


# ---------------------------------------------------------------- tags
def row_tag(r):
    return {"id": r["id"], "target_id": r["target_id"], "ts": r["ts"], "ts_end": r["ts_end"],
            "label": r["label"], "color": r["color"], "note": r["note"], "auto": bool(r["auto"]),
            "kind": r["kind"]}


def _clean_tag(d, c):
    ts = clean_int(d.get("ts"), 0, TS_MAX, "Horodatage")
    ts_end = d.get("ts_end")
    ts_end = None if ts_end in (None, "") else clean_int(ts_end, 0, TS_MAX, "Fin")
    if ts_end is not None and ts_end < ts:
        ts, ts_end = ts_end, ts
    label = str(d.get("label", "")).strip()[:80]
    if not label:
        raise ApiError(400, "Libellé requis")
    color = clean_int(d.get("color"), 0, 7, "Couleur", 1)
    note = str(d.get("note", ""))[:500]
    tid = d.get("target_id")
    if tid in (None, "", "all"):
        tid = None
    else:
        tid = clean_int(tid, 1, 10 ** 9, "Cible")
        get_target(c, tid)
    return ts, ts_end, label, color, note, tid


def list_tags(tid, t0, t1):
    with db() as c:
        if tid:
            rows = c.execute("SELECT * FROM tags WHERE (target_id IS NULL OR target_id=?) AND ts<=? "
                             "AND COALESCE(ts_end,ts)>=? ORDER BY ts", (tid, t1, t0)).fetchall()
        else:
            rows = c.execute("SELECT * FROM tags WHERE ts<=? AND COALESCE(ts_end,ts)>=? ORDER BY ts",
                             (t1, t0)).fetchall()
        return [row_tag(r) for r in rows]


def create_tag(d):
    with db() as c:
        ts, te, label, color, note, tid = _clean_tag(d, c)
        cur = c.execute("INSERT INTO tags(target_id,ts,ts_end,label,color,note,created,auto) "
                        "VALUES(?,?,?,?,?,?,?,0)", (tid, ts, te, label, color, note, now_ms()))
        out = row_tag(c.execute("SELECT * FROM tags WHERE id=?", (cur.lastrowid,)).fetchone())
    HUB.publish("tags", {})
    return out


def update_tag(rid, d):
    with db() as c:
        if not c.execute("SELECT 1 FROM tags WHERE id=?", (rid,)).fetchone():
            raise ApiError(404, "Tag introuvable")
        ts, te, label, color, note, tid = _clean_tag(d, c)
        c.execute("UPDATE tags SET target_id=?,ts=?,ts_end=?,label=?,color=?,note=? WHERE id=?",
                  (tid, ts, te, label, color, note, rid))
        out = row_tag(c.execute("SELECT * FROM tags WHERE id=?", (rid,)).fetchone())
    HUB.publish("tags", {})
    return out


def delete_tag(rid):
    with db() as c:
        c.execute("DELETE FROM tags WHERE id=?", (rid,))
    HUB.publish("tags", {})
