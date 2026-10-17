// auth.js — « La Boîte » : codes d'accès par membre (scrypt) + jetons de session
'use strict';

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEYLEN = 32;
const MIN_CODE_LENGTH = 6;

function hashCode(code) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(code), salt, KEYLEN, SCRYPT).toString('hex');
  return { salt, hash };
}

// Comparaison à temps constant ; sans sel (membre inconnu ou sans code) on calcule quand même
// un hash pour ne pas révéler par le temps de réponse quels membres ont un code.
function verifyCode(code, salt, hash) {
  const computed = crypto.scryptSync(String(code), salt || 'absent', KEYLEN, SCRYPT);
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  return expected.length === computed.length && crypto.timingSafeEqual(expected, computed);
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Seul le hash du jeton est stocké : une fuite de la base ne donne pas de session valide
function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function validCode(code) {
  return typeof code === 'string' && code.length >= MIN_CODE_LENGTH && code.length <= 128;
}

module.exports = { hashCode, verifyCode, newToken, tokenHash, validCode, MIN_CODE_LENGTH };
