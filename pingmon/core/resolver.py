"""Resolution DNS des cibles saisies par nom."""
import hashlib
import ipaddress
import socket
import time

from .config import CFG


def is_ip(host):
    try:
        ipaddress.ip_address(host.split("%")[0])
        return True
    except ValueError:
        return False


def resolve(host):
    """Liste des IP du nom (IPv4 d'abord), [] si introuvable."""
    if CFG["demo"]:
        return _fake(host)
    try:
        infos = socket.getaddrinfo(host, None, 0, socket.SOCK_STREAM)
    except (socket.gaierror, socket.herror, UnicodeError, OSError):
        return []
    v4, v6 = [], []
    for info in infos:
        ip = info[4][0]
        lst = v4 if info[0] == socket.AF_INET else v6
        if ip not in lst:
            lst.append(ip)
    return v4 + v6


def _fake(host):
    """Demo : *.invalid ne se resout pas, change.* change d'IP toutes les 10 min."""
    if host.endswith(".invalid"):
        return []
    n = int(hashlib.md5(host.encode()).hexdigest(), 16)
    if host.startswith("change"):
        n += int(time.time() // 600)
    return ["10.%d.%d.%d" % ((n >> 16) & 255, (n >> 8) & 255, (n & 255) or 1)]
