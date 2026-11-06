"""Agregats par minute : calcul (fonctions pures), cumul pour les stats, tache periodique.

Les mesures brutes (1 ligne par ping) ne sont gardees que quelques jours. Chaque minute
complete est resumee dans la table `minutes` : comptes, somme, min/max, types d'echec,
gigue, histogramme de latence (pour les percentiles) et ce qu'il faut pour recoller les
coupures d'une minute a l'autre. Les longues fenetres (graph et stats) lisent ces resumes.
"""
import logging
import math
import sqlite3
import threading
import time

from .config import CFG
from .db import connect, db

log = logging.getLogger("rollup")

MIN = 60000
LAG_MS = 2 * MIN          # une minute n'est resumee qu'une fois close depuis 2 min
CHUNK_MS = 6 * 3600000    # rattrapage par tranches de 6 h
H_BASE, H_RATIO, H_MAX = 0.1, 1.2, 79   # histogramme log : ~10 % de precision, 0,1 ms a ~180 s
_LR = math.log(H_RATIO)
COLS = ("ts", "n", "ok", "sum", "sumsq", "min", "max", "e1", "e2", "e3", "e4", "e5", "jsum", "jn",
        "first_ts", "last_ts", "lead", "lead_end", "trail", "trail_start", "inner_runs", "inner_max_ms", "hist",
        "inner_out", "inner_down_ms")


def outage_rule(n):
    """Nombre d'echecs consecutifs qui font une coupure (detection desactivee : regle par defaut, 3)."""
    return n if n and n > 0 else 3


def brk_ms(interval_ms):
    """Ecart au-dela duquel deux mesures ne sont plus consecutives (pause, veille...)."""
    return max(3 * interval_ms, 10000)


def hbin(v):
    if v < H_BASE:
        return 0
    return min(H_MAX, int(math.log(v / H_BASE) / _LR) + 1)


def hval(k):
    """Valeur representative d'une case (milieu geometrique)."""
    if k == 0:
        return H_BASE / 2
    return H_BASE * H_RATIO ** (k - 0.5)


def enc_hist(h):
    return ",".join("%d:%d" % (k, h[k]) for k in sorted(h))


def dec_hist(s, into):
    if s:
        for part in s.split(","):
            k, c = part.split(":")
            into[int(k)] = into.get(int(k), 0) + int(c)


def summarize(rows, interval_ms, n_out=3):
    """Resume d'une minute. rows : [(ts, rtt, err)] tries, non vides."""
    brk = brk_ms(interval_ms)
    n = len(rows)
    ok = 0
    s = sq = 0.0
    mn = mx = None
    errs = [0, 0, 0, 0, 0]
    jsum, jn = 0.0, 0
    hist = {}
    prev_rtt = prev_ts = None
    runs = []          # [debut_idx, fin_idx] des suites d'echecs
    for i, (ts, rtt, err) in enumerate(rows):
        cut = prev_ts is not None and ts - prev_ts > brk
        if cut:
            prev_rtt = None
        if rtt is None:
            e = err if err in (1, 2, 3, 4, 5) else 1
            errs[e - 1] += 1
            if runs and runs[-1][1] == i - 1 and not cut:
                runs[-1][1] = i
            else:
                runs.append([i, i])
        else:
            ok += 1
            s += rtt
            sq += rtt * rtt
            mn = rtt if mn is None or rtt < mn else mn
            mx = rtt if mx is None or rtt > mx else mx
            k = hbin(rtt)
            hist[k] = hist.get(k, 0) + 1
            if prev_rtt is not None:
                jsum += abs(rtt - prev_rtt)
                jn += 1
            prev_rtt = rtt
        prev_ts = ts
    lead = lead_end = trail = trail_start = None
    inner_runs, inner_max, inner_out, inner_down = 0, 0, 0, 0
    first_ts, last_ts = rows[0][0], rows[-1][0]
    lead = trail = 0
    for a, b in runs:
        touches_start, touches_end = a == 0, b == n - 1
        if touches_start:
            lead, lead_end = b - a + 1, rows[b][0]
        if touches_end and not (touches_start and lead == n):
            trail, trail_start = b - a + 1, rows[a][0]
        if not touches_start and not touches_end:
            dur = rows[b][0] - rows[a][0] + interval_ms
            inner_runs += 1
            inner_max = max(inner_max, dur)
            if b - a + 1 >= max(1, n_out):
                inner_out += 1
                inner_down += dur
    if lead == n:          # minute entierement en echec
        trail, trail_start = n, first_ts
    return {"n": n, "ok": ok, "sum": s, "sumsq": sq, "min": mn, "max": mx,
            "e1": errs[0], "e2": errs[1], "e3": errs[2], "e4": errs[3], "e5": errs[4],
            "jsum": jsum, "jn": jn, "first_ts": first_ts, "last_ts": last_ts,
            "lead": lead, "lead_end": lead_end, "trail": trail, "trail_start": trail_start,
            "inner_runs": inner_runs, "inner_max_ms": inner_max, "hist": enc_hist(hist),
            "inner_out": inner_out, "inner_down_ms": inner_down}


def by_minute(rows, interval_ms, n_out=3):
    """[(ts, rtt, err)] tries -> [(minute_ts, resume)]."""
    out, cur, key = [], [], None
    for r in rows:
        m = r[0] // MIN * MIN
        if m != key and cur:
            out.append((key, summarize(cur, interval_ms, n_out)))
            cur = []
        key = m
        cur.append(r)
    if cur:
        out.append((key, summarize(cur, interval_ms, n_out)))
    return out


def combine(minutes, interval_ms, n_out=3):
    """Stats d'une fenetre a partir de resumes de minutes tries (dicts). Memes cles que stats.compute."""
    from .stats import ERR_KEYS
    brk = brk_ms(interval_ms)
    n = ok = 0
    s = sq = 0.0
    mn = mx = None
    errs = [0, 0, 0, 0, 0]
    jsum, jn = 0.0, 0
    hist = {}
    n_out = max(1, n_out)
    outages, loss_runs, down, longest_ms, longest_pk = 0, 0, 0, 0, 0
    run = None          # [debut_ts, fin_ts, paquets]
    prev_last = None
    first_ts = minutes[0]["first_ts"] if minutes else None

    def close():
        nonlocal outages, loss_runs, down, longest_ms, longest_pk, run
        dur = run[1] - run[0] + interval_ms
        loss_runs += 1
        longest_ms = max(longest_ms, dur)
        longest_pk = max(longest_pk, run[2])
        if run[2] >= n_out:
            outages += 1
            down += dur
        run = None

    for m in minutes:
        if run and prev_last is not None and m["first_ts"] - prev_last > brk:
            close()
        n += m["n"]
        ok += m["ok"]
        s += m["sum"]
        sq += m["sumsq"]
        if m["min"] is not None:
            mn = m["min"] if mn is None else min(mn, m["min"])
            mx = m["max"] if mx is None else max(mx, m["max"])
        for i in range(5):
            errs[i] += m["e%d" % (i + 1)]
        jsum += m["jsum"]
        jn += m["jn"]
        dec_hist(m["hist"], hist)
        if m["lead"] == m["n"]:                       # toute la minute en echec
            if run:
                run[1] = m["last_ts"]
                run[2] += m["n"]
            else:
                run = [m["first_ts"], m["last_ts"], m["n"]]
        else:
            if m["lead"]:
                if run:
                    run[1] = m["lead_end"]
                    run[2] += m["lead"]
                else:
                    run = [m["first_ts"], m["lead_end"], m["lead"]]
            if run:
                close()
            loss_runs += m["inner_runs"]
            outages += m.get("inner_out", 0)
            down += m.get("inner_down_ms", 0)
            longest_ms = max(longest_ms, m["inner_max_ms"])
            if m["trail"]:
                run = [m["trail_start"], m["last_ts"], m["trail"]]
        prev_last = m["last_ts"]
    if run:
        close()
    lost = n - ok

    def q(p):
        if not ok:
            return None
        target, acc = p / 100.0 * (ok - 1), 0
        for k in sorted(hist):
            acc += hist[k]
            if acc > target:
                return round(min(mx, max(mn, hval(k))), 2)
        return mx

    mean = s / ok if ok else None
    var = max(0.0, sq / ok - mean * mean) if ok else None
    return {
        "n": n, "lost": lost, "errors": {ERR_KEYS[i + 1]: errs[i] for i in range(5)},
        "loss_pct": round(100.0 * lost / n, 2) if n else None,
        "min": mn, "avg": round(mean, 2) if ok else None,
        "median": q(50), "p95": q(95), "p99": q(99), "max": mx,
        "stddev": round(math.sqrt(var), 2) if ok > 1 else (0 if ok else None),
        "jitter": round(jsum / jn, 2) if jn else None,
        "outages": outages, "loss_runs": loss_runs, "downtime_ms": down,
        "longest_outage_packets": longest_pk, "longest_outage_ms": longest_ms,
        "first_ts": first_ts, "last_ts": prev_last, "outage_n": n_out, "approx": True,
    }


# --------------------------------------------------------------- base
def _row(r):
    return dict(zip(COLS, r))


def load_minutes(c, tid, t0, t1):
    rows = c.execute("SELECT %s FROM minutes WHERE target_id=? AND ts>=? AND ts<? ORDER BY ts" % ",".join(COLS),
                     (tid, t0 // MIN * MIN, t1)).fetchall()
    return [_row(r) for r in rows]


def last_rolled(c, tid):
    r = c.execute("SELECT MAX(ts) FROM minutes WHERE target_id=?", (tid,)).fetchone()[0]
    return r


def tail_minutes(c, tid, interval_ms, t0, t1, n_out=3):
    """Minutes pas encore resumees (les toutes dernieres), calculees a la volee depuis le brut."""
    last = last_rolled(c, tid)
    start = max((last + MIN) if last is not None else 0, t0 // MIN * MIN)
    if start >= t1:
        return []
    rows = c.execute("SELECT ts,rtt,err FROM samples WHERE target_id=? AND ts>=? AND ts<? ORDER BY ts",
                     (tid, start, t1)).fetchall()
    return [dict(m, ts=k) for k, m in by_minute(rows, interval_ms, n_out)]


def roll_target(c, tid, interval_ms, upto, n_out=3):
    """Resume les minutes closes de la cible jusqu'a `upto` (exclu). Retourne le nombre de minutes."""
    last = last_rolled(c, tid)
    if last is not None:
        start = last + MIN
    else:
        first = c.execute("SELECT MIN(ts) FROM samples WHERE target_id=?", (tid,)).fetchone()[0]
        if first is None:
            return 0
        start = first // MIN * MIN
    done = 0
    while start < upto:
        end = min(upto, start + CHUNK_MS)
        rows = c.execute("SELECT ts,rtt,err FROM samples WHERE target_id=? AND ts>=? AND ts<? ORDER BY ts",
                         (tid, start, end)).fetchall()
        mins = by_minute(rows, interval_ms, n_out)
        if mins:
            c.executemany("INSERT OR REPLACE INTO minutes(target_id,%s) VALUES(?,%s)" % (",".join(COLS), ",".join("?" * len(COLS))),
                          [(tid, k) + tuple(m[col] for col in COLS[1:]) for k, m in mins])
            c.commit()
            done += len(mins)
        start = end
    return done


def roll_all():
    upto = (int(time.time() * 1000) - LAG_MS) // MIN * MIN
    c = connect()
    try:
        total = 0
        for tid, iv, n_out in c.execute("SELECT id, interval_ms, outage_n FROM targets").fetchall():
            total += roll_target(c, tid, iv, upto, outage_rule(n_out))
        return total
    finally:
        c.close()


def rollup_loop():
    first = True
    while True:
        try:
            t0 = time.time()
            n = roll_all()
            if n and (first or n > 100):
                log.info("Agregats : %d minutes resumees en %.1f s", n, time.time() - t0)
        except sqlite3.Error as e:
            log.warning("Agregation impossible : %s", e)
        except Exception:
            log.exception("Agregation : erreur inattendue")
        first = False
        time.sleep(30)


def start():
    threading.Thread(target=rollup_loop, daemon=True, name="rollup").start()


def purge(c, now):
    """Brut au-dela de raw_days (jamais avant d'avoir ete resume), resumes au-dela de retention_days."""
    raw_limit = now - CFG["raw_days"] * 86400000
    n_raw = 0
    for (tid,) in c.execute("SELECT DISTINCT target_id FROM minutes").fetchall():
        last = last_rolled(c, tid)
        n_raw += c.execute("DELETE FROM samples WHERE target_id=? AND ts<?", (tid, min(raw_limit, last + MIN))).rowcount
    n_min = c.execute("DELETE FROM minutes WHERE ts<?", (now - CFG["retention_days"] * 86400000,)).rowcount
    return n_raw, n_min
