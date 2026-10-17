#!/usr/bin/env node
// scripts/backup.cjs — sauvegarde cohérente de La Boîte : base SQLite + fichiers joints, avec rotation.
//   node scripts/backup.cjs [--dest DIR] [--keep-days 14] [--db FICHIER] [--uploads DIR]
// Défauts : DB = data.db et UPLOADS = uploads/ à côté de server.js ; DEST = $LA_BOITE_BACKUP_DIR ou backups/.
// La base est copiée par l'API de sauvegarde en ligne de SQLite (cohérente même en WAL, service actif),
// jamais par un simple cp. Chaque sauvegarde est écrite dans un dossier temporaire puis renommée :
// un dossier la-boite-<horodatage> présent est toujours complet.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const PREFIX = 'la-boite-';

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1], i++;
  }
  return out;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// 2026-10-17T21:05:03.123Z → 20261017T210503123Z (tri lexicographique = tri chronologique ;
// millisecondes pour que deux sauvegardes rapprochées ne se percutent pas)
function stamp(d) {
  return d.toISOString().replace(/[-:.]/g, '');
}

function parseStamp(name) {
  const m = /^la-boite-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z$/.exec(name);
  return m ? Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || 0)) : null;
}

function rotate(dest, keepDays, now) {
  const all = fs.readdirSync(dest).filter((n) => parseStamp(n) !== null).sort();
  const latest = all[all.length - 1];
  const removed = [];
  for (const name of all) {
    if (name === latest) continue; // jamais la plus récente
    if (now - parseStamp(name) > keepDays * 86400 * 1000) {
      fs.rmSync(path.join(dest, name), { recursive: true, force: true });
      removed.push(name);
    }
  }
  // Restes d'une sauvegarde interrompue
  for (const n of fs.readdirSync(dest)) if (n.startsWith('.tmp-')) fs.rmSync(path.join(dest, n), { recursive: true, force: true });
  return removed;
}

async function main() {
  const a = args(process.argv.slice(2));
  const dbPath = path.resolve(a.db || process.env.DB || path.join(ROOT, 'data.db'));
  const uploads = path.resolve(a.uploads || process.env.UPLOADS || path.join(ROOT, 'uploads'));
  const dest = path.resolve(a.dest || process.env.LA_BOITE_BACKUP_DIR || path.join(ROOT, 'backups'));
  const keepDays = Number(a['keep-days'] || process.env.LA_BOITE_BACKUP_KEEP_DAYS || 14);
  if (!fs.existsSync(dbPath)) throw new Error(`base introuvable : ${dbPath}`);
  if (!(keepDays > 0)) throw new Error('--keep-days doit être > 0');

  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  const now = new Date();
  const name = PREFIX + stamp(now);
  const tmp = path.join(dest, `.tmp-${name}-${process.pid}`);
  fs.mkdirSync(tmp, { mode: 0o700 });

  // 1. Base : sauvegarde en ligne SQLite, puis contrôle d'intégrité de la copie
  const src = new Database(dbPath, { readonly: true, fileMustExist: true });
  await src.backup(path.join(tmp, 'data.db'));
  src.close();
  // La copie hérite du mode WAL : on la repasse en journal classique pour qu'elle tienne en un seul
  // fichier autonome (pas de data.db-wal/-shm créés à l'ouverture). Le serveur remet WAL au démarrage.
  const rw = new Database(path.join(tmp, 'data.db'));
  rw.pragma('journal_mode = DELETE');
  rw.close();
  const copy = new Database(path.join(tmp, 'data.db'), { readonly: true });
  const integrity = copy.pragma('integrity_check', { simple: true });
  const counts = {};
  for (const t of ['boards', 'lists', 'cards', 'comments', 'attachments', 'members']) {
    try { counts[t] = copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch { counts[t] = null; }
  }
  copy.close();
  if (integrity !== 'ok') throw new Error(`intégrité de la copie : ${integrity}`);

  // 2. Fichiers joints (immuables une fois écrits : une copie fichier par fichier suffit)
  let files = 0;
  let bytes = 0;
  if (fs.existsSync(uploads)) {
    fs.mkdirSync(path.join(tmp, 'uploads'));
    for (const f of fs.readdirSync(uploads)) {
      const from = path.join(uploads, f);
      if (!fs.statSync(from).isFile()) continue;
      fs.copyFileSync(from, path.join(tmp, 'uploads', f));
      files++;
      bytes += fs.statSync(from).size;
    }
  }

  const manifest = {
    created_at: now.toISOString(),
    app_version: require(path.join(ROOT, 'package.json')).version,
    source_db: dbPath,
    db_sha256: sha256(path.join(tmp, 'data.db')),
    integrity,
    counts,
    uploads: { files, bytes }
  };
  fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dest, name));

  const removed = rotate(dest, keepDays, now.getTime());
  console.log(`Sauvegarde ${name} : ${counts.cards ?? '?'} cartes, ${files} fichier(s) joint(s), intégrité ${integrity}.` +
    (removed.length ? ` ${removed.length} ancienne(s) supprimée(s).` : ''));
}

main().catch((e) => {
  console.error(`Échec de la sauvegarde : ${e.message}`);
  process.exit(1);
});
