# PingMon 1.8.1

Monitoring de latence par ping : plusieurs cibles en parallèle, graph en direct, tags sur la timeline, stats, historique SQLite.
Python 3.8+ (bibliothèque standard uniquement, aucun `pip`). Windows, Linux, macOS.

## Lancer
- Double-clic sur `start.bat` (ouvre http://127.0.0.1:8765).
- Pas de Python ? Dézipper le « Windows embeddable package » de python.org dans un sous-dossier `python\` : `start.bat` le détecte. Aucun droit admin requis.
- Options : `start.bat --port 8766 --raw-days 7 --retention-days 90 --backups 14 --db D:\data\pingmon.db --no-browser --verbose`
- `--demo` : latences et échecs simulés (`*.invalid` ne se résout pas, `change.*` change d'IP toutes les 10 min, `10.99.x.x` est éteinte).
- Relancer alors que PingMon tourne déjà sur la même base ouvre simplement l'onglet existant.

## Mise à jour
Copier les nouveaux fichiers par-dessus l'ancien dossier (depuis 1.0 : supprimer aussi `server.py`). La base `pingmon.db` est migrée automatiquement au démarrage ; une copie est faite avant dans `backups\`.

## Utilisation
- **Interface** : en-tête sur une ligne (recherche, « + Ajouter », état, menu ⋯ pour le thème, la densité de la liste, les raccourcis et la sauvegarde). La liste de gauche est compacte (une ligne par cible ; ⋯ au survol ou clic droit pour les actions) ; « Confortable » dans le menu ⋯ rétablit les grandes cartes.
- **Chiffres clés** : disponibilité, perte, latence p95 et coupures en grand ; « Toutes les statistiques » déplie le reste. Disponibilité = 1 − (durée des coupures ÷ temps réellement surveillé, hors pauses, arrêts, veille et PingMon fermé). Une coupure = au moins N pertes consécutives (3 par défaut, réglable par cible) ; les pertes plus courtes sont des « pertes isolées », comptées dans la perte mais pas dans la disponibilité.
- **Statut** : badge à côté du titre (« En ligne », « Hors ligne · 2 min », « Nom introuvable · 30 s »…), détail à côté (types d'échec, ralentissement, routeur qui répond) ; sur la liste, le détail est au survol.
- **Paramètres** (menu ⋯) : valeurs par défaut des nouvelles cibles, conservation (avec estimation de la taille de la base), ralentissement des cibles injoignables, sauvegardes, et « À propos » (version, chemins de la base et du journal, charge). Une option passée au lancement (`--raw-days`, `--retention-days`, `--backups`, `--no-backoff`) prime et est verrouillée dans le panneau.
- **Recherche et filtres** : `/` puis texte (nom, IP, site ; Entrée ouvre le premier résultat, Échap efface). « En échec » n'affiche que les cibles qui ne répondent pas, « Échecs en haut » les regroupe en tête de liste. La réorganisation par glisser est désactivée tant qu'un filtre est actif.
- **Raccourcis** : `N` ajouter, `/` rechercher, `L` direct, `T` tagger, `?` aide. Le menu « Affichage » de la barre du graph regroupe « Ignorer les pics extrêmes » et « Tableau des mesures ».
- **Ajouter** : « + Ajouter » (ou `N`), onglet « Une cible » ou « Liste ». Ressaisir une cible arrêtée la relance avec son historique ; ressaisir une cible déjà surveillée avec un nom ou un site met simplement à jour ces champs. Le numéro de version est affiché à côté du logo. L'icône de l'onglet passe au rouge et le titre affiche le nombre de cibles en échec (« ✕ 2 · PingMon »).
- **Nom et site** : champs « Nom » et « Site » à l'ajout, ou clic sur le titre pour renommer, « Modifier » pour changer de site. Les cibles sont regroupées par site dans la colonne de gauche ; chaque groupe a ses boutons ⇄ comparer, ❚❚ pause, ▶ reprendre, ■ arrêter.
- **Réorganiser** : glisser une cible pour la déplacer (la lâcher dans un autre site la change de site), glisser l'en-tête d'un site pour déplacer tout le groupe. Au clavier : Alt+↑ / Alt+↓ sur une cible. L'ordre est enregistré.
- **+ Liste** : coller une liste, une cible par ligne : `adresse`, `adresse nom` ou `adresse;nom;site` (colonnes copiées d'Excel acceptées, `#` = commentaire). Site par défaut, intervalle et timeout communs. Les lignes en erreur restent dans la zone avec la raison.
- **Couleurs** : chaque nouvelle cible prend la couleur la moins utilisée ; « Modifier » permet de la changer. En vue Comparer, chaque cible comparée a sa propre couleur (la 8e en pointillés), gardée tant qu'elle reste comparée.
- **Comparer** : vue « Comparer », puis clic sur les cibles à gauche (8 max), ou ⇄ sur un site. Graphs empilés sur la même timeline, curseur commun (une infobulle avec toutes les cibles à l'instant pointé), zoom et déplacement synchronisés, tableau récapitulatif. Clic sur un nom = ouvrir la cible.
- **Pause / Arrêter** : la pause suspend le ping, la timeline continue (le trou reste visible). « Arrêter » coupe le ping, fige la timeline au moment de l'arrêt (« ■ Fin ») et range la cible dans « Arrêtées » : historique consultable, « Relancer » la réactive, « Supprimer » efface tout.
- **Noms DNS** : résolus une fois, IP affichée, revérifiée toutes les 5 min. Un changement d'IP pose un tag automatique (badge « auto »). Si le nom ne se résout pas, les mesures sont comptées « DNS introuvable ».
- **Types d'échec** : Timeout ■, Hôte injoignable ▲, TTL expiré ◆, DNS introuvable ●, Défaillance ✕. Chaque type a sa couleur et sa forme sur le graph, son compteur dans « Détail des échecs ». Le survol indique quel routeur a répondu (injoignable, TTL).
- **Périodes non surveillées** : pause, arrêt, PingMon arrêté et poste en veille (battement de cœur en retard de plus de 45 s) sont enregistrés et hachurés sur le graph, avec leur durée dans « Non surveillé ». Les stats ne relient pas les mesures de part et d'autre d'un trou (pas de fausse coupure, pas de fausse gigue).
- **Coupures automatiques** : après N pertes consécutives (3 par défaut, réglable dans « Modifier », 0 = désactivé), un tag rouge « Coupure en cours » s'ouvre ; au retour il devient « Coupure de 1 min 29 s · Timeout » avec le détail des échecs en note. Si la surveillance s'interrompt pendant la coupure : « Coupure interrompue (≥ …) ».
- **Graph** : molette = zoom, glisser = déplacer, `L` = retour au direct. Au-delà d'environ 600 points : moyenne + bande min–max.
- **Tags** : mode « Tagger » (`T`) ou double-clic = tag ponctuel ; glisser (ou Maj+glisser) = plage.

## Impact sur les équipements pingués
PingMon n'envoie que des echo ICMP (le ping classique), rien d'autre : pas de TCP, pas de SNMP, pas de scan.
- Au plus **1 ping par seconde et par cible** (plancher imposé, les anciennes cibles à 0,5 s passent à 1 s).
- Au plus **1 ping par seconde vers une même IP**, même si elle est surveillée deux fois (par son nom et par son IP).
- **Un seul ping en vol** par cible : le suivant attend la réponse ou le timeout. Après une veille ou un retard, pas de rattrapage en rafale.
- Paquets de **32 octets** (taille par défaut de Windows), sans option particulière.
- **Démarrage décalé** : au lancement ou après un ajout en lot, les cibles ne pinguent pas toutes à la même milliseconde.
- **Ralentissement** : après 30 échecs consécutifs, la cible n'est plus pinguée que toutes les 5 s jusqu'à son retour (moins d'ARP diffusés par la passerelle pour un hôte éteint). `--no-backoff` pour désactiver.
- DNS : une résolution toutes les 5 min par nom (30 s tant qu'il ne se résout pas).
- La charge totale (ping/s) est affichée en bas de page.

À 1 ping/s, la charge est négligeable pour un switch ou un routeur, très en dessous des limites habituelles de protection du plan de contrôle (CoPP). Un ping régulier vers beaucoup d'adresses peut en revanche être remarqué par une sonde de sécurité : prévenir l'équipe sécurité si tu surveilles un grand nombre d'IP.

## Fichiers et robustesse
- `pingmon.db` : base (WAL). Deux niveaux de conservation :
  - **mesures brutes** (chaque ping) : 7 jours (`--raw-days`), environ 16 Mo par cible à 1 ping/s ;
  - **résumé par minute** (moyenne, min/max, pertes par type, gigue, histogramme, coupures) : 90 jours (`--retention-days`), environ 1 Mo par cible et par semaine.
  Une cible à 1 ping/s occupe donc au plus ~30 Mo, et la base cesse de grossir. Les tags sont conservés sans limite. Le fichier ne rétrécit pas après une purge, mais l'espace libéré est réutilisé.
- Fenêtres de plus de 6 h (ou plus anciennes que les mesures brutes) : graph et stats calculés sur les résumés par minute. Médiane, p95 et p99 sont alors approchés à ±10 % (signalés par « ≈ ») ; le reste (moyenne, min, max, pertes, coupures, plus longue coupure) est exact.
- `backups\` : sauvegarde automatique quotidienne (7 gardées), sauvegardes manuelles (bouton en bas de page) et pré-migration conservées.
- `logs\pingmon.log` : journal tournant (5 × 1 Mo).
- Verrou d'instance unique par base, schéma versionné, écriture groupée avec reprise sur erreur. La page se recharge seule si le serveur a été mis à jour.
- Écoute sur 127.0.0.1 uniquement (contrôle Host/Origin).

## Code
```
run.py            point d'entrée
core/main.py      options, verrou, démarrage
core/api.py       serveur HTTP, API, SSE
core/store.py     cibles, mesures, tags
core/monitor.py   boucles de ping, DNS, coupures, écriture, maintenance
core/lifecycle.py battement de cœur, veille, reprise après arrêt
core/pinger.py    appel et analyse de ping (FR/EN/DE, Linux)
core/resolver.py  DNS
core/stats.py     statistiques
core/rollup.py    résumés par minute, cumul pour les longues fenêtres
core/db.py        connexion, migrations, sauvegardes
tests/            python -m unittest discover -s tests
```
