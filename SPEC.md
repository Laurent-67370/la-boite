# Spécification — « La Boîte » (clone Trello, vanilla JS + Node/Express + SQLite)

⚠️ Recon par REA (Reverse Engineer Anything) uniquement sur COMPORTEMENT OBSERVÉ — aucune copie de code, asset, logo ou texte Trello. Nom produit original. Preuves : /root/trello-clone/recon/ (evidence ev_e3bc7e8e landing, ev_c6095d38 + ev_7cad2178 + tpl-clean board, ev_3d38af97 bundle 34 scripts/227 endpoints, cardmodal).

## 1. Fichiers
- /root/trello-clone/{package.json, server.js, db.js, public/index.html, public/app.js, public/style.css, public/manifest.webmanifest, public/sw.js, public/icons/*}
- Port local : **3230** (proxy nginx : terminus trello.lhusser.fr).
- SQLite : fichier `data.db` à côté de server.js (WAL).

## 2. Modèle de données
- boards(id INTEGER PK, name TEXT, background TEXT /*css gradient ou clé*/, created_at)
- lists(id, board_id, name, pos REAL, wip_limit INTEGER NULL, collapsed INTEGER DEFAULT 0)
- cards(id, list_id, title, description TEXT DEFAULT '', pos REAL, cover TEXT NULL /*couleur*/, due_at TEXT NULL, due_complete INTEGER 0, due_badged, archived INTEGER 0, created_at, created_by)
  — archivage = corbeille (restauration via /api/cards/:id/unarchive)
- labels(id, board_id, name, color) + card_labels(card_id, label_id, PK composite)
- members(id, name, initials, color) + card_members(card_id, member_id, PK composite)
- Seed : board « Projet démo » + 4 listes (À faire / En cours / À valider / À livrer) + 3 labels (Urgent rouge, Normal orange, À revoir vert) + 4 membres (Laurent LH, Marina MB, Noémie NP, Julia JU) + quelques cartes.

## 3. API REST (Express) — style suivi-fournisseurs
- GET  /api/health → {ok:true}
- GET  /api/board/:id → {board, lists:[{...cards:[...]}], labels, members}
- POST /api/boards {name}
- POST /api/lists {board_id,name} ; PATCH /api/lists/:id {name?,pos?,wip_limit?,collapsed?} ; DELETE /api/lists/:id (cards→archivées)
- POST /api/cards {list_id,title} ; PATCH /api/cards/:id {title?,description?,due_at?,due_complete?,cover?,pos?} ; DELETE /api/cards/:id (archive) ; POST /api/cards/:id/unarchive
- POST /api/cards/:id/move {list_id,pos} (drag&drop)
- POST /api/cards/:id/labels {label_id|remove} ; POST /api/cards/:id/members {member_id|remove}
- GET  /api/board/:id/search?q= ( titre | description | label | membre )
- SSE  /api/board/:id/events (broadcast après chaque PATCH/POST/DELETE ; client = EventSource → re-render)

## 4. UI (fr) — structure Trello observée, habillage ORIGINAL
- **barre haute** : nom app « La Boîte » + select utilisateur (4 membres) ; à droite : recherche, bouton + Liste.
- **header board** (fond translucide sombre) : titre éditable, chip, compteur WIP global?, boutons : filtrer (popover, liseuse labels/membres/échéance), … menu.
- **canvas scroll horizontal** : fond dégradé ; listes ~264 px, coins arrondis 8 px, fond blanc-gris translucide (blur léger).
  - liste : header « nom » + badge compte/wip (« 2/10 » vert si <, orange =, rouge >) + bouton ⤢ replier ; cartes ; pied « + Ajouter une carte » (composer en haut ou bas).
  - carte : fond blanc, coins 8 px ; cover colorée pleine largeur si cover ; badges : 📝 si description, 📅 échéance (rouge si passée, vert cliquée), avatars membres (cercles initiales colorées), chips labels carrés colorés (nom au survol).
  - **drag & drop natif HTML5** : draggable sur .list-card, drop zones = .list-cards (insertion par pos réel) + réordonnancement (liste = draggable sur .list-wrapper).
- **modale carte** (clic carte) : chip liste (header) + ✕ ; titre éditable ; description textarea (sauvegarde auto) ; échéance (input datetime-local) + bouton « terminée ✓ » ; labels (chips multi) ; membres (multi) ; cover (palette 6 couleurs) ; archives/supprimer pour Laurent.
- PWA : manifest (name « La Boîte », display standalone, theme #0b57d0-like bleu profond mais original #1e40af? → prendre #22577a), sw.js cache-first static + network-first navigations, 2 icônes 192/512 générées (SVG→PNG emoji 🗂️).
- Dark mode : prefers-color-scheme sombre.
- Contrôle à la fermeture : rien d'autre à persister que db.

## 5. Tests Playwright (.cjs, require ABSOLU /root/node_modules/playwright)
Instance de test PORT=3231 + data.db temporaire (SF_TRELLIS_TEST=1 → db fichier /tmp/trello-test.db réinitialisé).
~14 checks : health ; board GET (4 listes) ; create card (POST) visible ; PATCH title/desc écho ; due date badge rouge/horodaté ; labels chips visibles ; membre avatar sur carte ; WIP badge 2/10 ; collapse liste (classe) ; SEARCH filtre ; SSE : autre page reçoit l'insert ; drag&drop simulation (dispatchEvent dragstart/drop → pos changé + UI) ; archive + unarchive ; 404 sur id inconnu.

## 6. Déploiement (étape distincte, pas dans ce build)
- /opt/la-boite/ (rsync depuis repo), systemd `la-boite.service` (ExecStart node server.js, PORT=3230, WorkingDirectory /opt/la-boite), vhost nginx `trello.lhusser.fr` (root proxy, SW no-cache, index no-cache), certbot, **carte portail** (slug `laboite`, 🗂️, « La Boîte — tableau kanban », icône #22577a, entre Rubik et Crystal) + repo GitHub `Laurent-67370/la-boite`.

## 7. Interdits
- Jamais de log/data de la prod ailleurs ; jamais de pkill node global (tuer par PID) ; le fichier data.db de test = /tmp/trello-test.db ; pas de dépendance lourde (express + better-sqlite3 seulement).