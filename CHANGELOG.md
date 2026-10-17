# Changelog — La Boîte

## v1.3.0 — 2026-10-17

**Sécurité** — l'application était publique sans authentification : l'identité n'était qu'un en-tête `X-Member-Id` fourni par le navigateur, donc n'importe qui pouvait tout lire, tout modifier, se faire passer pour l'admin ou téléverser des fichiers sans limite.

- **Code d'accès par membre** (haché scrypt, jamais stocké en clair) ; écran de connexion « Qui êtes-vous ? » + code ; bouton Déconnexion
- **Sessions** : cookie `HttpOnly`, `SameSite=Lax`, `Secure` derrière HTTPS, 30 jours ; seul le hash SHA-256 du jeton est en base
- Toute l'API (y compris SSE et téléchargement des pièces jointes) exige une session ; l'auteur des actions vient de la session (en-tête `X-Member-Id` et champs `member_id`/`created_by` ignorés)
- Droits vérifiés côté serveur : corbeille des cartes et des listes réservée à l'admin, notifications lisibles par leur seul destinataire
- Anti-CSRF : toute modification exige l'en-tête `X-Requested-With: la-boite` (`403` sinon), en plus de `SameSite=Lax`
- Anti-force brute : 5 échecs par membre / 20 par IP → blocage 15 min (`429`) ; sans `X-Forwarded-For`, limite par membre seulement
- Quota total des fichiers joints (500 Mo par défaut, `LA_BOITE_UPLOAD_QUOTA_MB`) → `507`
- `scripts/set-code.cjs` : définir ou régénérer le code d'un membre (ferme ses sessions)
- Migration : colonnes `members.code_hash/code_salt`, table `sessions`

**CI** — GitHub Actions lance la suite Playwright sur chaque PR et sur `main` ; Playwright ajouté en dépendance de développement (épinglé). `scripts/visual-sanity.cjs` tourne désormais sur une instance de test jetable (plus jamais sur le port et la base de prod).

**Interface**
- L'activité du menu se met à jour quand on restaure ou archive (menu ouvert)
- La corbeille n'est reconstruite que si son contenu change (bouton « Restaurer » stable pendant les événements temps réel)
- Mobile : en-tête du tableau sur deux lignes, sans chevauchement des boutons
- Service worker : cache `la-boite-v4`
- Tests : 64/64 (connexion UI, sessions, usurpation, droits, origine, force brute, quota, script de code)

## v1.2.1 — 2026-10-17

Correctif.

- **Supprimer une liste détruisait ses cartes** : `DELETE /api/lists/:id` archivait les cartes puis supprimait la liste, et la cascade de clé étrangère effaçait alors les cartes (et leurs checklists, commentaires, pièces jointes) sans trace. La liste est désormais **archivée** : ses cartes restent intactes, invisibles avec elle, et reviennent quand on la restaure depuis la corbeille.
- Journal d'activité : `list_archived` / `list_unarchived`
- Une liste archivée n'accepte plus de nouvelles cartes, déplacements ni copies (404) et sort de la recherche et des copies de tableau
- Restaurer une carte d'une liste archivée restaure aussi la liste
- Interface : bouton 🗑 dans l'en-tête de liste (admin), listes dans la corbeille avec « Restaurer »
- Migration : `ALTER TABLE lists ADD COLUMN archived` si absente
- Tests : 55/55 (4 nouveaux contrôles)

## v1.2.0 — 2026-10-17

Lot choisi d'après les preuves REA déjà collectées (comportement observé uniquement) : `AddCardAttachment` / `AddLinkAttachmentFromPlugin`, `AddMemberVoted` / `DeleteMemberVoted`, badge `template-badge` des tableaux modèles. Aucune preuve de « date de début » : non retenue.

- **Pièces jointes** : fichiers (10 Mo max, sélecteur ou glisser-déposer sur la modale) et liens http(s) ; aperçu des images, badge `📎 n` ; l'auteur ou l'admin retire
  - Sécurité : fichiers hors de `public/`, nom aléatoire sur disque, nom affiché assaini ; seuls PNG/JPEG/GIF/WebP s'affichent en ligne, tout le reste est forcé en téléchargement (`nosniff` + CSP `sandbox`) ; liens `javascript:` & co refusés
- **Votes** : 👍 un vote par membre, badge `👍 n` (mis en avant si on a voté), avatars des votants dans la modale
- **Tableaux modèles** : un tableau peut être marqué « Modèle » ; « Utiliser ce modèle » crée un nouveau tableau (listes, limites WIP, étiquettes, cartes avec couvertures et checklists décochées — sans commentaires, pièces jointes, votes, membres ni échéances)
- **Plusieurs tableaux** : liste et création dans le menu, navigation par `?board=` ; une notification d'un autre tableau ouvre la bonne carte (`?board=&card=`)
- Migration : `ALTER TABLE boards ADD COLUMN is_template` si absente (bases v1.0/v1.1)
- Service worker : cache `la-boite-v3`
- Tests : 51/51 (10 nouveaux contrôles, dont migration d'une base v1.1)

## v1.1.0 — 2026-10-17

Fonctionnalités choisies d'après les preuves REA déjà collectées (`recon/`) : panneau « Comments and activity » de la modale, opérations `CardChecklistsPatcher` / `ChecklistCheckItemsPatcher` / `CopyCard` / `CardActionsId` du bundle observé. Comportement uniquement, rien de copié.

- **Checklists** : plusieurs par carte, éléments cochables, barre de progression, badge `☑ 2/5` sur la carte (vert une fois tout terminé)
- **Commentaires** : fil dans la modale, badge `💬 n`, l'auteur seul modifie, l'auteur ou l'admin supprime
- **Journal d'activité** : création, déplacement entre listes, échéance, checklist, corbeille, copie ; dans la modale (« Afficher les détails ») et dans le menu du tableau
- **Notifications 🔔** : commentaire sur une carte dont on est membre, mention `@Prénom` / `@INITIALES`, ajout à une carte, déplacement ; compteur non lus, « tout marquer comme lu », temps réel par SSE
- **Fonds du tableau** : 8 préréglages maison (dégradés + aplats) dans le menu ; tout CSS arbitraire est refusé côté serveur
- **Copie de carte** : titre, liste cible, choix de conserver checklists / étiquettes / membres
- Recherche étendue aux commentaires et aux éléments de checklist
- Écran étroit : la barre haute passe sur deux lignes (plus de défilement horizontal de la page sur mobile)
- Tests : 41/41 (15 nouveaux contrôles) ; `CHROMIUM_PATH` permet de pointer un Chromium local
- Service worker : cache `la-boite-v2`
- Migration : uniquement des `CREATE TABLE IF NOT EXISTS`, une base v1.0.0 existante est reprise telle quelle

## v1.0.0 — 2026-10-17

Version initiale.

- Board kanban : listes (WIP + jeton, repli ⤢), cartes (description, couverture, échéance, étiquettes, membres)
- Glisser-déposer cartes + listes (positions réelles)
- Recherche / filtre, corbeille (archiver/restaurer)
- Temps réel SSE (multi-onglets sans rechargement)
- PWA installable + mode sombre
- API REST (voir README) + base SQLite WAL seedée
- Tests : 26/26 (test/mvp.cjs) + vérification visuelle (scripts/visual-sanity.cjs)
- Recon d'ergonomie par REA (comportement observé uniquement) — aucune copie de l'original