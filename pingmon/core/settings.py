"""Parametres reglables depuis l'interface, enregistres dans la base (table meta).

Priorite : option de ligne de commande (verrouillee dans l'interface) > valeur enregistree > defaut.
"""
import json
import logging

from .config import CFG
from .db import db

log = logging.getLogger("settings")

# cle : (minimum, maximum) ; None = booleen
SPEC = {
    "raw_days": (1, 90),
    "retention_days": (7, 3650),
    "backups_keep": (0, 60),
    "backoff": None,
    "backoff_after": (5, 1000),
    "backoff_s": (2, 60),
    "def_interval_ms": (1000, 3600000),
    "def_timeout_ms": (200, 10000),
    "def_outage_n": (0, 1000),
}
LOCKED = set()


class SettingsError(ValueError):
    pass


def _coerce(k, v):
    rng = SPEC[k]
    if rng is None:
        if not isinstance(v, bool):
            raise SettingsError("%s : vrai ou faux attendu" % k)
        return v
    try:
        n = int(float(v))
    except (TypeError, ValueError):
        raise SettingsError("%s : nombre attendu" % k)
    if not rng[0] <= n <= rng[1]:
        raise SettingsError("%s : entre %d et %d" % (k, rng[0], rng[1]))
    return n


def _save():
    vals = {k: CFG[k] for k in SPEC if k not in LOCKED}
    with db() as c:
        c.execute("INSERT OR REPLACE INTO meta(k,v) VALUES('settings',?)", (json.dumps(vals),))


def load(cli):
    """cli : {cle: valeur} des options passees explicitement en ligne de commande."""
    saved = {}
    with db() as c:
        r = c.execute("SELECT v FROM meta WHERE k='settings'").fetchone()
    if r:
        try:
            saved = json.loads(r[0])
        except ValueError:
            log.warning("Parametres enregistres illisibles : valeurs par defaut")
    for k, v in saved.items():
        if k in SPEC and k not in cli:
            try:
                CFG[k] = _coerce(k, v)
            except SettingsError as e:
                log.warning("Parametre ignore : %s", e)
    for k, v in cli.items():
        CFG[k] = v
        LOCKED.add(k)
    CFG["raw_days"] = min(CFG["raw_days"], CFG["retention_days"])


def get():
    return {"values": {k: CFG[k] for k in SPEC}, "locked": sorted(LOCKED)}


def update(d):
    new = {}
    for k, v in d.items():
        if k not in SPEC:
            raise SettingsError("Parametre inconnu : %s" % k)
        if k in LOCKED:
            raise SettingsError("%s est impose par la ligne de commande" % k)
        new[k] = _coerce(k, v)
    raw = new.get("raw_days", CFG["raw_days"])
    ret = new.get("retention_days", CFG["retention_days"])
    if raw > ret:
        raise SettingsError("Les mesures brutes ne peuvent pas etre gardees plus longtemps que l'historique")
    changes = ["%s %r -> %r" % (k, CFG[k], v) for k, v in new.items() if CFG[k] != v]
    CFG.update(new)
    _save()
    if changes:
        log.info("Parametres : %s", ", ".join(changes))
    return get()
