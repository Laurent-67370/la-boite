// server.js — « La Boîte » : API REST + SSE + statique (vanilla front)
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const { init, BACKGROUNDS } = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT || 3230);
const IS_TEST = process.env.SF_TRELLIS_TEST === '1';
const DB_PATH = IS_TEST
  ? '/tmp/trello-test.db'
  : path.join(__dirname, 'data.db');

// Instance de test : réinitialisation propre (fichier + WAL + SHM)
if (IS_TEST) {
  for (const suffix of ['', '-wal', '-shm']) {
    const p = DB_PATH + suffix;
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

const db = init(DB_PATH);

// Fichiers joints : hors de public/, jamais servis en statique
const UPLOAD_DIR = IS_TEST ? '/tmp/la-boite-test-uploads' : path.join(__dirname, 'uploads');
if (IS_TEST) fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const MAX_UPLOAD = 10 * 1024 * 1024;
// Quota total des fichiers joints (Mo), pour qu'un compte ne puisse pas remplir le disque
const UPLOAD_QUOTA = Number(process.env.LA_BOITE_UPLOAD_QUOTA_MB || 500) * 1024 * 1024;
// Types affichés en ligne (aperçu) ; tout le reste est forcé en téléchargement. Pas de SVG (scripts).
const INLINE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/* ------------------------------ Codes d'accès ------------------------------ */

// Amorçage optionnel des codes : LA_BOITE_INITIAL_CODES="1:code,2:code" (membres sans code seulement).
// En production, préférer scripts/set-code.cjs.
if (process.env.LA_BOITE_INITIAL_CODES) {
  for (const pair of process.env.LA_BOITE_INITIAL_CODES.split(',')) {
    const [id, code] = pair.split(':');
    const m = db.prepare('SELECT id, code_hash FROM members WHERE id = ?').get(Number(id));
    if (m && !m.code_hash && auth.validCode(code)) {
      const { salt, hash } = auth.hashCode(code);
      db.prepare('UPDATE members SET code_hash = ?, code_salt = ? WHERE id = ?').run(hash, salt, m.id);
    }
  }
}
db.prepare("DELETE FROM sessions WHERE expires_at < strftime('%Y-%m-%dT%H:%M:%fZ','now')").run();

const SESSION_COOKIE = 'lb_session';
const SESSION_DAYS = 30;
const ADMIN_ID = 1;

// Anti-force brute, fenêtre de 15 min :
// - 5 échecs pour un membre depuis une même IP → ce couple est bloqué (un tiers ne bloque plus le membre partout) ;
// - 50 échecs pour un membre toutes IP confondues → membre bloqué (attaque distribuée) ;
// - 20 échecs depuis une IP, tous membres confondus → IP bloquée (sauf 127.0.0.1 : sans X-Forwarded-For,
//   toutes les requêtes semblent venir de là et on bloquerait tout le monde).
const FAIL_WINDOW = 15 * 60 * 1000;
const LIMITS = { memberIp: 5, member: 50, ip: 20 };
const failures = new Map(); // clé -> { n, until }
function tooManyFailures(key, max) {
  const f = failures.get(key);
  return !!f && f.until > Date.now() && f.n >= max;
}
function recordFailure(key) {
  const now = Date.now();
  if (failures.size > 10000) for (const [k, f] of failures) if (f.until <= now) failures.delete(k);
  const f = failures.get(key);
  if (!f || f.until <= now) failures.set(key, { n: 1, until: now + FAIL_WINDOW });
  else f.n += 1;
}

// Garde commune à la connexion et au changement de code
function attemptGuard(req, memberId) {
  const loopback = /^(::1|127\.|::ffff:127\.)/.test(req.ip || '');
  const keys = {
    memberIp: `mi:${memberId}:${req.ip}`,
    member: `m:${memberId}`,
    ip: loopback ? null : `ip:${req.ip}`
  };
  return {
    blocked: Object.entries(keys).some(([k, key]) => key && tooManyFailures(key, LIMITS[k])),
    fail() { for (const key of Object.values(keys)) if (key) recordFailure(key); },
    success() { failures.delete(keys.memberIp); }
  };
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function sessionMember(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  return db.prepare(`
    SELECT m.id, m.name, m.initials, m.color, m.role FROM sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ? AND s.expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`).get(auth.tokenHash(token)) || null;
}

function setSessionCookie(req, res, token, maxAgeSec) {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (req.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback'); // nginx en frontal : X-Forwarded-Proto/For fiables uniquement depuis localhost
app.use(express.json());

// Anti-CSRF (en plus de SameSite=Lax) : toute requête qui modifie doit porter l'en-tête maison
// X-Requested-With: la-boite. Un autre site ne peut pas l'ajouter sans autorisation CORS (jamais donnée),
// et le contrôle ne dépend pas des en-têtes Host/X-Forwarded-* transmis par nginx.
app.use('/api', (req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.get('X-Requested-With') !== 'la-boite') return res.status(403).json({ error: 'csrf' });
  next();
});

/* ------------------------------- SSE ------------------------------- */

const sseClients = new Map(); // boardId -> Set<res>

function sseHandshake(req, res) {
  const boardId = Number(req.params.id);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(': connecté\n\n');
  let set = sseClients.get(boardId);
  if (!set) { set = new Set(); sseClients.set(boardId, set); }
  set.add(res);
  const beat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* fermé */ }
  }, 25000);
  res.on('close', () => { clearInterval(beat); set.delete(res); });
}

function broadcast(boardId, payload) {
  const set = sseClients.get(Number(boardId));
  if (!set || set.size === 0) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try { res.write(data); } catch { set.delete(res); }
  }
}

/* ----------------------------- Helpers ----------------------------- */

function getBoard(id) {
  const b = db.prepare('SELECT id, name, background, is_template, created_at FROM boards WHERE id = ?').get(id);
  if (b) b.is_template = !!b.is_template;
  return b;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function badReq(res, msg) {
  return res.status(400).json({ error: msg });
}

function notFound(res) {
  return res.status(404).json({ error: 'not_found' });
}

function getCard(id) {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(id);
}

function boardOfList(listId) {
  return db.prepare('SELECT board_id FROM lists WHERE id = ?').get(listId).board_id;
}

// Liste active (non archivée) : seule cible valable pour créer, déplacer ou copier une carte
function getActiveList(id) {
  return db.prepare('SELECT * FROM lists WHERE id = ? AND archived = 0').get(id);
}

function boardOfCard(card) {
  return boardOfList(card.list_id);
}

// Auteur de l'action : le membre de la session (jamais un en-tête ou un champ envoyé par le client)
function actorId(req) {
  return req.member ? req.member.id : null;
}

function isAdminReq(req) {
  return actorId(req) === ADMIN_ID;
}

function forbidden(res) {
  return res.status(403).json({ error: 'forbidden' });
}

function logActivity(boardId, cardId, memberId, kind, text) {
  db.prepare('INSERT INTO activity (board_id, card_id, member_id, kind, text) VALUES (?,?,?,?,?)')
    .run(boardId, cardId, memberId, kind, text);
}

// Notifie les membres de la carte (+ destinataires explicites), jamais l'auteur de l'action
function notify(card, actor, kind, text, extraIds = []) {
  const boardId = boardOfCard(card);
  const ids = new Set(db.prepare('SELECT member_id FROM card_members WHERE card_id = ?').all(card.id).map((r) => r.member_id));
  for (const id of extraIds) ids.add(id);
  ids.delete(actor);
  const ins = db.prepare('INSERT INTO notifications (member_id, board_id, card_id, actor_id, kind, text) VALUES (?,?,?,?,?,?)');
  for (const id of ids) ins.run(id, boardId, card.id, actor, kind, text);
  if (ids.size) broadcast(boardId, { type: 'notification', members: [...ids] });
}

// Mentions « @Prénom » ou « @INITIALES » dans un commentaire
function mentionedMembers(text) {
  const out = [];
  for (const m of db.prepare("SELECT id, name, initials FROM members WHERE role != 'guest'").all()) {
    const alt = [m.name, m.initials].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    const re = new RegExp(`(^|\\s)@(${alt})(?![\\p{L}\\d])`, 'iu');
    if (re.test(text)) out.push(m.id);
  }
  return out;
}

const ACTIVITY_SELECT = `
  SELECT a.id, a.card_id, a.kind, a.text, a.created_at, a.member_id,
         m.name AS member_name, m.initials AS member_initials, m.color AS member_color, c.title AS card_title
  FROM activity a
  LEFT JOIN members m ON m.id = a.member_id
  LEFT JOIN cards c ON c.id = a.card_id`;

function cardChecklists(cardId) {
  const lists = db.prepare('SELECT id, card_id, name, pos FROM checklists WHERE card_id = ? ORDER BY pos, id').all(cardId);
  const itemStmt = db.prepare(`
    SELECT ci.id, ci.checklist_id, ci.name, ci.pos, ci.checked, ci.assignee_id,
           m.name AS assignee_name, m.initials AS assignee_initials, m.color AS assignee_color
    FROM check_items ci LEFT JOIN members m ON m.id = ci.assignee_id
    WHERE ci.checklist_id = ? ORDER BY ci.pos, ci.id`);
  for (const cl of lists) {
    cl.items = itemStmt.all(cl.id).map((it) => ({ ...it, checked: !!it.checked }));
  }
  return lists;
}

const COMMENT_SELECT = `
  SELECT co.id, co.card_id, co.member_id, co.text, co.created_at, co.edited_at,
         m.name AS member_name, m.initials AS member_initials, m.color AS member_color
  FROM comments co LEFT JOIN members m ON m.id = co.member_id`;

function nextPos(table, column, parentId) {
  return db.prepare(`SELECT COALESCE(MAX(pos),0) AS m FROM ${table} WHERE ${column} = ?`).get(parentId).m + 100;
}

const CARD_FIELDS_OK = new Set(['title', 'description', 'start_at', 'due_at', 'due_complete', 'cover', 'pos', 'due_badged']);
const START_RE = /^\d{4}-\d{2}-\d{2}$/; // date de début : jour seul (AAAA-MM-JJ)

function fmtDay(day) {
  const [y, m, d] = day.split('-');
  return `${d}/${m}/${y}`;
}

/* -------------------------------- API ------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

/* ------------------------------ Authentification ---------------------------- */

// Liste pour l'écran de connexion : noms et initiales seulement
app.get('/api/auth/members', (_req, res) => {
  res.json({ members: db.prepare("SELECT id, name, initials, color, role FROM members ORDER BY role = 'guest', id").all() });
});

app.post('/api/auth/login', (req, res) => {
  const { member_id, code } = req.body || {};
  const id = Number(member_id);
  const guard = attemptGuard(req, id);
  if (guard.blocked) return res.status(429).json({ error: 'too_many_attempts' });
  const m = Number.isInteger(id) ? db.prepare('SELECT id, code_hash, code_salt FROM members WHERE id = ?').get(id) : null;
  const ok = typeof code === 'string' && auth.verifyCode(code, m && m.code_salt, m && m.code_hash);
  if (!m || !ok) {
    guard.fail();
    return res.status(401).json({ error: 'bad_credentials' });
  }
  guard.success();
  const token = auth.newToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, member_id, expires_at) VALUES (?,?,?)').run(auth.tokenHash(token), m.id, expires);
  setSessionCookie(req, res, token, SESSION_DAYS * 86400);
  res.json({ member: db.prepare('SELECT id, name, initials, color, role FROM members WHERE id = ?').get(m.id) });
});

app.post('/api/auth/logout', (req, res) => {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(auth.tokenHash(token));
  setSessionCookie(req, res, '', 0);
  res.json({ ok: true });
});

// Tout le reste de l'API exige une session valide
app.use('/api', (req, res, next) => {
  const member = sessionMember(req);
  if (!member) return res.status(401).json({ error: 'auth_required' });
  req.member = member;
  next();
});

// Invité : lecture seule, toute écriture refusée côté serveur (l'interface masque aussi les commandes)
app.use('/api', (req, res, next) => {
  if (req.member.role !== 'guest' || req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.path === '/auth/logout') return next();
  res.status(403).json({ error: 'read_only' });
});

app.get('/api/auth/me', (req, res) => res.json({ member: req.member }));

// Changer son propre code : code actuel exigé (même garde anti-force brute que la connexion).
// Les autres sessions du membre sont fermées ; la session courante reste ouverte.
app.post('/api/auth/code', (req, res) => {
  const { current, next } = req.body || {};
  const id = req.member.id;
  const guard = attemptGuard(req, id);
  if (guard.blocked) return res.status(429).json({ error: 'too_many_attempts' });
  const m = db.prepare('SELECT code_hash, code_salt FROM members WHERE id = ?').get(id);
  if (typeof current !== 'string' || !auth.verifyCode(current, m.code_salt, m.code_hash)) {
    guard.fail();
    return res.status(401).json({ error: 'bad_credentials' });
  }
  guard.success();
  if (!auth.validCode(next)) return badReq(res, `code trop court (${auth.MIN_CODE_LENGTH} caractères minimum)`);
  if (next === current) return badReq(res, 'nouveau code identique');
  const { salt, hash } = auth.hashCode(next);
  const keep = auth.tokenHash(parseCookies(req)[SESSION_COOKIE]);
  db.transaction(() => {
    db.prepare('UPDATE members SET code_hash = ?, code_salt = ? WHERE id = ?').run(hash, salt, id);
    db.prepare('DELETE FROM sessions WHERE member_id = ? AND token_hash != ?').run(id, keep);
  })();
  res.json({ ok: true });
});

// Tableau complet : board + listes (chacune avec ses cartes actives) + labels + membres + corbeille
app.get('/api/board/:id', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const lists = db
    .prepare('SELECT id, board_id, name, pos, wip_limit, collapsed FROM lists WHERE board_id = ? AND archived = 0 ORDER BY pos')
    .all(board.id);
  const labelStmt = db.prepare(`
    SELECT l.id, l.name, l.color FROM card_labels cl JOIN labels l ON l.id = cl.label_id
    WHERE cl.card_id = ? ORDER BY l.id`);
  const memberStmt = db.prepare(`
    SELECT m.id, m.name, m.initials, m.color FROM card_members cm JOIN members m ON m.id = cm.member_id
    WHERE cm.card_id = ? ORDER BY m.id`);
  const cardStmt = db.prepare(`
    SELECT c.id, c.list_id, c.title, c.description, c.pos, c.cover, c.start_at, c.due_at, c.due_complete, c.due_badged,
           c.archived, c.created_at, c.created_by
    FROM cards c WHERE c.list_id = ? AND c.archived = 0 ORDER BY c.pos`);
  const checkStmt = db.prepare(`
    SELECT COUNT(ci.id) AS total, COALESCE(SUM(ci.checked),0) AS done
    FROM checklists cl JOIN check_items ci ON ci.checklist_id = cl.id WHERE cl.card_id = ?`);
  const commentStmt = db.prepare('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?');
  const attachStmt = db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ?');
  const voteStmt = db.prepare('SELECT member_id FROM card_votes WHERE card_id = ? ORDER BY member_id');
  for (const list of lists) {
    list.cards = cardStmt.all(list.id).map((c) => {
      c.labels = labelStmt.all(c.id);
      c.checklist = checkStmt.get(c.id);
      c.comments_count = commentStmt.get(c.id).n;
      c.attachments_count = attachStmt.get(c.id).n;
      c.voters = voteStmt.all(c.id).map((v) => v.member_id);
      c.members = memberStmt.all(c.id);
      c.due_complete = !!c.due_complete;
      c.archived = !!c.archived;
      c.due_badged = !!c.due_badged;
      return c;
    });
  }
  const labels = db.prepare('SELECT id, name, color FROM labels WHERE board_id = ? ORDER BY id').all(board.id);
  const members = db.prepare("SELECT id, name, initials, color FROM members WHERE role != 'guest' ORDER BY id").all();
  const archived = db.prepare(`
    SELECT c.id, c.list_id, c.title, c.archived FROM cards c
    JOIN lists l ON l.id = c.list_id
    WHERE l.board_id = ? AND c.archived = 1 AND l.archived = 0 ORDER BY c.id DESC`).all(board.id);
  const archivedLists = db.prepare(`
    SELECT l.id, l.name, (SELECT COUNT(*) FROM cards c WHERE c.list_id = l.id AND c.archived = 0) AS cards
    FROM lists l WHERE l.board_id = ? AND l.archived = 1 ORDER BY l.id DESC`).all(board.id);
  res.json({ board, lists, labels, members, archived, archived_lists: archivedLists, backgrounds: BACKGROUNDS });
});

app.get('/api/boards', (_req, res) => {
  const boards = db.prepare('SELECT id, name, background, is_template FROM boards ORDER BY is_template, id').all()
    .map((b) => ({ ...b, is_template: !!b.is_template }));
  res.json({ boards });
});

// Nouveau tableau depuis un tableau (typiquement un modèle) : listes, étiquettes et, au choix, cartes
// (titre, description, couverture, étiquettes, checklists décochées). Ni commentaires, ni activité,
// ni pièces jointes, ni votes, ni échéances.
app.post('/api/boards/:id/copy', (req, res) => {
  const src = getBoard(req.params.id);
  if (!src) return notFound(res);
  const body = req.body || {};
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : `${src.name} (copie)`;
  const keepCards = body.keep_cards !== false;
  const id = db.transaction(() => {
    const b = db.prepare('INSERT INTO boards (name, background) VALUES (?,?)').run(name, src.background).lastInsertRowid;
    const labelMap = new Map();
    for (const l of db.prepare('SELECT * FROM labels WHERE board_id = ? ORDER BY id').all(src.id)) {
      labelMap.set(l.id, db.prepare('INSERT INTO labels (board_id, name, color) VALUES (?,?,?)').run(b, l.name, l.color).lastInsertRowid);
    }
    for (const l of db.prepare('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY pos').all(src.id)) {
      const nl = db.prepare('INSERT INTO lists (board_id, name, pos, wip_limit) VALUES (?,?,?,?)')
        .run(b, l.name, l.pos, l.wip_limit).lastInsertRowid;
      if (!keepCards) continue;
      for (const c of db.prepare('SELECT * FROM cards WHERE list_id = ? AND archived = 0 ORDER BY pos').all(l.id)) {
        const nc = db.prepare('INSERT INTO cards (list_id, title, description, pos, cover, created_by) VALUES (?,?,?,?,?,?)')
          .run(nl, c.title, c.description, c.pos, c.cover, actorId(req)).lastInsertRowid;
        for (const cl of db.prepare('SELECT label_id FROM card_labels WHERE card_id = ?').all(c.id)) {
          db.prepare('INSERT INTO card_labels (card_id, label_id) VALUES (?,?)').run(nc, labelMap.get(cl.label_id));
        }
        for (const ck of cardChecklists(c.id)) {
          const nk = db.prepare('INSERT INTO checklists (card_id, name, pos) VALUES (?,?,?)').run(nc, ck.name, ck.pos).lastInsertRowid;
          for (const it of ck.items) db.prepare('INSERT INTO check_items (checklist_id, name, pos) VALUES (?,?,?)').run(nk, it.name, it.pos);
        }
      }
    }
    logActivity(b, null, actorId(req), 'board_created', `a créé ce tableau à partir de « ${src.name} »`);
    return b;
  })();
  res.status(201).json({ board: getBoard(id) });
});

app.post('/api/boards', (req, res) => {
  const name = req.body && typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return badReq(res, 'name requis');
  const background = BACKGROUNDS[(db.prepare('SELECT COUNT(*) AS n FROM boards').get().n) % BACKGROUNDS.length];
  const r = db.prepare('INSERT INTO boards (name, background) VALUES (?,?)').run(name, background);
  res.status(201).json({ board: getBoard(r.lastInsertRowid) });
});

app.patch('/api/boards/:id', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const { name, background, is_template } = req.body || {};
  if (name === undefined && background === undefined && is_template === undefined) return badReq(res, 'aucun champ');
  if (is_template !== undefined) {
    db.prepare('UPDATE boards SET is_template = ? WHERE id = ?').run(is_template ? 1 : 0, board.id);
  }
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) return badReq(res, 'name requis');
    db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name.trim(), board.id);
  }
  if (background !== undefined) {
    // Fond : un des préréglages maison (dégradé ou aplat) — pas de CSS arbitraire
    if (!BACKGROUNDS.includes(background)) return badReq(res, 'background inconnu');
    db.prepare('UPDATE boards SET background = ? WHERE id = ?').run(background, board.id);
  }
  broadcast(board.id, { type: 'board', id: board.id });
  res.json({ board: getBoard(board.id) });
});

app.post('/api/lists', (req, res) => {
  const { board_id, name } = req.body || {};
  if (!Number.isInteger(Number(board_id)) || typeof name !== 'string' || !name.trim()) {
    return badReq(res, 'board_id et name requis');
  }
  const board = getBoard(Number(board_id));
  if (!board) return notFound(res);
  const max = db.prepare('SELECT COALESCE(MAX(pos),0) AS m FROM lists WHERE board_id = ?').get(board.id).m;
  const r = db.prepare('INSERT INTO lists (board_id, name, pos) VALUES (?,?,?)').run(board.id, name.trim(), max + 100);
  broadcast(board.id, { type: 'list', id: r.lastInsertRowid });
  res.status(201).json({ list: db.prepare('SELECT * FROM lists WHERE id = ?').get(r.lastInsertRowid) });
});

app.patch('/api/lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return notFound(res);
  const body = req.body || {};
  const updates = [];
  const values = [];
  if (typeof body.name === 'string' && body.name.trim()) { updates.push('name = ?'); values.push(body.name.trim()); }
  if ('pos' in body && isFiniteNumber(Number(body.pos))) { updates.push('pos = ?'); values.push(Number(body.pos)); }
  if ('wip_limit' in body) {
    if (body.wip_limit !== null && !Number.isInteger(Number(body.wip_limit))) return badReq(res, 'wip_limit invalide');
    updates.push('wip_limit = ?'); values.push(body.wip_limit === null ? null : Number(body.wip_limit));
  }
  if ('collapsed' in body) { updates.push('collapsed = ?'); values.push(body.collapsed ? 1 : 0); }
  if (!updates.length) return badReq(res, 'aucun champ');
  db.prepare(`UPDATE lists SET ${updates.join(', ')} WHERE id = ?`).run(...values, list.id);
  broadcast(list.board_id, { type: 'list', id: list.id });
  res.json({ list: db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id) });
});

// Suppression = archivage de la liste : ses cartes restent intactes et reviennent avec elle.
// (Un vrai DELETE détruisait les cartes par cascade de clé étrangère.)
app.delete('/api/lists/:id', (req, res) => {
  const list = getActiveList(req.params.id);
  if (!list) return notFound(res);
  if (!isAdminReq(req)) return forbidden(res);
  db.prepare('UPDATE lists SET archived = 1 WHERE id = ?').run(list.id);
  logActivity(list.board_id, null, actorId(req), 'list_archived', `a mis la liste « ${list.name} » à la corbeille`);
  broadcast(list.board_id, { type: 'list', id: list.id });
  res.json({ ok: true });
});

app.post('/api/lists/:id/unarchive', (req, res) => {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return notFound(res);
  db.prepare('UPDATE lists SET archived = 0 WHERE id = ?').run(list.id);
  logActivity(list.board_id, null, actorId(req), 'list_unarchived', `a restauré la liste « ${list.name} »`);
  broadcast(list.board_id, { type: 'list', id: list.id });
  res.json({ list: db.prepare('SELECT * FROM lists WHERE id = ?').get(list.id) });
});

app.post('/api/cards', (req, res) => {
  const { list_id, title } = req.body || {};
  const list = getActiveList(Number(list_id));
  if (!list) return notFound(res);
  if (typeof title !== 'string' || !title.trim()) return badReq(res, 'title requis');
  const max = db.prepare('SELECT COALESCE(MAX(pos),0) AS m FROM cards WHERE list_id = ? AND archived = 0').get(list.id).m;
  const pos = 'pos' in req.body && isFiniteNumber(Number(req.body.pos)) ? Number(req.body.pos) : max + 100;
  const r = db.prepare('INSERT INTO cards (list_id, title, pos, created_by) VALUES (?,?,?,?)').run(
    list.id, title.trim(), pos, actorId(req)
  );
  logActivity(list.board_id, r.lastInsertRowid, actorId(req),
    'card_created', `a ajouté cette carte à « ${list.name} »`);
  broadcast(list.board_id, { type: 'card', id: r.lastInsertRowid });
  res.status(201).json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(r.lastInsertRowid) });
});

app.patch('/api/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  const body = req.body || {};
  const updates = [];
  const values = [];
  for (const field of Object.keys(body)) {
    if (!CARD_FIELDS_OK.has(field)) return badReq(res, `champ interdit: ${field}`);
  }
  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim()) return badReq(res, 'title requis');
    updates.push('title = ?'); values.push(body.title.trim());
  }
  if ('description' in body) {
    if (typeof body.description !== 'string') return badReq(res, 'description invalide');
    updates.push('description = ?'); values.push(body.description);
  }
  if ('start_at' in body) {
    if (body.start_at !== null && !(typeof body.start_at === 'string' && START_RE.test(body.start_at))) {
      return badReq(res, 'start_at invalide (AAAA-MM-JJ)');
    }
    updates.push('start_at = ?'); values.push(body.start_at);
  }
  if ('due_at' in body) {
    if (body.due_at !== null && typeof body.due_at !== 'string') return badReq(res, 'due_at invalide');
    updates.push('due_at = ?'); values.push(body.due_at);
  }
  // Le début ne peut pas suivre l'échéance (comparaison au jour près)
  const nextStart = 'start_at' in body ? body.start_at : card.start_at;
  const nextDue = 'due_at' in body ? body.due_at : card.due_at;
  if (nextStart && nextDue && nextStart > String(nextDue).slice(0, 10)) {
    return badReq(res, 'la date de début doit précéder l’échéance');
  }
  if ('due_complete' in body) { updates.push('due_complete = ?'); values.push(body.due_complete ? 1 : 0); }
  if ('due_badged' in body) { updates.push('due_badged = ?'); values.push(body.due_badged ? 1 : 0); }
  if ('cover' in body) {
    if (body.cover !== null && typeof body.cover !== 'string') return badReq(res, 'cover invalide');
    updates.push('cover = ?'); values.push(body.cover);
  }
  if ('pos' in body && isFiniteNumber(Number(body.pos))) { updates.push('pos = ?'); values.push(Number(body.pos)); }
  if (!updates.length) return badReq(res, 'aucun champ');
  db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...values, card.id);
  const boardId = boardOfCard(card);
  if ('due_complete' in body && !!body.due_complete !== !!card.due_complete) {
    logActivity(boardId, card.id, actorId(req), 'due_complete',
      body.due_complete ? 'a marqué l’échéance comme terminée' : 'a marqué l’échéance comme non terminée');
  }
  if ('start_at' in body && body.start_at !== card.start_at) {
    logActivity(boardId, card.id, actorId(req), 'start_changed',
      body.start_at ? `a fixé le début au ${fmtDay(body.start_at)}` : 'a retiré la date de début');
  }
  if ('due_at' in body && body.due_at !== card.due_at) {
    logActivity(boardId, card.id, actorId(req), 'due_changed',
      body.due_at ? `a fixé l’échéance au ${body.due_at.replace('T', ' à ')}` : 'a retiré l’échéance');
  }
  broadcast(boardId, { type: 'card', id: card.id });
  res.json({ card: getCard(card.id) });
});

// Suppression = mise à la corbeille (restauration via /unarchive)
app.delete('/api/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  if (!isAdminReq(req)) return forbidden(res);
  db.prepare('UPDATE cards SET archived = 1 WHERE id = ?').run(card.id);
  const boardId = boardOfCard(card);
  logActivity(boardId, card.id, actorId(req), 'card_archived', 'a mis cette carte à la corbeille');
  broadcast(boardId, { type: 'card', id: card.id });
  res.json({ ok: true });
});

app.post('/api/cards/:id/unarchive', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  db.prepare('UPDATE cards SET archived = 0 WHERE id = ?').run(card.id);
  // Restaurer une carte d'une liste archivée restaure aussi la liste, sinon la carte resterait invisible
  db.prepare('UPDATE lists SET archived = 0 WHERE id = ?').run(card.list_id);
  const boardId = boardOfCard(card);
  logActivity(boardId, card.id, actorId(req), 'card_unarchived', 'a restauré cette carte');
  broadcast(boardId, { type: 'card', id: card.id });
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

app.post('/api/cards/:id/move', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  const body = req.body || {};
  const target = getActiveList(Number(body.list_id));
  if (!target) return notFound(res);
  const pos = isFiniteNumber(Number(body.pos)) ? Number(body.pos) : null;
  if (pos === null) return badReq(res, 'pos requis');
  db.prepare('UPDATE cards SET list_id = ?, pos = ? WHERE id = ?').run(target.id, pos, card.id);
  if (target.id !== card.list_id) {
    const from = db.prepare('SELECT name FROM lists WHERE id = ?').get(card.list_id);
    logActivity(target.board_id, card.id, actorId(req), 'card_moved',
      `a déplacé cette carte de « ${from ? from.name : '?'} » vers « ${target.name} »`);
    notify(card, actorId(req), 'moved', `« ${card.title} » est passée dans « ${target.name} »`);
  }
  broadcast(target.board_id, { type: 'card', id: card.id });
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

app.post('/api/cards/:id/labels', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  const body = req.body || {};
  const list = db.prepare('SELECT board_id FROM lists WHERE id = ?').get(card.list_id);
  if (body.remove !== undefined && body.remove !== null && body.remove !== false) {
    db.prepare('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?').run(card.id, Number(body.label_id));
  } else {
    const label = db.prepare('SELECT * FROM labels WHERE id = ?').get(Number(body.label_id));
    if (!label) return notFound(res);
    db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?,?)').run(card.id, label.id);
  }
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ ok: true });
});

app.post('/api/cards/:id/members', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  const body = req.body || {};
  const list = db.prepare('SELECT board_id FROM lists WHERE id = ?').get(card.list_id);
  if (body.remove !== undefined && body.remove !== null && body.remove !== false) {
    db.prepare('DELETE FROM card_members WHERE card_id = ? AND member_id = ?').run(card.id, Number(body.member_id));
  } else {
    const member = db.prepare("SELECT * FROM members WHERE id = ? AND role != 'guest'").get(Number(body.member_id));
    if (!member) return notFound(res);
    const added = db.prepare('INSERT OR IGNORE INTO card_members (card_id, member_id) VALUES (?,?)').run(card.id, member.id);
    const actor = actorId(req);
    if (added.changes && member.id !== actor) {
      const who = actor ? db.prepare('SELECT name FROM members WHERE id = ?').get(actor).name : 'Quelqu’un';
      db.prepare('INSERT INTO notifications (member_id, board_id, card_id, actor_id, kind, text) VALUES (?,?,?,?,?,?)')
        .run(member.id, list.board_id, card.id, actor, 'assigned', `${who} vous a ajouté à « ${card.title} »`);
      broadcast(list.board_id, { type: 'notification', members: [member.id] });
    }
  }
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ ok: true });
});

/* --------------------------- Détail d'une carte --------------------------- */

app.get('/api/cards/:id', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) return notFound(res);
  const comments = db.prepare(`${COMMENT_SELECT} WHERE co.card_id = ? ORDER BY co.id DESC`).all(card.id);
  const activity = db.prepare(`${ACTIVITY_SELECT} WHERE a.card_id = ? ORDER BY a.id DESC LIMIT 100`).all(card.id);
  res.json({ card, checklists: cardChecklists(card.id), comments, activity, attachments: cardAttachments(card.id) });
});

/* ------------------------------- Checklists ------------------------------- */

function getChecklist(id) {
  return db.prepare('SELECT * FROM checklists WHERE id = ?').get(id);
}
function getCheckItem(id) {
  return db.prepare('SELECT * FROM check_items WHERE id = ?').get(id);
}
function cleanName(v) {
  return typeof v === 'string' ? v.trim() : '';
}

app.post('/api/cards/:id/checklists', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) return notFound(res);
  const name = cleanName(req.body && req.body.name) || 'Checklist';
  const r = db.prepare('INSERT INTO checklists (card_id, name, pos) VALUES (?,?,?)')
    .run(card.id, name, nextPos('checklists', 'card_id', card.id));
  const boardId = boardOfCard(card);
  logActivity(boardId, card.id, actorId(req), 'checklist_added', `a ajouté la checklist « ${name} »`);
  broadcast(boardId, { type: 'card', id: card.id });
  res.status(201).json({ checklist: { ...getChecklist(r.lastInsertRowid), items: [] } });
});

app.patch('/api/checklists/:id', (req, res) => {
  const cl = getChecklist(req.params.id);
  if (!cl) return notFound(res);
  const name = cleanName(req.body && req.body.name);
  if (!name) return badReq(res, 'name requis');
  db.prepare('UPDATE checklists SET name = ? WHERE id = ?').run(name, cl.id);
  broadcast(boardOfCard(getCard(cl.card_id)), { type: 'card', id: cl.card_id });
  res.json({ checklist: getChecklist(cl.id) });
});

app.delete('/api/checklists/:id', (req, res) => {
  const cl = getChecklist(req.params.id);
  if (!cl) return notFound(res);
  const boardId = boardOfCard(getCard(cl.card_id));
  db.prepare('DELETE FROM checklists WHERE id = ?').run(cl.id);
  logActivity(boardId, cl.card_id, actorId(req), 'checklist_removed', `a supprimé la checklist « ${cl.name} »`);
  broadcast(boardId, { type: 'card', id: cl.card_id });
  res.json({ ok: true });
});

app.post('/api/checklists/:id/items', (req, res) => {
  const cl = getChecklist(req.params.id);
  if (!cl) return notFound(res);
  const name = cleanName(req.body && req.body.name);
  if (!name) return badReq(res, 'name requis');
  const r = db.prepare('INSERT INTO check_items (checklist_id, name, pos) VALUES (?,?,?)')
    .run(cl.id, name, nextPos('check_items', 'checklist_id', cl.id));
  broadcast(boardOfCard(getCard(cl.card_id)), { type: 'card', id: cl.card_id });
  const item = getCheckItem(r.lastInsertRowid);
  res.status(201).json({ item: { ...item, checked: !!item.checked } });
});

app.patch('/api/checkitems/:id', (req, res) => {
  const item = getCheckItem(req.params.id);
  if (!item) return notFound(res);
  const body = req.body || {};
  const updates = [];
  const values = [];
  if ('name' in body) {
    const name = cleanName(body.name);
    if (!name) return badReq(res, 'name requis');
    updates.push('name = ?'); values.push(name);
  }
  if ('checked' in body) { updates.push('checked = ?'); values.push(body.checked ? 1 : 0); }
  if ('pos' in body && isFiniteNumber(Number(body.pos))) { updates.push('pos = ?'); values.push(Number(body.pos)); }
  let assignee = null;
  if ('assignee_id' in body) {
    if (body.assignee_id !== null) {
      assignee = db.prepare("SELECT id, name FROM members WHERE id = ? AND role != 'guest'").get(Number(body.assignee_id));
      if (!assignee) return badReq(res, 'assignee_id inconnu');
    }
    updates.push('assignee_id = ?'); values.push(assignee ? assignee.id : null);
  }
  if (!updates.length) return badReq(res, 'aucun champ');
  db.prepare(`UPDATE check_items SET ${updates.join(', ')} WHERE id = ?`).run(...values, item.id);
  const cl = getChecklist(item.checklist_id);
  const boardId = boardOfCard(getCard(cl.card_id));
  if ('checked' in body && !!body.checked !== !!item.checked) {
    logActivity(boardId, cl.card_id, actorId(req), body.checked ? 'item_checked' : 'item_unchecked',
      body.checked ? `a terminé « ${item.name} »` : `a décoché « ${item.name} »`);
  }
  if ('assignee_id' in body && (assignee ? assignee.id : null) !== item.assignee_id) {
    logActivity(boardId, cl.card_id, actorId(req), 'item_assigned',
      assignee ? `a confié « ${item.name} » à ${assignee.name}` : `a retiré l’attribution de « ${item.name} »`);
    if (assignee && assignee.id !== actorId(req)) {
      const card = getCard(cl.card_id);
      db.prepare('INSERT INTO notifications (member_id, board_id, card_id, actor_id, kind, text) VALUES (?,?,?,?,?,?)')
        .run(assignee.id, boardId, card.id, actorId(req), 'item_assigned',
          `${req.member.name} vous a confié « ${item.name} » sur « ${card.title} »`);
      broadcast(boardId, { type: 'notification', members: [assignee.id] });
    }
  }
  broadcast(boardId, { type: 'card', id: cl.card_id });
  const fresh = getCheckItem(item.id);
  res.json({ item: { ...fresh, checked: !!fresh.checked } });
});

app.delete('/api/checkitems/:id', (req, res) => {
  const item = getCheckItem(req.params.id);
  if (!item) return notFound(res);
  const cl = getChecklist(item.checklist_id);
  db.prepare('DELETE FROM check_items WHERE id = ?').run(item.id);
  broadcast(boardOfCard(getCard(cl.card_id)), { type: 'card', id: cl.card_id });
  res.json({ ok: true });
});

/* ------------------------------- Commentaires ------------------------------ */

function getComment(id) {
  return db.prepare(`${COMMENT_SELECT} WHERE co.id = ?`).get(id);
}

app.post('/api/cards/:id/comments', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) return notFound(res);
  const text = cleanName(req.body && req.body.text);
  if (!text) return badReq(res, 'text requis');
  const author = actorId(req);
  const r = db.prepare('INSERT INTO comments (card_id, member_id, text) VALUES (?,?,?)').run(card.id, author, text);
  const authorName = author ? db.prepare('SELECT name FROM members WHERE id = ?').get(author).name : 'Quelqu’un';
  const mentions = mentionedMembers(text);
  const excerpt = text.length > 80 ? text.slice(0, 79) + '…' : text;
  for (const id of mentions) {
    if (id === author) continue;
    db.prepare('INSERT INTO notifications (member_id, board_id, card_id, actor_id, kind, text) VALUES (?,?,?,?,?,?)')
      .run(id, boardOfCard(card), card.id, author, 'mention', `${authorName} vous a mentionné sur « ${card.title} » : ${excerpt}`);
  }
  // Les membres déjà mentionnés ne reçoivent pas une 2e notification
  const others = db.prepare('SELECT member_id FROM card_members WHERE card_id = ?').all(card.id)
    .map((x) => x.member_id).filter((id) => !mentions.includes(id));
  if (others.length || mentions.length) {
    const ins = db.prepare('INSERT INTO notifications (member_id, board_id, card_id, actor_id, kind, text) VALUES (?,?,?,?,?,?)');
    for (const id of others) if (id !== author) ins.run(id, boardOfCard(card), card.id, author, 'comment', `${authorName} a commenté « ${card.title} » : ${excerpt}`);
    broadcast(boardOfCard(card), { type: 'notification' });
  }
  broadcast(boardOfCard(card), { type: 'card', id: card.id });
  res.status(201).json({ comment: getComment(r.lastInsertRowid) });
});

// Seul l'auteur modifie ; l'auteur ou l'administrateur (membre 1) supprime
app.patch('/api/comments/:id', (req, res) => {
  const co = getComment(req.params.id);
  if (!co) return notFound(res);
  const text = cleanName(req.body && req.body.text);
  if (!text) return badReq(res, 'text requis');
  if (actorId(req) !== co.member_id) return res.status(403).json({ error: 'forbidden' });
  db.prepare("UPDATE comments SET text = ?, edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(text, co.id);
  broadcast(boardOfCard(getCard(co.card_id)), { type: 'card', id: co.card_id });
  res.json({ comment: getComment(co.id) });
});

app.delete('/api/comments/:id', (req, res) => {
  const co = getComment(req.params.id);
  if (!co) return notFound(res);
  const who = actorId(req);
  if (who !== co.member_id && who !== ADMIN_ID) return forbidden(res);
  db.prepare('DELETE FROM comments WHERE id = ?').run(co.id);
  broadcast(boardOfCard(getCard(co.card_id)), { type: 'card', id: co.card_id });
  res.json({ ok: true });
});

/* ------------------------------ Pièces jointes ----------------------------- */

function getAttachment(id) {
  return db.prepare(`
    SELECT a.id, a.card_id, a.member_id, a.kind, a.name, a.url, a.mime, a.size, a.stored, a.created_at,
           m.name AS member_name
    FROM attachments a LEFT JOIN members m ON m.id = a.member_id WHERE a.id = ?`).get(id);
}

function publicAttachment(a) {
  const { stored, ...rest } = a;
  return { ...rest, previewable: a.kind === 'file' && INLINE_TYPES.has(a.mime) };
}

function cardAttachments(cardId) {
  return db.prepare('SELECT id FROM attachments WHERE card_id = ? ORDER BY id DESC').all(cardId)
    .map((r) => publicAttachment(getAttachment(r.id)));
}

// Fichier : corps brut (Content-Type du fichier) + nom dans X-File-Name (encodeURIComponent).
// Lien : JSON { url, name? } — http(s) uniquement.
app.post('/api/cards/:id/attachments',
  express.raw({ type: (req) => !req.is('application/json'), limit: MAX_UPLOAD }),
  (req, res) => {
    const card = getCard(req.params.id);
    if (!card) return notFound(res);
    const author = actorId(req);
    let id;
    if (req.is('application/json')) {
      const raw = typeof req.body.url === 'string' ? req.body.url.trim() : '';
      let url;
      try { url = new URL(raw); } catch { return badReq(res, 'url invalide'); }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return badReq(res, 'url http(s) requise');
      const name = cleanName(req.body.name) || url.hostname + (url.pathname === '/' ? '' : url.pathname);
      id = db.prepare("INSERT INTO attachments (card_id, member_id, kind, name, url) VALUES (?,?,'link',?,?)")
        .run(card.id, author, name.slice(0, 200), url.href).lastInsertRowid;
    } else {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return badReq(res, 'fichier vide');
      const used = db.prepare("SELECT COALESCE(SUM(size),0) AS n FROM attachments WHERE kind = 'file'").get().n;
      if (used + req.body.length > UPLOAD_QUOTA) return res.status(507).json({ error: 'quota_exceeded' });
      let name = '';
      try { name = decodeURIComponent(req.get('X-File-Name') || ''); } catch { /* nom illisible */ }
      name = path.basename(name.replace(/\\/g, '/')).trim().slice(0, 200) || 'fichier';
      const mime = (req.get('Content-Type') || 'application/octet-stream').split(';')[0].trim().toLowerCase();
      const stored = crypto.randomBytes(16).toString('hex');
      fs.writeFileSync(path.join(UPLOAD_DIR, stored), req.body);
      id = db.prepare("INSERT INTO attachments (card_id, member_id, kind, name, mime, size, stored) VALUES (?,?,'file',?,?,?,?)")
        .run(card.id, author, name, mime, req.body.length, stored).lastInsertRowid;
    }
    const a = getAttachment(id);
    const boardId = boardOfCard(card);
    logActivity(boardId, card.id, author, 'attachment_added', `a joint « ${a.name} »`);
    broadcast(boardId, { type: 'card', id: card.id });
    res.status(201).json({ attachment: publicAttachment(a) });
  });

app.get('/api/attachments/:id/file', (req, res) => {
  const a = getAttachment(req.params.id);
  if (!a || a.kind !== 'file') return notFound(res);
  const file = path.join(UPLOAD_DIR, a.stored);
  if (!fs.existsSync(file)) return notFound(res);
  const inline = INLINE_TYPES.has(a.mime) && req.query.download !== '1';
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Content-Type', inline ? a.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(a.name)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  fs.createReadStream(file).pipe(res);
});

// L'auteur ou l'administrateur (membre 1) supprime
app.delete('/api/attachments/:id', (req, res) => {
  const a = getAttachment(req.params.id);
  if (!a) return notFound(res);
  const who = actorId(req);
  if (who !== a.member_id && who !== ADMIN_ID) return forbidden(res);
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  if (a.stored) fs.rmSync(path.join(UPLOAD_DIR, a.stored), { force: true });
  const card = getCard(a.card_id);
  const boardId = boardOfCard(card);
  logActivity(boardId, card.id, who, 'attachment_removed', `a retiré « ${a.name} »`);
  broadcast(boardId, { type: 'card', id: card.id });
  res.json({ ok: true });
});

/* ---------------------------------- Votes ---------------------------------- */

app.post('/api/cards/:id/votes', (req, res) => {
  const card = getCard(req.params.id);
  if (!card) return notFound(res);
  const who = actorId(req);
  if (req.body && req.body.remove) {
    db.prepare('DELETE FROM card_votes WHERE card_id = ? AND member_id = ?').run(card.id, who);
  } else {
    db.prepare('INSERT OR IGNORE INTO card_votes (card_id, member_id) VALUES (?,?)').run(card.id, who);
  }
  broadcast(boardOfCard(card), { type: 'card', id: card.id });
  const voters = db.prepare('SELECT member_id FROM card_votes WHERE card_id = ? ORDER BY member_id').all(card.id).map((v) => v.member_id);
  res.json({ voters });
});

/* ------------------------------ Copie de carte ----------------------------- */

// Copie : titre, description, couverture, échéance ; options : étiquettes, membres, checklists
app.post('/api/cards/:id/copy', (req, res) => {
  const src = getCard(req.params.id);
  if (!src) return notFound(res);
  const body = req.body || {};
  const target = getActiveList(body.list_id == null ? src.list_id : Number(body.list_id));
  if (!target) return notFound(res);
  const title = cleanName(body.title) || src.title;
  const keep = { labels: true, members: true, checklists: true, ...(body.keep || {}) };
  const author = actorId(req);
  const copy = db.transaction(() => {
    let pos;
    if (target.id === src.list_id) { // juste sous l'original
      const next = db.prepare('SELECT MIN(pos) AS p FROM cards WHERE list_id = ? AND archived = 0 AND pos > ?').get(src.list_id, src.pos).p;
      pos = next == null ? src.pos + 100 : (src.pos + next) / 2;
    } else {
      pos = nextPos('cards', 'list_id', target.id);
    }
    const r = db.prepare(`INSERT INTO cards (list_id, title, description, pos, cover, start_at, due_at, due_complete, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(target.id, title, src.description, pos, src.cover, src.start_at, src.due_at, src.due_complete, author);
    const id = r.lastInsertRowid;
    if (keep.labels) db.prepare('INSERT INTO card_labels (card_id, label_id) SELECT ?, label_id FROM card_labels WHERE card_id = ?').run(id, src.id);
    if (keep.members) db.prepare('INSERT INTO card_members (card_id, member_id) SELECT ?, member_id FROM card_members WHERE card_id = ?').run(id, src.id);
    if (keep.checklists) {
      for (const cl of cardChecklists(src.id)) {
        const c = db.prepare('INSERT INTO checklists (card_id, name, pos) VALUES (?,?,?)').run(id, cl.name, cl.pos);
        const ins = db.prepare('INSERT INTO check_items (checklist_id, name, pos, checked) VALUES (?,?,?,?)');
        for (const it of cl.items) ins.run(c.lastInsertRowid, it.name, it.pos, it.checked ? 1 : 0);
      }
    }
    logActivity(target.board_id, id, author, 'card_copied', `a copié cette carte depuis « ${src.title} »`);
    return id;
  })();
  broadcast(target.board_id, { type: 'card', id: copy });
  res.status(201).json({ card: getCard(copy) });
});

/* ------------------------------ Notifications ------------------------------ */

// Chacun ne lit et n'acquitte que ses propres notifications
app.get('/api/members/:id/notifications', (req, res) => {
  const member = db.prepare('SELECT id FROM members WHERE id = ?').get(req.params.id);
  if (!member) return notFound(res);
  if (member.id !== actorId(req)) return forbidden(res);
  const rows = db.prepare(`
    SELECT n.id, n.board_id, n.card_id, n.kind, n.text, n.read, n.created_at, n.actor_id,
           m.initials AS actor_initials, m.color AS actor_color
    FROM notifications n LEFT JOIN members m ON m.id = n.actor_id
    WHERE n.member_id = ? ORDER BY n.id DESC LIMIT 30`).all(member.id).map((n) => ({ ...n, read: !!n.read }));
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read = 0').get(member.id).n;
  res.json({ unread, notifications: rows });
});

// Marque lues : toutes, ou seulement les ids fournis
app.post('/api/members/:id/notifications/read', (req, res) => {
  const member = db.prepare('SELECT id FROM members WHERE id = ?').get(req.params.id);
  if (!member) return notFound(res);
  if (member.id !== actorId(req)) return forbidden(res);
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : null;
  if (ids && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET read = 1 WHERE member_id = ? AND id = ?');
    db.transaction(() => { for (const id of ids) stmt.run(member.id, id); })();
  } else {
    db.prepare('UPDATE notifications SET read = 1 WHERE member_id = ?').run(member.id);
  }
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE member_id = ? AND read = 0').get(member.id).n;
  res.json({ unread });
});

/* ------------------------------- Mes cartes -------------------------------- */

// Cartes de tous les tableaux où je suis membre ou titulaire d'un élément de checklist non coché
app.get('/api/me/cards', (req, res) => {
  const me = actorId(req);
  const rows = db.prepare(`
    SELECT c.id, c.title, c.start_at, c.due_at, c.due_complete, c.cover, l.id AS list_id, l.name AS list_name,
           b.id AS board_id, b.name AS board_name,
           EXISTS (SELECT 1 FROM card_members cm WHERE cm.card_id = c.id AND cm.member_id = @me) AS is_member
    FROM cards c JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = l.board_id
    WHERE c.archived = 0 AND l.archived = 0 AND (
      EXISTS (SELECT 1 FROM card_members cm WHERE cm.card_id = c.id AND cm.member_id = @me)
      OR EXISTS (SELECT 1 FROM checklists k JOIN check_items ci ON ci.checklist_id = k.id
                 WHERE k.card_id = c.id AND ci.assignee_id = @me AND ci.checked = 0))
    ORDER BY c.due_at IS NULL, c.due_at, b.id, l.pos, c.pos`).all({ me });
  const itemsStmt = db.prepare(`
    SELECT ci.id, ci.name FROM checklists k JOIN check_items ci ON ci.checklist_id = k.id
    WHERE k.card_id = ? AND ci.assignee_id = ? AND ci.checked = 0 ORDER BY k.pos, ci.pos`);
  res.json({
    cards: rows.map((r) => ({ ...r, is_member: !!r.is_member, due_complete: !!r.due_complete, my_items: itemsStmt.all(r.id, me) }))
  });
});

/* -------------------------------- Export CSV -------------------------------- */

// Une ligne par carte active ; « ; » et BOM UTF-8 pour Excel en français. Les cellules qui commencent
// par = + - @ sont préfixées d'une apostrophe (pas d'exécution de formule à l'ouverture).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

app.get('/api/board/:id/export.csv', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const cards = db.prepare(`
    SELECT c.*, l.name AS list_name FROM cards c JOIN lists l ON l.id = c.list_id
    WHERE l.board_id = ? AND l.archived = 0 AND c.archived = 0 ORDER BY l.pos, c.pos`).all(board.id);
  const q = {
    labels: db.prepare('SELECT l.name FROM card_labels cl JOIN labels l ON l.id = cl.label_id WHERE cl.card_id = ? ORDER BY l.id'),
    members: db.prepare('SELECT m.name FROM card_members cm JOIN members m ON m.id = cm.member_id WHERE cm.card_id = ? ORDER BY m.id'),
    check: db.prepare(`SELECT COUNT(ci.id) AS total, COALESCE(SUM(ci.checked),0) AS done
      FROM checklists k JOIN check_items ci ON ci.checklist_id = k.id WHERE k.card_id = ?`),
    comments: db.prepare('SELECT COUNT(*) AS n FROM comments WHERE card_id = ?'),
    attachments: db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE card_id = ?'),
    votes: db.prepare('SELECT COUNT(*) AS n FROM card_votes WHERE card_id = ?')
  };
  const head = ['Liste', 'Titre', 'Description', 'Début', 'Échéance', 'Échéance terminée', 'Étiquettes', 'Membres',
    'Checklist', 'Commentaires', 'Pièces jointes', 'Votes', 'Créée le'];
  const lines = [head.map(csvCell).join(';')];
  for (const c of cards) {
    const ck = q.check.get(c.id);
    lines.push([
      c.list_name, c.title, c.description, c.start_at, c.due_at ? c.due_at.replace('T', ' ') : '',
      c.due_at ? (c.due_complete ? 'oui' : 'non') : '',
      q.labels.all(c.id).map((r) => r.name).join(', '), q.members.all(c.id).map((r) => r.name).join(', '),
      ck.total ? `${ck.done}/${ck.total}` : '', q.comments.get(c.id).n, q.attachments.get(c.id).n, q.votes.get(c.id).n,
      String(c.created_at).slice(0, 10)
    ].map(csvCell).join(';'));
  }
  const slug = board.name.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'tableau';
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="la-boite-${slug}.csv"`);
  res.send('﻿' + lines.join('\r\n') + '\r\n');
});

/* ------------------------------ Activité tableau --------------------------- */

app.get('/api/board/:id/activity', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db.prepare(`${ACTIVITY_SELECT} WHERE a.board_id = ? ORDER BY a.id DESC LIMIT ?`).all(board.id, limit);
  res.json({ activity: rows });
});

// Recherche : titre | description | label | membre | commentaire | élément de checklist (cartes actives du tableau)
app.get('/api/board/:id/search', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!q) return res.json({ results: [] });
  const like = `%${q}%`;
  const rows = db.prepare(`
    SELECT DISTINCT c.id, c.list_id, c.title, c.description, c.pos, c.cover, c.due_at, c.due_complete
    FROM cards c
    JOIN lists l ON l.id = c.list_id
    LEFT JOIN card_labels cl ON cl.card_id = c.id
    LEFT JOIN labels la ON la.id = cl.label_id
    LEFT JOIN card_members cm ON cm.card_id = c.id
    LEFT JOIN members me ON me.id = cm.member_id
    WHERE l.board_id = ? AND c.archived = 0 AND l.archived = 0
      AND (c.title LIKE ? OR c.description LIKE ? OR la.name LIKE ? OR me.name LIKE ? OR me.initials LIKE ?
        OR EXISTS (SELECT 1 FROM comments co WHERE co.card_id = c.id AND co.text LIKE ?)
        OR EXISTS (SELECT 1 FROM checklists ck JOIN check_items ci ON ci.checklist_id = ck.id
                   WHERE ck.card_id = c.id AND ci.name LIKE ?))
    ORDER BY c.pos LIMIT 100`).all(
    board.id, like, like, like, like, like, like, like
  );
  res.json({ results: rows });
});

// SSE (doit être monté après les autres /api/board/:id pour ne pas capter la route)
app.get('/api/board/:id/events', sseHandshake);

app.use('/api', (_req, res) => notFound(res));

/* ------------------------------ Statique ----------------------------- */

const PUB = path.join(__dirname, 'public');
app.use(express.static(PUB, {
  setHeaders(res, filePath) {
    if (/(^|\/)(index\.html|sw\.js|manifest\.webmanifest)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
app.get('*', (_req, res) => res.sendFile(path.join(PUB, 'index.html')));

// Dernier recours : erreur JSON (jamais de page HTML pour l'API)
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large' });
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`La Boîte écoute sur http://localhost:${PORT} (db: ${DB_PATH}${IS_TEST ? ', test' : ''})`);
});