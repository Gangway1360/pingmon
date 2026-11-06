"""Configuration globale et constantes."""
import os
import secrets
from pathlib import Path

VERSION = "1.8.1"
BASE = Path(__file__).resolve().parent.parent
STATIC = BASE / "static"
IS_WIN = os.name == "nt"
MAX_TARGETS = 50          # cibles actives + en pause (les arretees ne comptent pas)
BOOT_ID = secrets.token_hex(6)

DNS_REFRESH_S = 300       # re-verification de l'IP d'un nom
DNS_RETRY_S = 30          # nom jamais resolu : nouvel essai

# Garde-fous pour ne pas charger les equipements pingues
MIN_INTERVAL_MS = 1000    # jamais plus d'un ping par seconde et par cible
MIN_GAP_PER_IP_S = 1.0    # meme IP surveillee deux fois (nom + IP) : 1 ping/s au total
PING_SIZE = 32            # octets de donnees (defaut Windows), jamais plus
BACKOFF_AFTER = 30        # apres 30 echecs consecutifs...
BACKOFF_S = 5             # ...on ne pingue plus que toutes les 5 s jusqu'au retour
DNS_RETRY_KNOWN_S = 60    # echec de re-resolution (on garde l'ancienne IP)

CFG = {
    "db": str(BASE / "pingmon.db"),
    "retention_days": 90,     # resumes par minute
    "raw_days": 7,            # mesures brutes (1 ligne par ping)
    "backups_keep": 7,
    "backup_dir": str(BASE / "backups"),
    "log_file": str(BASE / "logs" / "pingmon.log"),
    "demo": False,
    "strict_host": True,
    "allowed_hosts": set(),
    "url": "",
    "started": 0,
    "backoff": True,
    "backoff_after": BACKOFF_AFTER,
    "backoff_s": BACKOFF_S,
    "def_interval_ms": 1000,
    "def_timeout_ms": 2000,
    "def_outage_n": 3,
}
