"""Journalisation : fichier tournant + console (avertissements uniquement)."""
import logging
import logging.handlers
from pathlib import Path


def setup(path, verbose=False):
    root = logging.getLogger()
    root.setLevel(logging.DEBUG if verbose else logging.INFO)
    for hd in list(root.handlers):
        root.removeHandler(hd)
    sh = logging.StreamHandler()
    sh.setLevel(logging.INFO if verbose else logging.WARNING)
    sh.setFormatter(logging.Formatter("%(levelname)s %(message)s"))
    root.addHandler(sh)
    try:
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        fh = logging.handlers.RotatingFileHandler(path, maxBytes=1000000, backupCount=5, encoding="utf-8")
        fh.setFormatter(logging.Formatter("%(asctime)s %(levelname)-7s %(name)s: %(message)s"))
        root.addHandler(fh)
    except OSError as e:
        root.warning("Journal fichier impossible (%s) : %s", path, e)
