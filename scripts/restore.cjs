#!/usr/bin/env node
// scripts/restore.cjs — restaure une sauvegarde faite par scripts/backup.cjs.
//   node scripts/restore.cjs <dossier-de-sauvegarde> --yes [--db FICHIER] [--uploads DIR]
// À lancer SERVICE ARRÊTÉ (systemctl stop la-boite). Rien n'est effacé : la base et les fichiers
// actuels sont renommés en *.avant-restauration-<horodatage> avant la copie.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--yes') out.yes = true;
    else if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
    else out._.push(argv[i]);
  }
  return out;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const a = args(process.argv.slice(2));
const src = a._[0] && path.resolve(a._[0]);
const dbPath = path.resolve(a.db || process.env.DB || path.join(ROOT, 'data.db'));
const uploads = path.resolve(a.uploads || process.env.UPLOADS || path.join(ROOT, 'uploads'));
if (!src) fail('Usage : node scripts/restore.cjs <dossier-de-sauvegarde> --yes [--db FICHIER] [--uploads DIR]');

// 1. Contrôles de la sauvegarde avant de toucher à quoi que ce soit
const manifestPath = path.join(src, 'manifest.json');
const backupDb = path.join(src, 'data.db');
if (!fs.existsSync(manifestPath) || !fs.existsSync(backupDb)) fail(`Sauvegarde incomplète : ${src}`);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const sum = crypto.createHash('sha256').update(fs.readFileSync(backupDb)).digest('hex');
if (sum !== manifest.db_sha256) fail('Empreinte SHA-256 de data.db différente du manifeste : sauvegarde altérée.');
const check = new Database(backupDb, { readonly: true });
const integrity = check.pragma('integrity_check', { simple: true });
check.close();
if (integrity !== 'ok') fail(`Intégrité de la sauvegarde : ${integrity}`);

console.log(`Sauvegarde du ${manifest.created_at} (v${manifest.app_version}) : ` +
  `${manifest.counts.cards} cartes, ${manifest.uploads.files} fichier(s) joint(s).`);
console.log(`Cible : ${dbPath} et ${uploads}`);
if (!a.yes) fail('Ajoutez --yes pour restaurer (service arrêté).');

// 2. Mise de côté de l'existant (jamais supprimé)
const suffix = '.avant-restauration-' + new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
for (const s of ['', '-wal', '-shm']) {
  if (fs.existsSync(dbPath + s)) fs.renameSync(dbPath + s, dbPath + suffix + s);
}
if (fs.existsSync(uploads)) fs.renameSync(uploads, uploads + suffix);

// 3. Copie
fs.mkdirSync(path.dirname(dbPath), { recursive: true });
fs.copyFileSync(backupDb, dbPath);
fs.mkdirSync(uploads, { recursive: true });
const upSrc = path.join(src, 'uploads');
let files = 0;
if (fs.existsSync(upSrc)) {
  for (const f of fs.readdirSync(upSrc)) {
    fs.copyFileSync(path.join(upSrc, f), path.join(uploads, f));
    files++;
  }
}
console.log(`Restauré : base + ${files} fichier(s). Ancien état conservé avec le suffixe ${suffix}.`);
console.log('Redémarrez le service : systemctl start la-boite');
