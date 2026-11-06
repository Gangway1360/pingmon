"""Serveur HTTP : fichiers statiques, API JSON, flux SSE."""
import json
import logging
import queue
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

from . import db as dbm
from . import settings, store
from .config import BOOT_ID, CFG, IS_WIN, MIN_INTERVAL_MS, PING_SIZE, STATIC, VERSION
from .hub import HUB
from .monitor import MON, STATS, now_ms
from .store import ApiError

log = logging.getLogger("http")

MIME = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
        ".png": "image/png"}


def info():
    last = dbm.last_backup_time()
    return {"version": VERSION, "boot": BOOT_ID, "schema": dbm.SCHEMA_VERSION, "demo": CFG["demo"],
            "db": CFG["db"], "db_size": dbm.db_size(), "retention_days": CFG["retention_days"], "raw_days": CFG["raw_days"],
            "backups_keep": CFG["backups_keep"], "backup_dir": CFG["backup_dir"],
            "last_backup": int(last * 1000) if last else None, "log_file": CFG["log_file"],
            "started": CFG["started"], "workers": MON.count(), "dropped": STATS["dropped"],
            "now": now_ms(), "backoff": CFG["backoff"], "backoff_after": CFG["backoff_after"], "backoff_s": CFG["backoff_s"],
            "min_interval_ms": MIN_INTERVAL_MS, "ping_size": PING_SIZE}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PingMon/" + VERSION

    def log_message(self, fmt, *args):
        pass

    def send_json(self, obj, status=200):
        body = json.dumps(obj, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 65536:
            raise ApiError(413, "Requête trop grande")
        if not (self.headers.get("Content-Type") or "").startswith("application/json"):
            raise ApiError(415, "JSON attendu")
        try:
            d = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            raise ApiError(400, "JSON invalide")
        if not isinstance(d, dict):
            raise ApiError(400, "Objet JSON attendu")
        return d

    def guard(self):
        """Anti DNS-rebinding (Host) et anti-CSRF (Origin) en ecoute locale."""
        host = self.headers.get("Host", "")
        if CFG["strict_host"] and host not in CFG["allowed_hosts"]:
            raise ApiError(403, "Hôte non autorisé")
        if self.command != "GET":
            origin = self.headers.get("Origin")
            if origin and origin != "http://" + host:
                raise ApiError(403, "Origine non autorisée")

    def route(self, method):
        try:
            self.guard()
            u = urlparse(self.path)
            if u.path.startswith("/api/"):
                self.api(method, u.path, parse_qs(u.query))
            elif method == "GET":
                self.static(u.path)
            else:
                raise ApiError(405, "Méthode non autorisée")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except ApiError as e:
            body = {"error": str(e)}
            body.update(e.extra)
            try:
                self.send_json(body, e.status)
            except OSError:
                pass
        except Exception:
            log.exception("Erreur sur %s %s", method, self.path)
            try:
                self.send_json({"error": "Erreur interne (voir le journal)"}, 500)
            except OSError:
                pass

    def do_GET(self):
        self.route("GET")

    def do_POST(self):
        self.route("POST")

    def do_PATCH(self):
        self.route("PATCH")

    def do_DELETE(self):
        self.route("DELETE")

    def static(self, path):
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        root = STATIC.resolve()
        p = (STATIC / rel).resolve()
        if root not in p.parents or not p.is_file():
            raise ApiError(404, "Introuvable")
        data = p.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(p.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        q = HUB.subscribe()
        try:
            self.wfile.write(b"retry: 2000\n\n" + HUB.encode("hello", {"version": VERSION, "boot": BOOT_ID}))
            while True:
                try:
                    msg = q.get(timeout=15)
                except queue.Empty:
                    msg = b": ping\n\n"
                self.wfile.write(msg)
        except OSError:
            pass
        finally:
            HUB.unsubscribe(q)

    def api(self, method, path, qs):
        parts = path.strip("/").split("/")
        res = parts[1] if len(parts) > 1 else ""
        rid = int(parts[2]) if len(parts) > 2 and parts[2].isdigit() else None

        def qint(key, default=None):
            v = qs.get(key, [None])[0]
            if v is None or v == "":
                return default
            try:
                return int(float(v))
            except ValueError:
                raise ApiError(400, "Paramètre %s invalide" % key)

        if res == "stream" and method == "GET":
            return self.stream()
        if res == "info" and method == "GET":
            return self.send_json(info())
        if res == "settings":
            if method == "GET":
                return self.send_json(settings.get())
            if method == "PATCH":
                try:
                    out = settings.update(self.read_json())
                except settings.SettingsError as e:
                    raise ApiError(400, str(e))
                HUB.publish("settings", {})
                return self.send_json(out)
        if res == "backup" and method == "POST":
            try:
                path = dbm.backup("manuel")
            except Exception as e:
                log.exception("Sauvegarde manuelle echouee")
                raise ApiError(500, "Sauvegarde impossible : %s" % e)
            log.info("Sauvegarde manuelle : %s", path)
            return self.send_json({"path": path})
        if res == "targets":
            if method == "GET" and rid is None:
                return self.send_json(store.list_targets())
            if method == "POST" and len(parts) == 3 and parts[2] == "order":
                return self.send_json(store.reorder(self.read_json()))
            if method == "POST" and len(parts) == 3 and parts[2] == "bulk":
                return self.send_json(store.bulk_create(self.read_json()))
            if method == "POST" and rid is None:
                t = store.create_target(self.read_json())
                return self.send_json(t, 200 if (t["reactivated"] or t.get("updated")) else 201)
            if method == "PATCH" and rid:
                return self.send_json(store.update_target(rid, self.read_json()))
            if method == "DELETE" and rid:
                store.delete_target(rid)
                return self.send_json({"ok": True})
        elif res in ("samples", "stats") and method == "GET":
            tid = qint("target")
            if not tid:
                raise ApiError(400, "Paramètre target requis")
            t1 = qint("to", now_ms())
            t0 = qint("from", t1 - 900000)
            if res == "samples":
                return self.send_json(store.query_samples(tid, t0, t1, min(5000, max(50, qint("max", 800)))))
            return self.send_json(store.compute_stats(tid, t0, t1))
        elif res == "gaps" and method == "GET":
            t1 = qint("to", now_ms())
            return self.send_json(store.list_gaps(qint("target"), qint("from", t1 - 900000), t1))
        elif res == "tags":
            if method == "GET" and rid is None:
                return self.send_json(store.list_tags(qint("target"), qint("from", 0), qint("to", now_ms())))
            if method == "POST" and rid is None:
                return self.send_json(store.create_tag(self.read_json()), 201)
            if method == "PATCH" and rid:
                return self.send_json(store.update_tag(rid, self.read_json()))
            if method == "DELETE" and rid:
                store.delete_tag(rid)
                return self.send_json({"ok": True})
        raise ApiError(404, "Route inconnue")


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Sous Windows, SO_REUSEADDR autorise deux ecouteurs sur le meme port : on l'evite.
    allow_reuse_address = not IS_WIN

    def handle_error(self, request, client_address):
        if isinstance(sys.exc_info()[1], OSError):   # client deconnecte
            return
        log.exception("Erreur de traitement HTTP")
