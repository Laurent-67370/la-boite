# Changelog — La Boîte

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