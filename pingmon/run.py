#!/usr/bin/env python3
"""Lance PingMon. Python 3.8+, aucune dependance externe."""
import os
import sys

# Le Python "embeddable" ignore le dossier du script (fichier ._pth) : on l'ajoute.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from core.main import main  # noqa: E402

if __name__ == "__main__":
    main()
