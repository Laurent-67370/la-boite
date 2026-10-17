// scripts/visual-sanity.cjs — vérification visuelle + drag de liste (hors suite MVP)
// Instance de test jetable (port 3232, /tmp/trello-test.db) : ne touche jamais data.db ni le port de prod.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = (() => {
  try { return require('/root/node_modules/playwright'); } catch { return require('playwright'); }
})();

const SERVER = path.join(__dirname, '..', 'server.js');
const SHOTS = process.env.SHOTS || '/root/.hermes/cache/scratch/lab-shots';
const PORT = 3232;
const BASE = `http://127.0.0.1:${PORT}`;
const CODE = '111111';
let cookie = '';

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(`${BASE}${url}`,
      { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'X-Requested-With': 'la-boite' } : {}), ...(cookie ? { Cookie: cookie } : {}) } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* non-JSON (statique) */ }
          resolve({ status: res.statusCode, json, text: buf, headers: res.headers });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const server = spawn(process.execPath, [SERVER], {
  env: { ...process.env, PORT: String(PORT), SF_TRELLIS_TEST: '1', LA_BOITE_INITIAL_CODES: `1:${CODE}` },
  stdio: ['ignore', 'pipe', 'pipe']
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) break; } catch { /* pas prêt */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const login = await req('POST', '/api/auth/login', { member_id: 1, code: CODE });
  cookie = [].concat(login.headers['set-cookie'] || [])[0].split(';')[0];
  const [cName, cValue] = cookie.split('=');
  const sessionCookie = [{ name: cName, value: cValue, url: BASE }];

  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  await ctx.addCookies(sessionCookie);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push((e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.list-wrapper', { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/board-test.png` });

  // modale
  await page.click('.list-card');
  await page.waitForSelector('#card-modal', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/modal-test.png` });
  await page.click('#modal-close');

  // dark mode
  const ctxDark = await browser.newContext({ viewport: { width: 1400, height: 850 }, colorScheme: 'dark', locale: 'fr-FR' });
  await ctxDark.addCookies(sessionCookie);
  const pageDark = await ctxDark.newPage();
  await pageDark.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await pageDark.waitForSelector('.list-wrapper', { timeout: 10000 });
  await pageDark.waitForTimeout(500);
  await pageDark.screenshot({ path: `${SHOTS}/dark-test.png` });
  await ctxDark.close();

  // drag de liste (dispatchEvent) : échanger les 2 premières listes
  const before = await req('GET', '/api/board/1');
  const orderBefore = before.json.lists.map((l) => l.name).join('|');
  await page.evaluate(() => {
    const wr = [...document.querySelectorAll('.list-wrapper')];
    const dt = new DataTransfer();
    dt.setData('text/plain', 'list:' + wr[0].dataset.listId);
    wr[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
    const r2 = wr[1].getBoundingClientRect();
    // au-delà du milieu de la 2e liste → insertion APRÈS elle
    wr[1].dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r2.left + 200 }));
    wr[1].dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: r2.left + 200 }));
  });
  await page.waitForTimeout(1500);
  const after = await req('GET', '/api/board/1');
  const orderAfter = after.json.lists.map((l) => l.name).join('|');
  console.log('ordre listes avant :', orderBefore);
  console.log('ordre listes après :', orderAfter);
  console.log('drag de liste réordonne :', orderBefore !== orderAfter ? 'OK' : 'NON');
  console.log('erreurs de page :', errors.length ? errors.join(' // ') : 'aucune');

  // sw.js bien servi
  const sw = await req('GET', '/sw.js');
  const mf = await req('GET', '/manifest.webmanifest');
  console.log('statique : sw.js', sw.status, '(', sw.text.length, 'octets ) | manifest', mf.status);
  await browser.close();
})()
  .then(() => {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(0), 500);
  })
  .catch((e) => {
    console.error('ERREUR', e);
    server.kill('SIGKILL');
    process.exit(1);
  });