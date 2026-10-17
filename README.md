# La Boîte 🗂️

Tableau kanban simple et léger — listes, cartes, étiquettes, échéances — inspiré de l'ergonomie de Trello mais **construit à 100 % de zéro** (aucune ligne de code, d'asset ou de texte récupéré de la plateforme originale).

![La Boîte — vue mobile](docs/capture-mobile.png)

## Fonctionnalités (v1.1.0)

- **Board** : listes avec compte de cartes et **jeton de limite WIP** (`2/10` — vert, orange, rouge selon le seuil), repli d'une liste (⤢)
- **Cartes** : titre, description (badge 📝), **couverture colorée**, **échéance** (badge orange/rouge si passée, vert si terminée ✓), **étiquettes** (chips colorées, nom au survol), **membres** (initiales colorées)
- **Checklists** (progression + badge `☑ 2/5`), **commentaires** (badge `💬`, mentions `@Prénom`), **journal d'activité** par carte et par tableau
- **Notifications 🔔** : commentaires, mentions, assignations, déplacements — compteur non lus en temps réel
- **Fonds du tableau** (préréglages maison) et **copie de carte** (liste cible, checklists / étiquettes / membres au choix)
- **Glisser-déposer** : cartes entre listes, réordonnancement de cartes ET de listes (positions réelles)
- **Recherche / filtre** : titre, description, étiquette, membre, commentaire, élément de checklist, échéance
- **Corbeille** : archivage + restauration
- **Temps réel** : SSE (`/api/board/:id/events`) — une carte créée sur un onglet apparaît instantanément sur les autres, sans rechargement
- **PWA installable** (manifest + service worker, mise hors-ligne des fichiers statiques) + **mode sombre**
- Données locales : SQLite (mode WAL) — aucune donnée ne quitte le serveur

## Stack

Vanilla JS (aucun framework côté client) · Express · better-sqlite3 · service worker minimal · nginx devant le service systemd.

## Lancer en local

```bash
npm install
npm start          # http://localhost:3230 (base seedée automatiquement au premier lancement)
```

Variables :
- `PORT` (3230 par défaut)
- `SF_TRELLIS_TEST=1` → base de test jetable `/tmp/trello-test.db` (réinitalisée à chaque démarrage)

## Tests

```bash
npm test     # 41 contrôles Playwright (API, UI, SSE, drag&drop, corbeille, checklists, commentaires, notifications…)
CHROMIUM_PATH=/chemin/vers/chrome npm test   # si le Chromium de Playwright n'est pas installé
node scripts/visual-sanity.cjs   # captures + drag de listes + erreurs de page
```

## API REST

| Requête | Effet |
|---|---|
| `GET /api/health` | état du service |
| `GET /api/board/:id` | board complet (listes, cartes, étiquettes, membres) |
| `POST /api/boards` · `PATCH /api/boards/:id` | créer / renommer / changer le fond (`background` ∈ préréglages) |
| `POST /api/lists` · `PATCH/DELETE /api/lists/:id` | listes (nom, position, WIP, repli) |
| `POST /api/cards` · `PATCH/DELETE /api/cards/:id` | cartes (titre, description, échéance, couverture…) |
| `POST /api/cards/:id/move` | déplacement / réordonnancement |
| `POST /api/cards/:id/labels` · `/members` | rattacher / retirer |
| `POST /api/cards/:id/unarchive` | restaurer depuis la corbeille |
| `GET /api/cards/:id` | détail : checklists, commentaires, activité |
| `POST /api/cards/:id/checklists` · `PATCH/DELETE /api/checklists/:id` | checklists |
| `POST /api/checklists/:id/items` · `PATCH/DELETE /api/checkitems/:id` | éléments (nom, coché, position) |
| `POST /api/cards/:id/comments` · `PATCH/DELETE /api/comments/:id` | commentaires |
| `POST /api/cards/:id/copy` | copier une carte |
| `GET /api/board/:id/activity` | journal d'activité du tableau |
| `GET /api/members/:id/notifications` · `POST …/notifications/read` | notifications 🔔 |
| `GET /api/board/:id/search?q=` | recherche |
| `GET /api/board/:id/events` | flux SSE temps réel |

L'auteur d'une action est transmis par l'en-tête `X-Member-Id` (sélecteur d'utilisateur de l'interface).

## Déploiement (VPS)

- Service systemd `la-boite.service` → `/opt/la-boite`, port `3230`
- nginx : vhost `trello.lhusser.fr` (proxy + `proxy_buffering off` pour le SSE + `no-cache` sur `sw.js`)
- HTTPS : Let's Encrypt (certbot, renouvellement automatique)
- Carte sur le portail des apps : terminal.lhusser.fr

## Historique

Voir [CHANGELOG.md](CHANGELOG.md).

## Provenance

Reconnaissance de l'ergonomie de référence réalisée avec **REA (Reverse Engineer Anything)** sur le comportement observé uniquement (captures, DOM, graphe applicatif) — le produit ne contient **aucun élément** du site de référence (code, visuels, textes ou marques).

Licence MIT.