"""Verrou d'instance unique (par fichier de base de donnees)."""
from .config import IS_WIN

_held = None


def acquire(lock_path):
    """True si le verrou est obtenu. Il est relache automatiquement a la fin du processus."""
    global _held
    fh = open(lock_path, "a+")
    try:
        if IS_WIN:
            import msvcrt
            fh.seek(0)
            msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        fh.close()
        return False
    _held = fh
    return True
