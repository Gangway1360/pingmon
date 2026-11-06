"""Tests unitaires : python -m unittest discover -s tests (depuis le dossier pingmon)."""
import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import db as dbm  # noqa: E402
from core import pinger, resolver, rollup, stats  # noqa: E402
from core.config import CFG  # noqa: E402
from core.pinger import DNS, OK, OTHER, TIMEOUT, TTL, UNREACH, parse_output  # noqa: E402

WIN_FR_OK = ("Envoi d'une requête 'Ping'  8.8.8.8 avec 32 octets de données :\r\n"
             "Réponse de 8.8.8.8 : octets=32 temps=12 ms TTL=117\r\n\r\n"
             "Statistiques Ping pour 8.8.8.8:\r\n    Paquets : envoyés = 1, reçus = 1, perdus = 0 (perte 0%),\r\n"
             "Durée approximative des boucles en millisecondes :\r\n    Minimum = 12ms, Maximum = 12ms, Moyenne = 12ms")


class ParseTests(unittest.TestCase):
    def check(self, text, rtt, code, src=None):
        self.assertEqual(parse_output(text), (rtt, code, src))

    def test_windows_fr(self):
        self.check(WIN_FR_OK, 12.0, OK)
        self.check("Réponse de 192.168.1.1 : octets=32 temps<1ms TTL=64", 0.5, OK)
        self.check("Délai d'attente de la demande dépassé.\r\n"
                   "Paquets : envoyés = 1, reçus = 0, perdus = 1 (perte 100%),", None, TIMEOUT)
        self.check("Réponse de 192.168.1.10 : Impossible de joindre l'hôte de destination.\r\n"
                   "Paquets : envoyés = 1, reçus = 1, perdus = 0 (perte 0%),", None, UNREACH, "192.168.1.10")
        self.check("Réponse de 10.1.1.254 : Durée de vie TTL expirée lors du transit.", None, TTL, "10.1.1.254")
        self.check("PING : échec de la transmission. Défaillance générale.", None, OTHER)

    def test_windows_fr_mal_decode(self):
        # sortie cp850 decodee en latin-1 : accents abimes, l'analyse doit tenir
        raw = "Réponse de 10.1.1.254 : Durée de vie TTL expirée lors du transit.".encode("cp850")
        self.assertEqual(parse_output(raw.decode("latin-1"))[1], TTL)
        raw = "Réponse de 8.8.8.8 : octets=32 temps=7 ms TTL=117".encode("cp850")
        self.assertEqual(parse_output(raw.decode("latin-1"))[:2], (7.0, OK))

    def test_windows_en(self):
        self.check("Reply from 8.8.8.8: bytes=32 time=13ms TTL=117", 13.0, OK)
        self.check("Request timed out.", None, TIMEOUT)
        self.check("Reply from 10.0.0.1: Destination host unreachable.", None, UNREACH, "10.0.0.1")
        self.check("Reply from 10.0.0.1: TTL expired in transit.", None, TTL, "10.0.0.1")
        self.check("PING: transmit failed. General failure.", None, OTHER)

    def test_linux(self):
        self.check("PING 8.8.8.8 (8.8.8.8) 56(84) bytes of data.\n64 bytes from 8.8.8.8: icmp_seq=1 ttl=117 time=12.3 ms\n"
                   "rtt min/avg/max/mdev = 12.3/12.3/12.3/0.000 ms", 12.3, OK)
        self.check("From 10.0.0.1 icmp_seq=1 Destination Host Unreachable", None, UNREACH, "10.0.0.1")
        self.check("From 10.0.0.254 icmp_seq=1 Time to live exceeded", None, TTL, "10.0.0.254")
        self.check("1 packets transmitted, 0 received, 100% packet loss, time 0ms", None, TIMEOUT)


class SafetyTests(unittest.TestCase):
    def test_same_ip_spacing(self):
        import threading, time
        stamps = []
        def go():
            pinger._space("192.0.2.50")
            stamps.append(time.monotonic())
        th = [threading.Thread(target=go) for _ in range(3)]
        [x.start() for x in th]
        [x.join() for x in th]
        stamps.sort()
        self.assertGreaterEqual(stamps[1] - stamps[0], 0.95)
        self.assertGreaterEqual(stamps[2] - stamps[1], 0.95)


class OutageStreakTests(unittest.TestCase):
    def test_gap_resets_streak(self):
        from core.monitor import Outage
        o = Outage({"id": 1, "host": "x", "interval_ms": 1000, "outage_n": 0})
        for ts in (0, 1000, 2000):
            o.fail(ts, 1)
        self.assertEqual(o.snapshot()["since"], 0)
        o.fail(3600000, 2)            # 1 h plus tard (PingMon ferme, poste en veille)
        s = o.snapshot()
        self.assertEqual((s["since"], s["fails"], s["order"]), (3600000, 1, [2]))
        o.ok(3601000)
        self.assertIsNone(o.snapshot())

    def test_backoff_spacing_keeps_streak(self):
        from core.monitor import Outage
        o = Outage({"id": 1, "host": "x", "interval_ms": 1000, "outage_n": 0})
        for ts in range(0, 60000, 5000):   # ping ralenti a 5 s : meme serie
            o.fail(ts, 1)
        self.assertEqual(o.snapshot()["since"], 0)


class StatsTests(unittest.TestCase):
    def test_compute(self):
        rows = [(0, 10.0, None), (1000, 20.0, None), (2000, None, 1), (3000, None, 2),
                (4000, 30.0, None), (5000, None, None), (6000, None, 3)]
        s = stats.compute(rows, 1000)
        self.assertEqual((s["n"], s["lost"], s["loss_runs"], s["outages"]), (7, 4, 2, 0))   # 2 series < 3 : pas des coupures
        self.assertEqual(s["errors"], {"timeout": 2, "unreach": 1, "ttl": 1, "dns": 0, "other": 0})
        self.assertEqual((s["min"], s["max"], s["avg"], s["median"]), (10.0, 30.0, 20.0, 20.0))
        self.assertEqual(s["jitter"], 10.0)
        self.assertEqual((s["longest_outage_packets"], s["longest_outage_ms"]), (2, 2000))

    def test_gap_breaks_outage(self):
        # perte, trou de 60 s (pause), perte : deux coupures distinctes, pas de gigue a travers le trou
        rows = [(0, 10.0, None), (1000, None, 1), (61000, None, 1), (62000, 50.0, None)]
        s = stats.compute(rows, 1000)
        self.assertEqual((s["loss_runs"], s["longest_outage_packets"], s["jitter"]), (2, 1, None))

    def test_outage_threshold_and_downtime(self):
        # 2 pertes isolees + une coupure de 5 pertes : 1 coupure (seuil 3), 5 s d'indisponibilite
        rows = [(0, 9.0, None), (1000, None, 1), (2000, None, 1), (3000, 9.0, None)]
        rows += [(4000 + i * 1000, None, 2) for i in range(5)] + [(9000, 9.0, None)]
        s = stats.compute(rows, 1000, 3)
        self.assertEqual((s["outages"], s["loss_runs"], s["downtime_ms"]), (1, 2, 5000))
        s1 = stats.compute(rows, 1000, 1)
        self.assertEqual((s1["outages"], s1["downtime_ms"]), (2, 7000))

    def test_covered(self):
        self.assertEqual(stats.covered([(0, 10), (5, 20), (30, 40)], 0, 100), 30)
        self.assertEqual(stats.covered([(0, 10), (50, 200)], 5, 100), 55)
        self.assertEqual(stats.covered([], 0, 100), 0)

    def test_fmt_dur(self):
        self.assertEqual((stats.fmt_dur(4000), stats.fmt_dur(89000), stats.fmt_dur(3600000)), ("4 s", "1 min 29 s", "1 h 00 min"))

    def test_empty(self):
        s = stats.compute([], 1000)
        self.assertEqual((s["n"], s["avg"], s["loss_pct"]), (0, None, None))


class RollupTests(unittest.TestCase):
    """Les stats sur resumes par minute doivent egaler celles calculees sur le brut."""

    def series(self, seed):
        import random
        rnd = random.Random(seed)
        rows, ts = [], 1_700_000_000_000
        for i in range(4 * 3600):
            ts += 1000
            if 3000 <= i < 3300:                       # pause de 5 min : aucun echantillon
                continue
            if 1000 <= i < 1150 or 5000 <= i < 5003:   # coupures a cheval sur des minutes
                rows.append((ts, None, 1 if i % 2 else 2))
            elif 8000 <= i < 8400:                     # coupure longue, ping ralenti a 5 s
                if i % 5 == 0:
                    rows.append((ts, None, 1))
            elif rnd.random() < 0.01:
                rows.append((ts, None, rnd.choice([1, 2, 3, 5])))
            else:
                rows.append((ts, round(20 + rnd.random() * 10 + (80 if rnd.random() < 0.02 else 0), 1), None))
        return rows

    def test_equivalence(self):
        for seed in (1, 2, 3):
            rows = self.series(seed)
            raw = stats.compute(rows, 1000)
            agg = rollup.combine([m for _, m in rollup.by_minute(rows, 1000)], 1000)
            for k in ("n", "lost", "errors", "min", "max", "outages", "loss_runs", "downtime_ms",
                      "longest_outage_packets", "longest_outage_ms", "first_ts", "last_ts"):
                self.assertEqual(raw[k], agg[k], (seed, k))
            self.assertAlmostEqual(raw["avg"], agg["avg"], places=1)
            self.assertAlmostEqual(raw["stddev"], agg["stddev"], places=1)
            self.assertLess(abs(raw["jitter"] - agg["jitter"]) / raw["jitter"], 0.05)
            for k in ("median", "p95", "p99"):
                self.assertLess(abs(raw[k] - agg[k]) / raw[k], 0.12, (seed, k, raw[k], agg[k]))

    def test_all_fail_minutes(self):
        rows = [(i * 1000, None, 1) for i in range(300)] + [(300000, 5.0, None)]
        agg = rollup.combine([m for _, m in rollup.by_minute(rows, 1000)], 1000)
        self.assertEqual((agg["outages"], agg["longest_outage_packets"], agg["longest_outage_ms"], agg["downtime_ms"]), (1, 300, 300000, 300000))


class ResolverTests(unittest.TestCase):
    def test_is_ip(self):
        self.assertTrue(resolver.is_ip("10.0.0.1"))
        self.assertTrue(resolver.is_ip("fe80::1%12"))
        self.assertFalse(resolver.is_ip("srv.corp.local"))

    def test_resolve_localhost(self):
        self.assertIn("127.0.0.1", resolver.resolve("localhost"))
        self.assertEqual(resolver.resolve("nexiste-pas.invalid"), [])


class MigrationTests(unittest.TestCase):
    def test_v1_to_latest(self):
        with tempfile.TemporaryDirectory() as d:
            CFG.update(db=os.path.join(d, "t.db"), backup_dir=os.path.join(d, "bk"))
            c = sqlite3.connect(CFG["db"])
            c.executescript(dbm.MIGRATIONS[0])
            c.execute("INSERT INTO targets(host,active,created) VALUES('8.8.8.8',0,0)")
            c.executemany("INSERT INTO samples VALUES(1,?,?)", [(1, 5.0), (2, None)])
            c.commit()
            c.close()
            self.assertEqual(dbm.migrate(), "ok")
            c = sqlite3.connect(CFG["db"])
            self.assertEqual(c.execute("PRAGMA user_version").fetchone()[0], dbm.SCHEMA_VERSION)
            self.assertEqual(c.execute("SELECT state FROM targets").fetchone()[0], "paused")
            self.assertEqual(c.execute("SELECT err FROM samples ORDER BY ts").fetchall(), [(None,), (1,)])
            c.close()
            self.assertEqual(len(dbm.list_backups()), 1)   # sauvegarde avant migration
            self.assertEqual(dbm.migrate(), "ok")          # idempotent
            self.assertEqual(len(dbm.list_backups()), 1)

    def test_fresh(self):
        with tempfile.TemporaryDirectory() as d:
            CFG.update(db=os.path.join(d, "n.db"), backup_dir=os.path.join(d, "bk"))
            self.assertEqual(dbm.migrate(), "ok")
            self.assertEqual(dbm.list_backups(), [])


if __name__ == "__main__":
    unittest.main()
