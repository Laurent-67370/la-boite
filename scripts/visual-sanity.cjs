// scripts/visual-sanity.cjs — vérification visuelle + drag de liste (hors suite MVP)
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { chromium } = require('/root/node_modules/playwright');

const SERVER = path.join(__dirname, '..', 'server.js');
const SHOTS = '/root/.hermes/cache/scratch/lab-shots';

function req(method, url, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(`http://127.0.0.1:3230${url}`,
      { method, headers: data ? { 'Content-Type': 'application/json' } : {} },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* non-JSON (statique) */ }
          resolve({ status: res.statusCode, json, text: buf });
        });
      });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const server = spawn('/usr/bin/node', [SERVER], {
  env: { ...process.env, PORT: '3230' },
  stdio: ['ignore', 'pipe', 'pipe']
});

(async () => {
  fs.mkdirSync(SHOTS, { recursive: true });
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) break; } catch { /* pas prêt */ }
    await new Promise((r) => setTimeout(r, 250));
  }

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 850 }, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push((e.stack || e.message || String(e)).split('\n').slice(0, 3).join(' | ')));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://127.0.0.1:3230/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.list-wrapper', { timeout: 10000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/board-3230.png` });

  // modale
  await page.click('.list-card');
  await page.waitForSelector('#card-modal', { timeout: 5000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/modal-3230.png` });
  await page.click('#modal-close');

  // dark mode
  const ctxDark = await browser.newContext({ viewport: { width: 1400, height: 850 }, colorScheme: 'dark', locale: 'fr-FR' });
  const pageDark = await ctxDark.newPage();
  await pageDark.goto('http://127.0.0.1:3230/', { waitUntil: 'domcontentloaded' });
  await pageDark.waitForSelector('.list-wrapper', { timeout: 10000 });
  await pageDark.waitForTimeout(500);
  await pageDark.screenshot({ path: `${SHOTS}/dark-3230.png` });
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