"""Calcul des statistiques de latence (fonctions pures, testables)."""
import math
import statistics

ERR_KEYS = {1: "timeout", 2: "unreach", 3: "ttl", 4: "dns", 5: "other"}


def pct(sorted_vals, p):
    if not sorted_vals:
        return None
    k = (len(sorted_vals) - 1) * p / 100.0
    lo, hi = math.floor(k), math.ceil(k)
    v = sorted_vals[lo] if lo == hi else sorted_vals[lo] + (sorted_vals[hi] - sorted_vals[lo]) * (k - lo)
    return round(v, 2)


def fmt_dur(ms):
    s = max(0, int(round(ms / 1000.0)))
    if s < 60:
        return "%d s" % s
    m, s = divmod(s, 60)
    if m < 60:
        return "%d min %02d s" % (m, s) if s else "%d min" % m
    h, m = divmod(m, 60)
    return "%d h %02d min" % (h, m)


def covered(intervals, t0, t1):
    """Duree totale (ms) de l'union des intervalles [debut, fin], limitee a [t0, t1]."""
    iv = sorted((max(a, t0), min(b, t1)) for a, b in intervals if b > t0 and a < t1)
    total, cur_a, cur_b = 0, None, None
    for a, b in iv:
        if cur_b is None or a > cur_b:
            if cur_b is not None:
                total += cur_b - cur_a
            cur_a, cur_b = a, b
        else:
            cur_b = max(cur_b, b)
    if cur_b is not None:
        total += cur_b - cur_a
    return total


def compute(rows, interval_ms, n_out=3):
    """rows : iterable de (ts, rtt, err) tries par ts. rtt None = echec (err None => timeout).

    Un trou de mesures (pause, arret, veille) coupe les series : une perte avant et une
    perte apres ne forment pas une seule coupure, et la gigue ne les relie pas.
    Une coupure = au moins n_out echecs consecutifs (meme regle que les tags « coupure ») ;
    les pertes isolees sont comptees a part (loss_runs) et ne retirent rien a la disponibilite.
    """
    n_out = max(1, n_out)
    brk = max(3 * interval_ms, 10000)
    first_ts = last_ts = None
    n = lost = 0
    vals = []
    errors = {k: 0 for k in ERR_KEYS.values()}
    prev = None
    jsum, jn = 0.0, 0
    acc = {"run": 0, "start": 0, "end": 0, "loss_runs": 0, "outages": 0, "down": 0, "longest": 0, "longest_ms": 0}

    def close():
        r = acc["run"]
        if not r:
            return
        dur = acc["end"] - acc["start"] + interval_ms
        acc["loss_runs"] += 1
        acc["longest"] = max(acc["longest"], r)
        acc["longest_ms"] = max(acc["longest_ms"], dur)
        if r >= n_out:
            acc["outages"] += 1
            acc["down"] += dur
        acc["run"] = 0

    for ts, rtt, err in rows:
        if first_ts is None:
            first_ts = ts
        if last_ts is not None and ts - last_ts > brk:
            close()
            prev = None
        last_ts = ts
        n += 1
        if rtt is None:
            lost += 1
            errors[ERR_KEYS.get(err or 1, "other")] += 1
            if not acc["run"]:
                acc["start"] = ts
            acc["run"] += 1
            acc["end"] = ts
        else:
            close()
            vals.append(rtt)
            if prev is not None:
                jsum += abs(rtt - prev)
                jn += 1
            prev = rtt
    close()
    vals.sort()
    ok = len(vals)
    return {
        "n": n, "lost": lost, "errors": errors,
        "loss_pct": round(100.0 * lost / n, 2) if n else None,
        "min": vals[0] if ok else None,
        "avg": round(sum(vals) / ok, 2) if ok else None,
        "median": pct(vals, 50), "p95": pct(vals, 95), "p99": pct(vals, 99),
        "max": vals[-1] if ok else None,
        "stddev": round(statistics.pstdev(vals), 2) if ok > 1 else (0 if ok else None),
        "jitter": round(jsum / jn, 2) if jn else None,
        "outages": acc["outages"], "loss_runs": acc["loss_runs"], "downtime_ms": acc["down"],
        "longest_outage_packets": acc["longest"], "longest_outage_ms": acc["longest_ms"],
        "first_ts": first_ts, "last_ts": last_ts, "outage_n": n_out,
    }
