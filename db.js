// db.js — « La Boîte » : schéma + seed SQLite (better-sqlite3, WAL)
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS boards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  background TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  pos REAL NOT NULL,
  wip_limit INTEGER,
  collapsed INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  pos REAL NOT NULL,
  cover TEXT,
  due_at TEXT,
  due_complete INTEGER NOT NULL DEFAULT 0,
  due_badged INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_by INTEGER
);
CREATE TABLE IF NOT EXISTS labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_labels (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, label_id)
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  initials TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS card_members (
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (card_id, member_id)
);
CREATE INDEX IF NOT EXISTS idx_lists_board ON lists(board_id);
CREATE INDEX IF NOT EXISTS idx_cards_list ON cards(list_id);
CREATE INDEX IF NOT EXISTS idx_cards_archived ON cards(archived);
`;

// Dégradés de fond *originaux* (habillage maison, famille bleu profond → vert, thème #22577a)
const BACKGROUNDS = [
  'linear-gradient(135deg,#16324f 0%,#22577a 38%,#2f8f83 72%,#5aa97b 100%)',
  'linear-gradient(160deg,#232a5c 0%,#2d547c 45%,#38a3a5 100%)',
  'linear-gradient(140deg,#3a1f4d 0%,#6b3d6e 50%,#a2637c 100%)',
  'linear-gradient(150deg,#1f2937 0%,#33526b 55%,#59886f 100%)'
];

function seed(db) {
  const tx = db.transaction(() => {
    const now = new Date().toISOString();
    const board = db
      .prepare('INSERT INTO boards (name, background, created_at) VALUES (?,?,?)')
      .run('Projet démo', BACKGROUNDS[0], now);

    const lists = [
      ['À faire', 100],
      ['En cours', 200],
      ['À valider', 300],
      ['À livrer', 400]
    ];
    const listIds = {};
    for (const [name, pos] of lists) {
      const r = db
        .prepare('INSERT INTO lists (board_id, name, pos, wip_limit) VALUES (?,?,?,10)')
        .run(board.lastInsertRowid, name, pos);
      listIds[name] = r.lastInsertRowid;
    }

    const labels = [
      ['Urgent', '#d0453f'],
      ['Normal', '#df8a3c'],
      ['À revoir', '#4d9e69']
    ];
    const labelIds = {};
    for (const [name, color] of labels) {
      const r = db
        .prepare('INSERT INTO labels (board_id, name, color) VALUES (?,?,?)')
        .run(board.lastInsertRowid, name, color);
      labelIds[name] = r.lastInsertRowid;
    }

    const members = [
      ['Laurent', 'LH', '#22577a'],
      ['Marina', 'MB', '#b04a7e'],
      ['Noémie', 'NP', '#c07a2d'],
      ['Julia', 'JU', '#3f8f66']
    ];
    const memberIds = {};
    for (const [name, initials, color] of members) {
      const r = db
        .prepare('INSERT INTO members (name, initials, color) VALUES (?,?,?)')
        .run(name, initials, color);
      memberIds[name] = r.lastInsertRowid;
    }

    // Cartes de démonstration — 2 dans la première liste pour le badge « 2/10 »
    const cards = [
      ['À faire', 'Cadrer le premier prototype', 'Lister les écrans utiles et les règles de déplacement.', 100, null, null, 0, [labelIds['Normal']], [memberIds['Laurent']]],
      ['À faire', 'Choisir la palette du tableau', 'Trois dégradés candidats, à voter en équipe.', 200, '#5aa97b', null, 0, [], [memberIds['Marina']]],
      ['En cours', 'Maquette de la liste mobile', 'Repli vertical et badge d’effort.', 100, '#df8a3c', null, 0, [labelIds['Urgent']], [memberIds['Noémie']]],
      ['En cours', 'Préparer la revue', '', 200, null, null, 0, [], []],
      ['À valider', 'Relire les règles d’archivage', 'La corbeille doit permettre la restauration.', 100, null, '2026-01-15T09:00', 0, [labelIds['À revoir']], [memberIds['Julia']]],
      ['À livrer', 'Publier l’annonce', '', 100, null, null, 0, [], [memberIds['Laurent']]]
    ];
    const insCard = db.prepare(
      'INSERT INTO cards (list_id, title, description, pos, cover, due_at, due_complete, created_at, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const insCardLabel = db.prepare('INSERT OR IGNORE INTO card_labels (card_id, label_id) VALUES (?,?)');
    const insCardMember = db.prepare('INSERT OR IGNORE INTO card_members (card_id, member_id) VALUES (?,?)');
    for (const [listName, title, desc, pos, cover, dueAt, dueComplete, labelRefs, memberRefs] of cards) {
      const r = insCard.run(
        listIds[listName], title, desc, pos, cover, dueAt, dueComplete, now, memberIds['Laurent']
      );
      for (const l of labelRefs) insCardLabel.run(r.lastInsertRowid, l);
      for (const m of memberRefs) insCardMember.run(r.lastInsertRowid, m);
    }
    return board.lastInsertRowid;
  });
  return tx();
}

function open(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

/** Instancie la base (fichier + WAL) et sème les données de démonstration si vide. */
function init(dbPath) {
  const db = open(dbPath);
  const hasBoard = db.prepare('SELECT COUNT(*) AS n FROM boards').get().n > 0;
  if (!hasBoard) seed(db);
  return db;
}

module.exports = { init, seed, open, BACKGROUNDS };