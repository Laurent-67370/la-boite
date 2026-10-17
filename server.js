// server.js — « La Boîte » : API REST + SSE + statique (vanilla front)
'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { init, BACKGROUNDS } = require('./db');

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

const app = express();
app.disable('x-powered-by');
app.use(express.json());

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
  return db.prepare('SELECT id, name, background, created_at FROM boards WHERE id = ?').get(id);
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

const CARD_FIELDS_OK = new Set(['title', 'description', 'due_at', 'due_complete', 'cover', 'pos', 'due_badged']);

/* -------------------------------- API ------------------------------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Tableau complet : board + listes (chacune avec ses cartes actives) + labels + membres + corbeille
app.get('/api/board/:id', (req, res) => {
  const board = getBoard(req.params.id);
  if (!board) return notFound(res);
  const lists = db
    .prepare('SELECT id, board_id, name, pos, wip_limit, collapsed FROM lists WHERE board_id = ? ORDER BY pos')
    .all(board.id);
  const labelStmt = db.prepare(`
    SELECT l.id, l.name, l.color FROM card_labels cl JOIN labels l ON l.id = cl.label_id
    WHERE cl.card_id = ? ORDER BY l.id`);
  const memberStmt = db.prepare(`
    SELECT m.id, m.name, m.initials, m.color FROM card_members cm JOIN members m ON m.id = cm.member_id
    WHERE cm.card_id = ? ORDER BY m.id`);
  const cardStmt = db.prepare(`
    SELECT c.id, c.list_id, c.title, c.description, c.pos, c.cover, c.due_at, c.due_complete, c.due_badged,
           c.archived, c.created_at, c.created_by
    FROM cards c WHERE c.list_id = ? AND c.archived = 0 ORDER BY c.pos`);
  for (const list of lists) {
    list.cards = cardStmt.all(list.id).map((c) => {
      c.labels = labelStmt.all(c.id);
      c.members = memberStmt.all(c.id);
      c.due_complete = !!c.due_complete;
      c.archived = !!c.archived;
      c.due_badged = !!c.due_badged;
      return c;
    });
  }
  const labels = db.prepare('SELECT id, name, color FROM labels WHERE board_id = ? ORDER BY id').all(board.id);
  const members = db.prepare('SELECT id, name, initials, color FROM members ORDER BY id').all();
  const archived = db.prepare(`
    SELECT c.id, c.list_id, c.title, c.archived FROM cards c
    JOIN lists l ON l.id = c.list_id
    WHERE l.board_id = ? AND c.archived = 1 ORDER BY c.id DESC`).all(board.id);
  res.json({ board, lists, labels, members, archived });
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
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim()) return badReq(res, 'name requis');
  db.prepare('UPDATE boards SET name = ? WHERE id = ?').run(name.trim(), board.id);
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

app.delete('/api/lists/:id', (req, res) => {
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(req.params.id);
  if (!list) return notFound(res);
  db.prepare('UPDATE cards SET archived = 1 WHERE list_id = ?').run(list.id);
  db.prepare('DELETE FROM lists WHERE id = ?').run(list.id);
  broadcast(list.board_id, { type: 'list', id: list.id });
  res.json({ ok: true });
});

app.post('/api/cards', (req, res) => {
  const { list_id, title, created_by } = req.body || {};
  const list = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(list_id));
  if (!list) return notFound(res);
  if (typeof title !== 'string' || !title.trim()) return badReq(res, 'title requis');
  const max = db.prepare('SELECT COALESCE(MAX(pos),0) AS m FROM cards WHERE list_id = ? AND archived = 0').get(list.id).m;
  const pos = 'pos' in req.body && isFiniteNumber(Number(req.body.pos)) ? Number(req.body.pos) : max + 100;
  const r = db.prepare('INSERT INTO cards (list_id, title, pos, created_by) VALUES (?,?,?,?)').run(
    list.id, title.trim(), pos, created_by == null ? null : Number(created_by)
  );
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
  if ('due_at' in body) {
    if (body.due_at !== null && typeof body.due_at !== 'string') return badReq(res, 'due_at invalide');
    updates.push('due_at = ?'); values.push(body.due_at);
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
  const list = db.prepare('SELECT board_id FROM lists WHERE id = ?').get(card.list_id);
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

// Suppression = mise à la corbeille (restauration via /unarchive)
app.delete('/api/cards/:id', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  db.prepare('UPDATE cards SET archived = 1 WHERE id = ?').run(card.id);
  const list = db.prepare('SELECT board_id FROM lists WHERE id = ?').get(card.list_id);
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ ok: true });
});

app.post('/api/cards/:id/unarchive', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  db.prepare('UPDATE cards SET archived = 0 WHERE id = ?').run(card.id);
  const list = db.prepare('SELECT board_id FROM lists WHERE id = ?').get(card.list_id);
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ card: db.prepare('SELECT * FROM cards WHERE id = ?').get(card.id) });
});

app.post('/api/cards/:id/move', (req, res) => {
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(req.params.id);
  if (!card) return notFound(res);
  const body = req.body || {};
  const target = db.prepare('SELECT * FROM lists WHERE id = ?').get(Number(body.list_id));
  if (!target) return notFound(res);
  const pos = isFiniteNumber(Number(body.pos)) ? Number(body.pos) : null;
  if (pos === null) return badReq(res, 'pos requis');
  db.prepare('UPDATE cards SET list_id = ?, pos = ? WHERE id = ?').run(target.id, pos, card.id);
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
    const member = db.prepare('SELECT * FROM members WHERE id = ?').get(Number(body.member_id));
    if (!member) return notFound(res);
    db.prepare('INSERT OR IGNORE INTO card_members (card_id, member_id) VALUES (?,?)').run(card.id, member.id);
  }
  broadcast(list.board_id, { type: 'card', id: card.id });
  res.json({ ok: true });
});

// Recherche : titre | description | label | membre (cartes actives du tableau)
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
    WHERE l.board_id = ? AND c.archived = 0
      AND (c.title LIKE ? OR c.description LIKE ? OR la.name LIKE ? OR me.name LIKE ? OR me.initials LIKE ?)
    ORDER BY c.pos LIMIT 100`).all(
    board.id, like, like, like, like, like
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
  console.error(err);
  res.status(500).json({ error: 'server_error' });
});

app.listen(PORT, () => {
  console.log(`La Boîte écoute sur http://localhost:${PORT} (db: ${DB_PATH}${IS_TEST ? ', test' : ''})`);
});