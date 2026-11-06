"""Envoi d'un echo ICMP via le ping du systeme et analyse du resultat."""
import logging
import math
import os
import random
import re
import subprocess
import sys
import threading
import time

from .config import CFG, IS_WIN, MIN_GAP_PER_IP_S, PING_SIZE

log = logging.getLogger("ping")

# Codes d'echec (colonne samples.err ; NULL = reponse OK)
OK, TIMEOUT, UNREACH, TTL, DNS, OTHER = 0, 1, 2, 3, 4, 5
LABELS = {TIMEOUT: "Timeout", UNREACH: "Hôte injoignable", TTL: "TTL expiré", DNS: "DNS introuvable", OTHER: "Défaillance"}

RTT_RE = re.compile(r"[=<]\s*([0-9]+(?:[.,][0-9]+)?)\s*ms", re.I)
# "Reponse de 10.0.0.1 :", "Reply from 10.0.0.1:", "From 10.0.0.1 icmp_seq=1" (accents eventuellement abimes)
SRC_RE = re.compile(r"(?:r\S{0,3}ponse de|reply from|antwort von|from)\s+([0-9A-Fa-f][0-9A-Fa-f.:]*[0-9A-Fa-f])", re.I)

# Motifs en minuscules, sans dependre des accents (sortie OEM parfois mal decodee)
_TTL = ("time to live exceeded", "ttl expir", "ttl abgelaufen", "ttl caduc")
_UNREACH = ("unreachable", "impossible de joindre", "nicht erreichbar", "inaccesible", "inaccessible")
_OTHER = ("faillance g", "general failure", "transmit failed", "chec de la transmission", "allgemeiner fehler")

if IS_WIN:
    _p = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "PING.EXE")
    PING_EXE = _p if os.path.isfile(_p) else "ping"
else:
    PING_EXE = "ping"

_oserror_logged = False
_last_sent = {}
_sent_lock = threading.Lock()


def _space(ip):
    """Garantit au plus un ping par MIN_GAP_PER_IP_S vers une meme IP, quelles que soient les cibles."""
    while True:
        with _sent_lock:
            now = time.monotonic()
            wait = _last_sent.get(ip, -1e9) + MIN_GAP_PER_IP_S - now
            if wait <= 0:
                _last_sent[ip] = now
                return
        time.sleep(min(wait, MIN_GAP_PER_IP_S))


def parse_output(text):
    """Analyse la sortie de ping (Windows FR/EN/DE, Linux, macOS).

    Retourne (rtt_ms | None, code, ip_source_de_l_erreur | None).
    """
    low = text.lower()
    m = SRC_RE.search(text)
    src = m.group(1) if m else None
    if any(p in low for p in _TTL):
        return None, TTL, src
    if any(p in low for p in _UNREACH):
        return None, UNREACH, src
    m = RTT_RE.search(text)
    if m:
        if "<" in m.group(0):        # Windows "temps<1ms"
            return 0.5, OK, None
        return float(m.group(1).replace(",", ".")), OK, None
    if any(p in low for p in _OTHER):
        return None, OTHER, None
    return None, TIMEOUT, None


def _decode(b):
    if IS_WIN:
        try:
            return b.decode("oem", "replace")   # page de code de la console (cp850 en FR)
        except LookupError:
            return b.decode("latin-1", "replace")
    return b.decode("utf-8", "replace")


def ping(ip, timeout_ms):
    """Un echo vers une IP (jamais un nom : la resolution est faite a part)."""
    global _oserror_logged
    _space(ip)
    if CFG["demo"]:
        return fake_ping(ip)
    kw = {}
    if IS_WIN:
        cmd = [PING_EXE, "-n", "1", "-l", str(PING_SIZE), "-w", str(timeout_ms), ip]
        kw["creationflags"] = 0x08000000  # CREATE_NO_WINDOW
    elif sys.platform == "darwin":
        cmd = [PING_EXE, "-n", "-c", "1", "-s", str(PING_SIZE), "-W", str(timeout_ms), ip]
    else:
        cmd = [PING_EXE, "-n", "-c", "1", "-s", str(PING_SIZE), "-W", str(max(1, math.ceil(timeout_ms / 1000.0))), ip]
    try:
        p = subprocess.run(cmd, capture_output=True, stdin=subprocess.DEVNULL,
                           timeout=timeout_ms / 1000.0 + 4, **kw)
    except subprocess.TimeoutExpired:
        return None, TIMEOUT, None
    except OSError as e:
        if not _oserror_logged:
            log.error("Impossible de lancer %s : %s", PING_EXE, e)
            _oserror_logged = True
        return None, OTHER, None
    return parse_output(_decode(p.stdout + p.stderr))


def fake_ping(ip):
    """Mode demo : latences et echecs simules, aucun paquet envoye."""
    time.sleep(random.uniform(0.01, 0.04))
    if ip.startswith("10.99."):          # hote eteint facon Windows : timeout et injoignable alternes
        return (None, TIMEOUT, None) if random.random() < 0.5 else (None, UNREACH, "10.99.0.10")
    t = time.time()
    h = sum(map(ord, ip)) % 40 + 8
    if int(t / 180) % 5 == 2 and (t % 180) < 9 + h % 5:
        return None, TIMEOUT, None
    if random.random() < 0.02:
        code = random.choices([TIMEOUT, UNREACH, TTL, OTHER], [60, 20, 15, 5])[0]
        return None, code, ("10.0.0.254" if code in (UNREACH, TTL) else None)
    base = h + 8 * math.sin(t / 37.0 + h)
    if random.random() < 0.03:
        return round(base + random.uniform(40, 180), 1), OK, None
    return round(max(0.4, base + random.gauss(0, 2.5)), 1), OK, None
