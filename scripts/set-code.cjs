#!/usr/bin/env node
// scripts/set-code.cjs — définit (ou régénère) le code d'accès d'un membre, en local sur le serveur.
//   node scripts/set-code.cjs <nom|id> [code]       (sans code : 8 chiffres aléatoires, affichés une fois)
//   node scripts/set-code.cjs Invité [code] --guest (crée au besoin un compte invité en lecture seule)
//   DB=/chemin/data.db node scripts/set-code.cjs …  (défaut : data.db à côté de server.js)
// Ferme aussi toutes les sessions ouvertes du membre.
'use strict';

const path = require('path');
const crypto = require('crypto');
const { open } = require('../db');
const { hashCode, validCode, MIN_CODE_LENGTH } = require('../auth');

const argv = process.argv.slice(2);
const guest = argv.includes('--guest');
const [who, given] = argv.filter((a) => a !== '--guest');
if (!who) {
  console.error('Usage : node scripts/set-code.cjs <nom|id> [code]');
  process.exit(2);
}
const db = open(process.env.DB || path.join(__dirname, '..', 'data.db'));
let member = /^\d+$/.test(who)
  ? db.prepare('SELECT id, name, role FROM members WHERE id = ?').get(Number(who))
  : db.prepare('SELECT id, name, role FROM members WHERE name = ? COLLATE NOCASE').get(who);
if (!member && guest && !/^\d+$/.test(who)) {
  const initials = who.normalize('NFD').replace(/[\u0300-\u036f]/g, '').slice(0, 2).toUpperCase() || 'IN';
  const r = db.prepare("INSERT INTO members (name, initials, color, role) VALUES (?,?,?,'guest')").run(who, initials, '#7b8894');
  member = { id: r.lastInsertRowid, name: who, role: 'guest' };
  console.log(`Compte invité « ${who} » créé (lecture seule).`);
} else if (member && guest && member.role !== 'guest') {
  console.error(`${member.name} est un membre : --guest ne change pas un membre existant en invité.`);
  process.exit(1);
}
if (!member) {
  console.error(`Membre introuvable : ${who}`);
  console.error('Membres : ' + db.prepare('SELECT id, name FROM members ORDER BY id').all().map((m) => `${m.id}=${m.name}`).join(', '));
  process.exit(1);
}
const code = given || String(crypto.randomInt(0, 1e8)).padStart(8, '0');
if (!validCode(code)) {
  console.error(`Code trop court : ${MIN_CODE_LENGTH} caractères minimum.`);
  process.exit(1);
}
const { salt, hash } = hashCode(code);
db.prepare('UPDATE members SET code_hash = ?, code_salt = ? WHERE id = ?').run(hash, salt, member.id);
const closed = db.prepare('DELETE FROM sessions WHERE member_id = ?').run(member.id).changes;
db.close();
console.log(`Code de ${member.name} (#${member.id}) enregistré${given ? '' : ` : ${code}`}.` +
  (closed ? ` ${closed} session(s) fermée(s).` : ''));
