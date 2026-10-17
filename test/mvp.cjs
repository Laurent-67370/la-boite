// test/mvp.cjs — « La Boîte » : suite Playwright des ~14 checks MVP de la SPEC.md
// require ABSOLU obligatoire : NODE_PATH est ignoré en ESM — ce fichier reste .cjs CommonJS.
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
// require ABSOLU sur le VPS ; repli sur la résolution locale (CI / poste de dev)
const { chromium } = (() => {
  try { return require('/root/node_modules/playwright'); } catch { return require('playwright'); }
})();

const SERVER = path.join(__dirname, '..', 'server.js');
const PORT = 3231;
const BASE = `http://127.0.0.1:${PORT}`;
const DB = '/tmp/trello-test.db';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: ok ? '' : String(detail || 'échec') });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' — ' + String(detail || '')}`);
}
async function checkAsync(name, fn) {
  try { const ok = await fn(); check(name, ok === false ? false : true, ok === false ? 'assertion fausse' : ''); }
  catch (e) { check(name, false, e.message || e); }
}

// Sessions de test par membre (cookie lb_session). Les appels gardent la forme { 'X-Member-Id': id } :
// sans Cookie explicite, cet en-tête est traduit en cookie du membre ; { ANON: 1 } = sans session ;
// sinon session de l'admin (membre 1). Avec un Cookie explicite, X-Member-Id part tel quel (test d'usurpation).
const CODES = { 1: '111111', 2: '222222', 3: '333333', 4: '444444' };
const SESSIONS = {};
function withAuth(headers) {
  const h = { 'X-Requested-With': 'la-boite', ...(headers || {}) };
  if (h.NOCSRF) { delete h.NOCSRF; delete h['X-Requested-With']; }
  if (h.ANON) { delete h.ANON; return h; }
  if (h.Cookie) return h;
  const id = h['X-Member-Id'] || '1';
  delete h['X-Member-Id'];
  if (SESSIONS[id]) h.Cookie = SESSIONS[id];
  return h;
}
async function loginAs(id) {
  const r = await req('POST', '/api/auth/login', { member_id: id, code: CODES[id] }, { ANON: 1 });
  const set = [].concat(r.headers['set-cookie'] || [])[0] || '';
  SESSIONS[id] = set.split(';')[0];
  return r;
}

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      `${BASE}${url}`,
      {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...withAuth(extraHeaders)
        }
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* html */ }
          resolve({ status: res.statusCode, json, text: buf, headers: res.headers });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

// Requête à corps brut (téléversement de fichier)
function rawReq(method, url, buf, headers) {
  return new Promise((resolve, reject) => {
    const r = http.request(`${BASE}${url}`, { method, headers: { 'Content-Length': buf.length, ...withAuth(headers) } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        let json = null;
        try { json = JSON.parse(body.toString('utf8')); } catch { /* binaire */ }
        resolve({ status: res.statusCode, json, body, headers: res.headers });
      });
    });
    r.on('error', reject);
    r.write(buf);
    r.end();
  });
}

function waitForHealth(tries = 50) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      req('GET', '/api/health')
        .then((r) => (r.status === 200 ? resolve() : retry(n)))
        .catch(() => retry(n));
    };
    const retry = (n) => (n <= 0 ? reject(new Error('serveur jamais prêt')) : setTimeout(() => attempt(n - 1), 200));
    attempt(tries);
  });
}

/* ------------------------------ Démarrage ------------------------------- */

for (const s of ['', '-wal', '-shm']) fs.existsSync(DB + s) && fs.unlinkSync(DB + s);

const server = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env, PORT: String(PORT), SF_TRELLIS_TEST: '1',
    LA_BOITE_INITIAL_CODES: Object.entries(CODES).map(([id, c]) => `${id}:${c}`).join(','),
    LA_BOITE_UPLOAD_QUOTA_MB: '1'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
const serverLog = [];
server.stdout.on('data', (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });
server.stderr.on('data', (d) => { serverLog.push(String(d)); if (serverLog.length > 40) serverLog.shift(); });

let browser;
let killed = false;

(async () => {
  try {
    await waitForHealth();
    console.log('Serveur de test prêt sur', BASE);

    browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
    const context = await browser.newContext({ baseURL: BASE, locale: 'fr-FR', timezoneId: 'Europe/Paris' });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('[pageerror]', e.message));
    for (const id of Object.keys(CODES)) await loginAs(id);
    // Connexion par l'interface : écran de connexion, choix du membre, code
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#login-overlay:not([hidden]) .login-member', { timeout: 10000 });
    await page.click('.login-member[data-member-id="1"]');
    await page.fill('#login-code', CODES[1]);
    await page.click('#login-submit');
    await page.waitForSelector('.list-wrapper', { timeout: 10000 });
    check('0. connexion UI (membre + code) → tableau', (await page.textContent('#me-name')) === 'Laurent', await page.textContent('#me-name'));

    /* 1. Health */
    const h = await req('GET', '/api/health');
    check('1. health ok:true', h.status === 200 && h.json && h.json.ok === true, JSON.stringify(h.json));

    /* 2. GET board → 4 listes */
    const b1 = await req('GET', '/api/board/1');
    const names = (b1.json && b1.json.lists ? b1.json.lists.map((l) => l.name) : []);
    const expected = ['À faire', 'En cours', 'À valider', 'À livrer'];
    check('2. GET /api/board/1 → 4 listes', b1.status === 200 && b1.json.lists.length === 4 &&
      expected.every((n) => names.includes(n)), JSON.stringify(names));

    const lists = b1.json.lists;
    const aFaire = lists.find((l) => l.name === 'À faire');
    const enCours = lists.find((l) => l.name === 'En cours');
    const aValider = lists.find((l) => l.name === 'À valider');
    const aLivrer = lists.find((l) => l.name === 'À livrer');

    /* 3. POST carte visible (via SSE re-render, sans rechargement) */
    const created = await req('POST', '/api/cards', { list_id: enCours.id, title: 'Carte créée via POST' });
    const newId = created.json && created.json.card && created.json.card.id;
    check('3. POST /api/cards → 201', created.status === 201 && !!newId, JSON.stringify(created.json));
    if (newId) {
      await page.waitForSelector(`.list-card[data-card-id="${newId}"]`, { timeout: 6000 });
      const visible = await page.isVisible(`.list-card[data-card-id="${newId}"]`);
      check('3b. carte visible dans l’UI (SSE)', visible, 'élément absent');
    } else {
      check('3b. carte visible dans l’UI (SSE)', false, 'pas d’id');
    }

    /* 4. Badge WIP « 2/10 » vert (À faire : 2 cartes, limite 10) */
    const wipBadge = `.list-wrapper[data-list-id="${aFaire.id}"] .list-count`;
    const wipText = await page.textContent(wipBadge);
    const wipClass = await page.getAttribute(wipBadge, 'class');
    check('4. WIP badge « 2/10 » vert', wipText.trim() === '2/10' && /wip-ok/.test(wipClass || ''), `${wipText} / ${String(wipClass)}`);

    /* 5. PATCH titre + description → écho API + UI */
    const echo = await req('PATCH', `/api/cards/${newId}`, { title: 'Carte renommée', description: 'Texte de description de test' });
    const cEcho = echo.json && echo.json.card;
    check('5. PATCH écho titre+description', echo.status === 200 && cEcho.title === 'Carte renommée' &&
      cEcho.description === 'Texte de description de test', JSON.stringify(echo.json));
    await page.waitForFunction(
      () => [...document.querySelectorAll('.list-card-title')].some((t) => t.textContent === 'Carte renommée'),
      null, { timeout: 6000 }
    );
    const descBadge = await page.isVisible(`.list-card[data-card-id="${newId}"] .badge-desc`);
    check('5b. badge 📝 description', descBadge, 'badge absent');

    /* 6. Échéance passée → badge rouge ; terminée → vert */
    const dueCard = await req('POST', '/api/cards', { list_id: aValider.id, title: 'Échéance rouge' });
    const dueId = dueCard.json.card.id;
    const duePatch = await req('PATCH', `/api/cards/${dueId}`, { due_at: '2024-01-01T10:00' });
    check('6. PATCH due_at accepté', duePatch.status === 200 && duePatch.json.card.due_at === '2024-01-01T10:00', JSON.stringify(duePatch.json));
    await page.waitForSelector(`.list-card[data-card-id="${dueId}"] .badge-due.due-past`, { timeout: 6000 });
    const dueText = await page.textContent(`.list-card[data-card-id="${dueId}"] .badge-due`);
    check('6b. badge échéance rouge + daté', /janv/.test(dueText), dueText || 'texte vide');
    // « terminée ✓ » via la modale → badge vert
    await page.click(`.list-card[data-card-id="${dueId}"]`);
    await page.waitForSelector('#card-modal', { timeout: 5000 });
    const modalVisible = await page.isVisible('#card-modal');
    const chipText = await page.textContent('#modal-list-chip');
    check('6c. modale ouvre + chip liste', modalVisible && chipText === 'À valider', chipText || 'modale fermée');
    await page.click('#modal-due-complete');
    await page.waitForSelector(`.list-card[data-card-id="${dueId}"] .badge-due.due-complete`, { timeout: 6000 });
    check('6d. échéance terminée → badge vert', true, '');
    await page.click('#modal-close');
    await page.waitForFunction(() => document.querySelector('#modal-overlay').hidden === true, null, { timeout: 5000 });

    /* 7. Étiquette → chip visible */
    const labels = b1.json.labels;
    const urgent = labels.find((l) => l.name === 'Urgent');
    check('7a. labels seed (3, couleurs)', labels.length === 3 && urgent && urgent.color === '#d0453f', JSON.stringify(labels));
    await req('POST', `/api/cards/${dueId}/labels`, { label_id: urgent.id });
    await page.waitForSelector(`.list-card[data-card-id="${dueId}"] .label-chip`, { timeout: 6000 });
    check('7. chip étiquette sur la carte', true, '');

    /* 8. Membre → avatar initiales */
    const members = b1.json.members;
    const marina = members.find((m) => m.name === 'Marina');
    check('8a. 4 membres seed avec initiales', members.length === 4 && marina && marina.initials === 'MB', JSON.stringify(members.map((m) => m.name)));
    await req('POST', `/api/cards/${dueId}/members`, { member_id: marina.id });
    await page.waitForFunction(
      (dueIdArg) => {
        const el = document.querySelector(`.list-card[data-card-id="${dueIdArg}"] .member-avatar`);
        return el && el.textContent === 'MB';
      },
      String(dueId), { timeout: 6000 }
    );
    check('8. avatar membre MB sur la carte', true, '');

    /* 9. Replier la liste (classe CSS) */
    await req('PATCH', `/api/lists/${aValider.id}`, { collapsed: 1 });
    await page.waitForSelector(`.list-wrapper[data-list-id="${aValider.id}"].is-collapsed`, { timeout: 6000 });
    check('9a. classe is-collapsed présente', true, '');
    await page.click(`.list-wrapper[data-list-id="${aValider.id}"] .list-collapsed-spine`);
    await page.waitForFunction(
      (id) => !document.querySelector(`.list-wrapper[data-list-id="${id}"].is-collapsed`),
      String(aValider.id), { timeout: 6000 }
    );
    check('9b. liste dépliée', true, '');

    /* 10. Recherche : API + filtre UI */
    const s1 = await req('GET', '/api/board/1/search?q=Cadrer');
    check('10a. recherche titre', s1.status === 200 && s1.json.results.length === 1 && s1.json.results[0].title === 'Cadrer le premier prototype', JSON.stringify(s1.json));
    const s2 = await req('GET', '/api/board/1/search?q=Marina');
    check('10b. recherche membre', s2.json.results.some((c) => c.title === 'Choisir la palette du tableau'), JSON.stringify(s2.json));
    const s3 = await req('GET', '/api/board/1/search?q=Urgent');
    check('10c. recherche étiquette', s3.json.results.some((c) => c.title === 'Maquette de la liste mobile'), JSON.stringify(s3.json));
    await page.fill('#search-input', 'Cadrer');
    await page.waitForFunction(
      () => {
        const vis = [...document.querySelectorAll('.list-card')].filter((c) => !c.classList.contains('hidden'));
        return vis.length === 1 && vis[0].textContent.includes('Cadrer');
      },
      null, { timeout: 6000 }
    );
    check('10d. filtre UI (1 carte visible)', true, '');
    await page.fill('#search-input', '');
    await page.waitForFunction(() => document.querySelectorAll('.list-card.hidden').length === 0, null, { timeout: 6000 });

    /* 11. SSE : une autre page reçoit l’insert */
    const page2 = await context.newPage();
    await page2.goto('/', { waitUntil: 'domcontentloaded' });
    await page2.waitForSelector('.list-wrapper', { timeout: 10000 });
    page.evaluate((listId) => fetch('/api/cards', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'la-boite' },
      body: JSON.stringify({ list_id: listId, title: 'Carte poussée par SSE' })
    }), enCours.id);
    await page2.waitForSelector('.list-card-title:text("Carte poussée par SSE")', { timeout: 8000 });
    check('11. SSE : autre page reçoit l’insert', true, '');
    await page2.close();

    /* 12. Drag & drop simulé (dispatchEvent) → pos + UI */
    const src = await req('GET', '/api/board/1');
    const maquette = src.json.lists.flatMap((l) => l.cards).find((c) => c.title === 'Maquette de la liste mobile');
    const oldPos = maquette.pos;
    await page.evaluate(({ cardId, targetListId }) => {
      const card = document.querySelector(`.list-card[data-card-id="${cardId}"]`);
      const target = document.querySelector(`.list-cards[data-list-id="${targetListId}"]`);
      const dt = new DataTransfer();
      dt.setData('text/plain', String(cardId));
      const rect = target.querySelectorAll('.list-card')[0].getBoundingClientRect();
      const y = rect.top + rect.height / 2 + 2;
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: rect.left + 10, clientY: y }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: rect.left + 10, clientY: y }));
    }, { cardId: maquette.id, targetListId: aValider.id });
    await page.waitForFunction(
      ({ cardId, targetListId, oldPosArg }) => {
        const el = document.querySelector(`.list-wrapper[data-list-id="${targetListId}"] .list-card[data-card-id="${cardId}"]`);
        return !!el;
      },
      { cardId: maquette.id, targetListId: aValider.id, oldPosArg: oldPos }, { timeout: 8000 }
    );
    const after = await req('GET', '/api/board/1');
    const movedCard = after.json.lists.flatMap((l) => l.cards).find((c) => c.id === maquette.id);
    check('12. drag&drop : pos changée + liste + UI', movedCard.list_id === aValider.id && movedCard.pos !== oldPos,
      JSON.stringify({ list_id: movedCard.list_id, pos: movedCard.pos }));

    /* 13. Archive + unarchive */
    const trashCard = await req('POST', '/api/cards', { list_id: aLivrer.id, title: 'Carte corbeille' });
    const trashId = trashCard.json.card.id;
    await page.waitForSelector(`.list-card[data-card-id="${trashId}"]`, { timeout: 6000 });
    const del = await req('DELETE', `/api/cards/${trashId}`);
    await page.waitForFunction((id) => !document.querySelector(`.list-card[data-card-id="${id}"]`), String(trashId), { timeout: 6000 });
    const bAfterDel = await req('GET', '/api/board/1');
    const goneFromBoard = !bAfterDel.json.lists.flatMap((l) => l.cards).some((c) => c.id === trashId);
    const archivedListed = bAfterDel.json.archived.some((c) => c.id === trashId);
    check('13a. DELETE → corbeille', del.status === 200 && goneFromBoard && archivedListed, JSON.stringify({ status: del.status }));
    const un = await req('POST', `/api/cards/${trashId}/unarchive`);
    await page.waitForFunction((id) => !!document.querySelector(`.list-card[data-card-id="${id}"]`), String(trashId), { timeout: 6000 });
    check('13b. unarchive → carte restaurée', un.status === 200 && !un.json.card.archived, JSON.stringify(un.json));

    /* 14. 404 sur id inconnu */
    const nf1 = await req('GET', '/api/board/9999');
    const nf2 = await req('PATCH', '/api/cards/999999', { title: 'x' });
    const nf3 = await req('GET', '/api/unknown-route');
    check('14. 404 sur id inconnu', nf1.status === 404 && nf2.status === 404 && nf3.status === 404,
      `${nf1.status}/${nf2.status}/${nf3.status}`);

    /* ============================ v1.1.0 ============================ */
    const AS = (id) => ({ 'X-Member-Id': String(id) });
    const allCards = async () => (await req('GET', '/api/board/1')).json.lists.flatMap((l) => l.cards);
    const proto = (await allCards()).find((c) => c.title === 'Cadrer le premier prototype');

    /* 15. Checklists */
    check('15a. checklist seed → badge 1/3', proto.checklist.total === 3 && proto.checklist.done === 1, JSON.stringify(proto.checklist));
    const badgeTxt = await page.textContent(`.list-card[data-card-id="${proto.id}"] .badge-check`);
    check('15b. badge ☑ 1/3 sur la carte', /1\/3/.test(badgeTxt || ''), badgeTxt);
    const newCl = await req('POST', `/api/cards/${proto.id}/checklists`, { name: 'Recette' }, AS(1));
    const clId = newCl.json && newCl.json.checklist && newCl.json.checklist.id;
    const it1 = await req('POST', `/api/checklists/${clId}/items`, { name: 'Tester sur mobile' }, AS(1));
    const emptyItem = await req('POST', `/api/checklists/${clId}/items`, { name: '  ' }, AS(1));
    const itId = it1.json && it1.json.item && it1.json.item.id;
    const chk = await req('PATCH', `/api/checkitems/${itId}`, { checked: true }, AS(1));
    const det1 = await req('GET', `/api/cards/${proto.id}`);
    const recette = det1.json.checklists.find((c) => c.id === clId);
    check('15c. API checklist + élément coché', newCl.status === 201 && it1.status === 201 && emptyItem.status === 400 &&
      chk.status === 200 && recette && recette.items.length === 1 && recette.items[0].checked === true &&
      det1.json.activity.some((a) => a.kind === 'item_checked'), JSON.stringify(det1.json.checklists));
    await page.waitForFunction((id) => /2\/4/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-check`)?.textContent || ''), String(proto.id), { timeout: 6000 });
    // Cochage depuis la modale
    await page.click(`.list-card[data-card-id="${proto.id}"]`);
    await page.waitForSelector('#modal-checklists .check-item', { timeout: 5000 });
    const firstUnchecked = page.locator('#modal-checklists .check-item:not(.is-checked) input[type=checkbox]').first();
    await firstUnchecked.check();
    await page.waitForFunction((id) => /3\/4/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-check`)?.textContent || ''), String(proto.id), { timeout: 6000 });
    const pct = await page.textContent('#modal-checklists .checklist-pct');
    check('15d. UI : cocher dans la modale → badge 3/4 + progression', /\d+ %/.test(pct || ''), pct);

    /* 16. Commentaires */
    await page.fill('#modal-comment-input', 'Premier retour depuis l’UI');
    await page.click('#modal-comment-save');
    await page.waitForFunction(() => [...document.querySelectorAll('#modal-feed .comment-bubble')].some((b) => b.textContent.includes('Premier retour')), null, { timeout: 6000 });
    await page.waitForFunction((id) => /💬 2/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-comments`)?.textContent || ''), String(proto.id), { timeout: 6000 });
    check('16a. UI : commentaire publié + badge 💬 2', true, '');
    const coMarina = await req('POST', `/api/cards/${proto.id}/comments`, { text: 'Vu, merci @Julia' }, AS(2));
    const coId = coMarina.json && coMarina.json.comment && coMarina.json.comment.id;
    const editOther = await req('PATCH', `/api/comments/${coId}`, { text: 'piratage' }, AS(3));
    const editOwn = await req('PATCH', `/api/comments/${coId}`, { text: 'Vu, merci @Julia !' }, AS(2));
    const delOther = await req('DELETE', `/api/comments/${coId}`, null, AS(3));
    check('16b. commentaire : auteur seul modifie, autres → 403', coMarina.status === 201 && coMarina.json.comment.member_name === 'Marina' &&
      editOther.status === 403 && editOwn.status === 200 && !!editOwn.json.comment.edited_at && delOther.status === 403,
      `${coMarina.status}/${editOther.status}/${editOwn.status}/${delOther.status}`);
    await page.click('#modal-activity-toggle');
    await page.waitForSelector('#modal-feed .feed-activity', { timeout: 5000 });
    check('16c. « Afficher les détails » → activité dans le fil', true, '');
    await page.click('#modal-close');

    /* 17. Activité */
    const mv = await req('POST', `/api/cards/${proto.id}/move`, { list_id: enCours.id, pos: 1 }, AS(1));
    const act = await req('GET', '/api/board/1/activity?limit=5');
    check('17. déplacement → activité « card_moved »', mv.status === 200 &&
      act.json.activity.some((a) => a.kind === 'card_moved' && a.card_id === proto.id && /En cours/.test(a.text)),
      JSON.stringify(act.json.activity.slice(0, 2)));

    /* 18. Copie de carte */
    const cp = await req('POST', `/api/cards/${proto.id}/copy`, { title: 'Copie du prototype', list_id: aLivrer.id, keep: { labels: false } }, AS(1));
    const copyId = cp.json && cp.json.card && cp.json.card.id;
    const copied = (await allCards()).find((c) => c.id === copyId);
    check('18. copie : checklists conservées, étiquettes retirées', cp.status === 201 && copied && copied.list_id === aLivrer.id &&
      copied.checklist.total === 4 && copied.labels.length === 0 && copied.members.length === 1,
      JSON.stringify(copied && { cl: copied.checklist, labels: copied.labels.length }));

    /* 19. Notifications 🔔 */
    const n1 = await req('GET', '/api/members/1/notifications');
    const n4 = await req('GET', '/api/members/4/notifications', null, AS(4));
    check('19a. commentaire de Marina → notif Laurent (membre de la carte)', n1.json.notifications.some((n) => n.kind === 'comment' && n.actor_id === 2), JSON.stringify(n1.json));
    check('19b. mention @Julia → notif mention', n4.json.notifications.some((n) => n.kind === 'mention'), JSON.stringify(n4.json));
    await req('POST', `/api/cards/${proto.id}/members`, { member_id: 3 }, AS(1));
    const n3 = await req('GET', '/api/members/3/notifications', null, AS(3));
    check('19c. ajout à une carte → notif « assigned »', n3.json.unread >= 1 && n3.json.notifications[0].kind === 'assigned', JSON.stringify(n3.json));
    await page.waitForFunction(() => !document.querySelector('#notif-count').hidden, null, { timeout: 6000 });
    await page.click('#btn-notif');
    await page.waitForSelector('#notif-list .notif-item.is-unread', { timeout: 5000 });
    await page.click('#notif-read-all');
    await page.waitForFunction(() => document.querySelector('#notif-count').hidden, null, { timeout: 5000 });
    const n1b = await req('GET', '/api/members/1/notifications');
    check('19d. cloche UI + « tout marquer comme lu »', n1b.json.unread === 0, JSON.stringify(n1b.json.unread));
    await page.click('#board-scroller', { position: { x: 5, y: 5 } }).catch(() => {});

    /* 20. Fonds du tableau */
    const bgs = (await req('GET', '/api/board/1')).json.backgrounds;
    const bgOk = await req('PATCH', '/api/boards/1', { background: bgs[2] });
    const bgBad = await req('PATCH', '/api/boards/1', { background: 'url(javascript:alert(1))' });
    await page.waitForFunction((bg) => document.querySelector('#board-canvas').style.background.includes(bg.slice(0, 15)) ||
      getComputedStyle(document.querySelector('#board-canvas')).backgroundImage.includes('58, 31, 77'), bgs[2], { timeout: 6000 });
    check('20. fond : préréglage accepté, CSS arbitraire refusé', bgs.length >= 6 && bgOk.status === 200 && bgBad.status === 400,
      `${bgs.length}/${bgOk.status}/${bgBad.status}`);

    /* 21. Recherche étendue */
    const sC = await req('GET', `/api/board/1/search?q=${encodeURIComponent('Premier retour')}`);
    const sI = await req('GET', `/api/board/1/search?q=${encodeURIComponent('Tester sur mobile')}`);
    check('21. recherche : commentaires + éléments de checklist', sC.json.results.some((c) => c.id === proto.id) &&
      sI.json.results.some((c) => c.id === proto.id), JSON.stringify({ c: sC.json.results.length, i: sI.json.results.length }));

    /* ============================ v1.2.0 ============================ */

    /* 22. Pièces jointes */
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
    const upImg = await rawReq('POST', `/api/cards/${proto.id}/attachments`, png,
      { 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('maquette écran.png'), 'X-Member-Id': '2' });
    const html = Buffer.from('<script>alert(1)</script>');
    const upHtml = await rawReq('POST', `/api/cards/${proto.id}/attachments`, html,
      { 'Content-Type': 'text/html', 'X-File-Name': encodeURIComponent('../../evil.html'), 'X-Member-Id': '2' });
    const imgId = upImg.json && upImg.json.attachment && upImg.json.attachment.id;
    const htmlId = upHtml.json && upHtml.json.attachment && upHtml.json.attachment.id;
    const getImg = await rawReq('GET', `/api/attachments/${imgId}/file`, Buffer.alloc(0), {});
    const getHtml = await rawReq('GET', `/api/attachments/${htmlId}/file`, Buffer.alloc(0), {});
    check('22a. fichier image : aperçu en ligne, octets identiques', upImg.status === 201 && upImg.json.attachment.previewable &&
      getImg.status === 200 && getImg.headers['content-type'] === 'image/png' && getImg.body.equals(png) &&
      getImg.headers['x-content-type-options'] === 'nosniff', `${upImg.status}/${getImg.status}/${getImg.headers['content-type']}`);
    check('22b. HTML téléversé : forcé en téléchargement, nom assaini', upHtml.status === 201 && upHtml.json.attachment.name === 'evil.html' &&
      getHtml.headers['content-type'] === 'application/octet-stream' && /^attachment/.test(getHtml.headers['content-disposition'] || '') &&
      /sandbox/.test(getHtml.headers['content-security-policy'] || ''), JSON.stringify(getHtml.headers));
    const lnk = await req('POST', `/api/cards/${proto.id}/attachments`, { url: 'https://exemple.org/cahier-des-charges' }, AS(1));
    const badLnk = await req('POST', `/api/cards/${proto.id}/attachments`, { url: 'javascript:alert(1)' }, AS(1));
    const big = await rawReq('POST', `/api/cards/${proto.id}/attachments`, Buffer.alloc(10 * 1024 * 1024 + 1),
      { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'gros.bin', 'X-Member-Id': '1' });
    check('22c. lien http(s) ok, javascript: refusé, > 10 Mo → 413', lnk.status === 201 && lnk.json.attachment.kind === 'link' &&
      badLnk.status === 400 && big.status === 413, `${lnk.status}/${badLnk.status}/${big.status}`);
    const delOtherAtt = await req('DELETE', `/api/attachments/${htmlId}`, null, AS(3));
    const delOwnAtt = await req('DELETE', `/api/attachments/${htmlId}`, null, AS(2));
    const goneFile = await rawReq('GET', `/api/attachments/${htmlId}/file`, Buffer.alloc(0), {});
    check('22d. suppression : autre membre → 403, auteur → fichier effacé', delOtherAtt.status === 403 && delOwnAtt.status === 200 &&
      goneFile.status === 404, `${delOtherAtt.status}/${delOwnAtt.status}/${goneFile.status}`);
    await page.waitForFunction((id) => /📎 2/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-attach`)?.textContent || ''), String(proto.id), { timeout: 6000 });
    await page.click(`.list-card[data-card-id="${proto.id}"]`);
    await page.waitForSelector('#modal-attachments .attachment-thumb img', { timeout: 5000 });
    await page.setInputFiles('#modal-attach-file', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('bonjour') });
    await page.waitForFunction(() => [...document.querySelectorAll('#modal-attachments .attachment-name')].some((a) => a.textContent === 'notes.txt'), null, { timeout: 6000 });
    check('22e. UI : badge 📎, aperçu image, téléversement depuis la modale', true, '');

    /* 23. Votes */
    await page.click('#modal-vote');
    await page.waitForFunction(() => document.querySelector('#modal-vote').classList.contains('is-on'), null, { timeout: 5000 });
    await req('POST', `/api/cards/${proto.id}/votes`, {}, AS(2));
    await req('POST', `/api/cards/${proto.id}/votes`, {}, AS(2));
    const noActor = await req('POST', `/api/cards/${proto.id}/votes`, {}, { ANON: 1 });
    await page.waitForFunction((id) => /👍 2/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-votes`)?.textContent || ''), String(proto.id), { timeout: 6000 });
    await page.click('#modal-vote');
    await page.waitForFunction(() => !document.querySelector('#modal-vote').classList.contains('is-on'), null, { timeout: 5000 });
    const afterVote = (await allCards()).find((c) => c.id === proto.id);
    check('23. votes : 1 par membre, retrait, session requise', JSON.stringify(afterVote.voters) === '[2]' && noActor.status === 401,
      `${JSON.stringify(afterVote.voters)}/${noActor.status}`);
    await page.click('#modal-close');

    /* 24. Modèles de tableau */
    const tpl = await req('PATCH', '/api/boards/1', { is_template: true });
    await page.waitForFunction(() => !document.querySelector('#board-template-chip').hidden, null, { timeout: 6000 });
    const fromTpl = await req('POST', '/api/boards/1/copy', { name: 'Sprint 12' }, AS(1));
    const nb = fromTpl.json && fromTpl.json.board;
    const nbFull = await req('GET', `/api/board/${nb && nb.id}`);
    const nbCards = nbFull.json.lists.flatMap((l) => l.cards);
    const nbProto = nbCards.find((c) => c.title === 'Cadrer le premier prototype');
    const nbLabelIds = new Set(nbFull.json.labels.map((l) => l.id));
    check('24a. tableau depuis modèle : listes, étiquettes remappées, checklists décochées', fromTpl.status === 201 &&
      nb.name === 'Sprint 12' && !nb.is_template && nbFull.json.lists.length === 4 && nbFull.json.labels.length === 3 &&
      nbProto && nbProto.labels.every((l) => nbLabelIds.has(l.id)) && nbProto.checklist.done === 0 && nbProto.checklist.total === 4 &&
      nbProto.comments_count === 0 && nbProto.attachments_count === 0 && nbProto.voters.length === 0,
      JSON.stringify(nbProto && { cl: nbProto.checklist, labels: nbProto.labels }));
    const boardsList = await req('GET', '/api/boards');
    check('24b. GET /api/boards liste les 2 tableaux (modèle signalé)', tpl.status === 200 && boardsList.json.boards.length === 2 &&
      boardsList.json.boards.some((b) => b.id === 1 && b.is_template), JSON.stringify(boardsList.json));
    const p2 = await context.newPage();
    await p2.goto(`/?board=${nb.id}`, { waitUntil: 'domcontentloaded' });
    await p2.waitForSelector('.list-card', { timeout: 10000 });
    const p2Title = await p2.textContent('#board-title');
    const p2TplHidden = await p2.evaluate(() => document.querySelector('#board-template-chip').hidden);
    check('24c. UI : nouveau tableau ouvert via ?board=, sans badge Modèle', p2Title === 'Sprint 12' && p2TplHidden, `${p2Title}/${p2TplHidden}`);
    await p2.close();
    await req('PATCH', '/api/boards/1', { is_template: false });

    /* 25. Migration : base v1.1 sans colonne is_template */
    const Database = require('better-sqlite3');
    const { open: openDb } = require('../db.js');
    const migPath = '/tmp/la-boite-migration-test.db';
    for (const sfx of ['', '-wal', '-shm']) fs.existsSync(migPath + sfx) && fs.unlinkSync(migPath + sfx);
    const legacy = new Database(migPath);
    legacy.exec("CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, background TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO boards (name) VALUES ('Ancien');");
    legacy.close();
    const migrated = openDb(migPath);
    const migRow = migrated.prepare('SELECT name, is_template FROM boards').get();
    migrated.close();
    check('25. migration : colonne is_template ajoutée, données conservées', migRow.name === 'Ancien' && migRow.is_template === 0, JSON.stringify(migRow));

    /* ============================ v1.2.1 ============================ */

    /* 26. Supprimer une liste n'efface aucune carte (archivage de la liste) */
    const b26 = (await req('GET', '/api/board/1')).json;
    const livrer = b26.lists.find((l) => l.name === 'À livrer');
    const livrerIds = livrer.cards.map((c) => c.id);
    const delList = await req('DELETE', `/api/lists/${livrer.id}`, null, AS(1));
    const b26b = (await req('GET', '/api/board/1')).json;
    const cardsStillThere = await Promise.all(livrerIds.map((id) => req('GET', `/api/cards/${id}`)));
    const moveIntoArchived = await req('POST', `/api/cards/${proto.id}/move`, { list_id: livrer.id, pos: 1 }, AS(1));
    const createIntoArchived = await req('POST', '/api/cards', { list_id: livrer.id, title: 'x' }, AS(1));
    const searchHidden = await req('GET', `/api/board/1/search?q=${encodeURIComponent('Publier')}`);
    const actList = await req('GET', '/api/board/1/activity?limit=3');
    check('26a. DELETE liste → archivée, cartes intactes, plus de cible', delList.status === 200 && livrerIds.length > 0 &&
      !b26b.lists.some((l) => l.id === livrer.id) && cardsStillThere.every((r) => r.status === 200 && !r.json.card.archived) &&
      b26b.archived_lists.some((l) => l.id === livrer.id && l.cards === livrerIds.length) &&
      moveIntoArchived.status === 404 && createIntoArchived.status === 404 &&
      !searchHidden.json.results.some((c) => livrerIds.includes(c.id)) &&
      actList.json.activity.some((a) => a.kind === 'list_archived'),
      JSON.stringify({ del: delList.status, mv: moveIntoArchived.status, cr: createIntoArchived.status, al: b26b.archived_lists }));
    await page.waitForFunction((id) => !document.querySelector(`.list-wrapper[data-list-id="${id}"]`), String(livrer.id), { timeout: 6000 });
    await page.click('#btn-main-menu');
    await page.locator('#menu-trash .trash-row', { hasText: 'À livrer' }).locator('button').click();
    await page.waitForFunction((id) => !!document.querySelector(`.list-wrapper[data-list-id="${id}"]`), String(livrer.id), { timeout: 6000 });
    const b26c = (await req('GET', '/api/board/1')).json;
    const restored = b26c.lists.find((l) => l.id === livrer.id);
    check('26b. UI : liste restaurée depuis la corbeille avec ses cartes', restored &&
      livrerIds.every((id) => restored.cards.some((c) => c.id === id)), JSON.stringify(restored && restored.cards.map((c) => c.id)));
    await page.mouse.click(5, 700);

    /* 27. Restaurer une carte d'une liste archivée restaure la liste */
    const solo = await req('POST', '/api/lists', { board_id: 1, name: 'Éphémère' }, AS(1));
    const soloCard = await req('POST', '/api/cards', { list_id: solo.json.list.id, title: 'Carte solitaire' }, AS(1));
    await req('DELETE', `/api/cards/${soloCard.json.card.id}`, null, AS(1));
    await req('DELETE', `/api/lists/${solo.json.list.id}`, null, AS(1));
    const unSolo = await req('POST', `/api/cards/${soloCard.json.card.id}/unarchive`, null, AS(1));
    const b27 = (await req('GET', '/api/board/1')).json;
    check('27. restaurer la carte → sa liste revient aussi', unSolo.status === 200 &&
      b27.lists.some((l) => l.id === solo.json.list.id && l.cards.some((c) => c.id === soloCard.json.card.id)),
      JSON.stringify(b27.lists.map((l) => l.name)));

    /* 28. Migration : base sans colonne lists.archived */
    const mig2 = '/tmp/la-boite-migration-test2.db';
    for (const sfx of ['', '-wal', '-shm']) fs.existsSync(mig2 + sfx) && fs.unlinkSync(mig2 + sfx);
    const legacy2 = new Database(mig2);
    legacy2.exec("CREATE TABLE boards (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, background TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT (datetime('now'))); CREATE TABLE lists (id INTEGER PRIMARY KEY AUTOINCREMENT, board_id INTEGER NOT NULL, name TEXT NOT NULL, pos REAL NOT NULL, wip_limit INTEGER, collapsed INTEGER NOT NULL DEFAULT 0); INSERT INTO boards (name) VALUES ('B'); INSERT INTO lists (board_id, name, pos) VALUES (1, 'L', 100);");
    legacy2.close();
    const m2 = openDb(mig2);
    const m2row = m2.prepare('SELECT name, archived FROM lists').get();
    m2.close();
    check('28. migration : colonne lists.archived ajoutée, listes conservées', m2row.name === 'L' && m2row.archived === 0, JSON.stringify(m2row));

    /* ============================ v1.3.0 : accès ============================ */

    /* 29. Session obligatoire, en-tête X-Member-Id ignoré */
    const anonBoard = await req('GET', '/api/board/1', null, { ANON: 1 });
    const anonSse = await req('GET', '/api/board/1/events', null, { ANON: 1 });
    const anonFile = await req('GET', `/api/attachments/${imgId}/file`, null, { ANON: 1 });
    const health = await req('GET', '/api/health', null, { ANON: 1 });
    const staticPage = await req('GET', '/', null, { ANON: 1 });
    const fakeHeader = await req('GET', '/api/board/1', null, { ANON: 1, 'X-Member-Id': '1' });
    check('29a. sans session : API, SSE et fichiers → 401 ; santé et page publiques',
      anonBoard.status === 401 && anonSse.status === 401 && anonFile.status === 401 && fakeHeader.status === 401 &&
      health.status === 200 && staticPage.status === 200,
      [anonBoard.status, anonSse.status, anonFile.status, fakeHeader.status, health.status, staticPage.status].join('/'));
    const spoofCard = (await allCards())[0];
    const spoof = await req('DELETE', `/api/cards/${spoofCard.id}`, null, { Cookie: SESSIONS[3], 'X-Member-Id': '1' });
    const spoofList = await req('DELETE', `/api/lists/${aFaire.id}`, null, AS(3));
    const otherNotifs = await req('GET', '/api/members/1/notifications', null, AS(3));
    const otherRead = await req('POST', '/api/members/1/notifications/read', {}, AS(3));
    check('29b. membre 3 + X-Member-Id: 1 → pas admin ; notifications d’autrui → 403',
      spoof.status === 403 && spoofList.status === 403 && otherNotifs.status === 403 && otherRead.status === 403,
      [spoof.status, spoofList.status, otherNotifs.status, otherRead.status].join('/'));
    const coAs3 = await req('POST', `/api/cards/${proto.id}/comments`, { text: 'Signé par la session', member_id: 1 }, AS(3));
    check('29c. auteur = membre de la session (member_id du corps ignoré)', coAs3.status === 201 && coAs3.json.comment.member_id === 3,
      JSON.stringify(coAs3.json));

    /* 30. Connexion : mauvais code, cookie, déconnexion, force brute, origine */
    const bad = await req('POST', '/api/auth/login', { member_id: 2, code: '000000' }, { ANON: 1 });
    const ok2 = await req('POST', '/api/auth/login', { member_id: 2, code: CODES[2] }, { ANON: 1 });
    const cookieLine = [].concat(ok2.headers['set-cookie'] || [])[0] || '';
    const tmpCookie = cookieLine.split(';')[0];
    const me2 = await req('GET', '/api/auth/me', null, { Cookie: tmpCookie });
    const out = await req('POST', '/api/auth/logout', null, { Cookie: tmpCookie });
    const afterOut = await req('GET', '/api/auth/me', null, { Cookie: tmpCookie });
    check('30a. mauvais code 401 ; cookie HttpOnly + SameSite ; déconnexion invalide la session',
      bad.status === 401 && ok2.status === 200 && /HttpOnly/.test(cookieLine) && /SameSite=Lax/.test(cookieLine) &&
      me2.json.member.id === 2 && out.status === 200 && afterOut.status === 401,
      `${bad.status}/${ok2.status}/${cookieLine}/${afterOut.status}`);
    const tries = [];
    for (let i = 0; i < 6; i++) tries.push((await req('POST', '/api/auth/login', { member_id: 4, code: '999999' }, { ANON: 1 })).status);
    const lockedGood = await req('POST', '/api/auth/login', { member_id: 4, code: CODES[4] }, { ANON: 1 });
    check('30b. 5 échecs → membre bloqué (429), même avec le bon code', tries.slice(0, 5).every((x) => x === 401) &&
      tries[5] === 429 && lockedGood.status === 429, `${tries.join(',')}/${lockedGood.status}`);
    const foreign = await req('POST', `/api/cards/${proto.id}/comments`, { text: 'csrf' }, { NOCSRF: 1, 'X-Member-Id': '1' });
    const foreignLogin = await req('POST', '/api/auth/login', { member_id: 1, code: CODES[1] }, { NOCSRF: 1, ANON: 1 });
    check('30c. requête sans en-tête anti-CSRF (autre site) → 403, même connexion', foreign.status === 403 &&
      foreignLogin.status === 403, `${foreign.status}/${foreignLogin.status}`);

    /* 31. Quota de stockage (1 Mo en test) */
    const quota = await rawReq('POST', `/api/cards/${proto.id}/attachments`, Buffer.alloc(1100 * 1024),
      { 'Content-Type': 'application/octet-stream', 'X-File-Name': 'trop.bin', 'X-Member-Id': '1' });
    check('31. quota de stockage dépassé → 507', quota.status === 507, String(quota.status));

    /* 32. Script de définition d'un code */
    const codeDb = '/tmp/la-boite-code-test.db';
    for (const sfx of ['', '-wal', '-shm']) fs.existsSync(codeDb + sfx) && fs.unlinkSync(codeDb + sfx);
    require('../db.js').init(codeDb).close();
    const { execFileSync } = require('child_process');
    const outGen = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'set-code.cjs'), 'Marina'], { env: { ...process.env, DB: codeDb } }).toString();
    const genCode = (outGen.match(/: (\d{8})\./) || [])[1];
    let shortRefused = false;
    try { execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'set-code.cjs'), '2', '123'], { env: { ...process.env, DB: codeDb }, stdio: 'pipe' }); }
    catch { shortRefused = true; }
    const cdb = openDb(codeDb);
    const row = cdb.prepare('SELECT code_hash, code_salt FROM members WHERE id = 2').get();
    cdb.close();
    const authMod = require('../auth.js');
    check('32. set-code : code aléatoire à 8 chiffres, stocké haché, code court refusé', !!genCode &&
      authMod.verifyCode(genCode, row.code_salt, row.code_hash) && !row.code_hash.includes(genCode) && shortRefused,
      `${outGen.trim()}/${shortRefused}`);

    /* ============================ v1.3.1 ============================ */

    /* 33. Blocage par couple membre + IP : un tiers ne bloque plus le membre ailleurs */
    const fromOtherIp = await req('POST', '/api/auth/login', { member_id: 4, code: CODES[4] }, { ANON: 1, 'X-Forwarded-For': '203.0.113.7' });
    const stillLocked = await req('POST', '/api/auth/login', { member_id: 4, code: CODES[4] }, { ANON: 1 });
    check('33. membre 4 bloqué depuis l’IP fautive, mais connexion OK depuis une autre IP',
      fromOtherIp.status === 200 && stillLocked.status === 429, `${fromOtherIp.status}/${stillLocked.status}`);

    /* 34. Changer son code (API) */
    const ok2b = await req('POST', '/api/auth/login', { member_id: 2, code: CODES[2] }, { ANON: 1 });
    const otherSession2 = [].concat(ok2b.headers['set-cookie'] || [])[0].split(';')[0];
    const wrongCur = await req('POST', '/api/auth/code', { current: '000000', next: '765432109' }, AS(2));
    const tooShort = await req('POST', '/api/auth/code', { current: CODES[2], next: '12' }, AS(2));
    const sameCode = await req('POST', '/api/auth/code', { current: CODES[2], next: CODES[2] }, AS(2));
    const changed = await req('POST', '/api/auth/code', { current: CODES[2], next: '765432109' }, AS(2));
    const keptSession = await req('GET', '/api/auth/me', null, AS(2));
    const killedSession = await req('GET', '/api/auth/me', null, { Cookie: otherSession2 });
    const oldCode = await req('POST', '/api/auth/login', { member_id: 2, code: CODES[2] }, { ANON: 1, 'X-Forwarded-For': '203.0.113.8' });
    const newCode = await req('POST', '/api/auth/login', { member_id: 2, code: '765432109' }, { ANON: 1, 'X-Forwarded-For': '203.0.113.8' });
    const anonChange = await req('POST', '/api/auth/code', { current: '765432109', next: '111222333' }, { ANON: 1 });
    check('34. changer son code : actuel exigé, longueur, autres sessions fermées, session courante gardée',
      wrongCur.status === 401 && tooShort.status === 400 && sameCode.status === 400 && changed.status === 200 &&
      keptSession.status === 200 && killedSession.status === 401 && oldCode.status === 401 && newCode.status === 200 &&
      anonChange.status === 401,
      [wrongCur.status, tooShort.status, sameCode.status, changed.status, keptSession.status, killedSession.status,
        oldCode.status, newCode.status, anonChange.status].join('/'));
    CODES[2] = '765432109';

    /* 35. Changer son code depuis l'interface (membre 3, nouvelle session navigateur) */
    const ctx3 = await browser.newContext({ baseURL: BASE, locale: 'fr-FR' });
    const p3 = await ctx3.newPage();
    await p3.goto('/', { waitUntil: 'domcontentloaded' });
    await p3.click('.login-member[data-member-id="3"]');
    await p3.fill('#login-code', CODES[3]);
    await p3.click('#login-submit');
    await p3.waitForSelector('.list-wrapper', { timeout: 10000 });
    await p3.click('#btn-account');
    await p3.fill('#code-current', CODES[3]);
    await p3.fill('#code-next', '31415926');
    await p3.fill('#code-confirm', '27182818');
    await p3.click('#code-submit');
    await p3.waitForFunction(() => /diffèrent/.test(document.querySelector('#code-error').textContent), null, { timeout: 5000 });
    await p3.fill('#code-confirm', '31415926');
    await p3.click('#code-submit');
    await p3.waitForFunction(() => document.querySelector('#popover-account').hidden, null, { timeout: 5000 });
    const old3 = await req('GET', '/api/auth/me', null, AS(3));
    const new3 = await req('POST', '/api/auth/login', { member_id: 3, code: '31415926' }, { ANON: 1, 'X-Forwarded-For': '203.0.113.9' });
    const stillIn = await p3.evaluate(() => fetch('/api/auth/me').then((r) => r.status));
    check('35. UI « Changer mon code » : confirmation vérifiée, ancienne session fermée, la page reste connectée',
      old3.status === 401 && new3.status === 200 && stillIn === 200, `${old3.status}/${new3.status}/${stillIn}`);
    await ctx3.close();

    /* ============================ v1.4.0 : sauvegardes ============================ */
    {
      const { execFileSync: run } = require('child_process');
      const T = '/tmp/la-boite-backup-test';
      fs.rmSync(T, { recursive: true, force: true });
      fs.mkdirSync(path.join(T, 'uploads'), { recursive: true });
      const bdb = path.join(T, 'data.db');
      require('../db.js').init(bdb).close();
      fs.writeFileSync(path.join(T, 'uploads', 'a1'), Buffer.from('premier fichier'));
      fs.writeFileSync(path.join(T, 'uploads', 'b2'), Buffer.alloc(4096, 7));
      // Écriture laissée dans le WAL (connexion ouverte, pas de checkpoint) : la sauvegarde doit la contenir
      const w = openDb(bdb);
      w.pragma('wal_autocheckpoint = 0');
      w.prepare("INSERT INTO cards (list_id, title, pos) VALUES (1, 'Écrite pendant WAL', 999)").run();
      const walSize = fs.statSync(bdb + '-wal').size;
      const script = (n) => path.join(__dirname, '..', 'scripts', n);
      const out1 = run(process.execPath, [script('backup.cjs'), '--db', bdb, '--uploads', path.join(T, 'uploads'), '--dest', path.join(T, 'backups')]).toString();
      const dirs1 = fs.readdirSync(path.join(T, 'backups')).filter((n) => n.startsWith('la-boite-'));
      const bdir = path.join(T, 'backups', dirs1[0]);
      const man = JSON.parse(fs.readFileSync(path.join(bdir, 'manifest.json'), 'utf8'));
      const bcopy = new Database(path.join(bdir, 'data.db'), { readonly: true });
      const walCard = bcopy.prepare("SELECT COUNT(*) AS n FROM cards WHERE title = 'Écrite pendant WAL'").get().n;
      bcopy.close();
      check('36a. sauvegarde à chaud : écriture encore dans le WAL incluse, intégrité ok, fichiers copiés',
        walSize > 0 && dirs1.length === 1 && walCard === 1 && man.integrity === 'ok' && man.uploads.files === 2 &&
        man.uploads.bytes === 15 + 4096 && fs.readFileSync(path.join(bdir, 'uploads', 'b2')).equals(Buffer.alloc(4096, 7)),
        `${walSize}/${dirs1.length}/${walCard}/${out1.trim()}`);
      w.close();

      // Rotation : vieille sauvegarde et reste interrompu supprimés, récentes conservées
      fs.mkdirSync(path.join(T, 'backups', 'la-boite-20200101T000000Z'));
      fs.mkdirSync(path.join(T, 'backups', '.tmp-la-boite-x-1'));
      fs.mkdirSync(path.join(T, 'backups', 'sans-rapport'));
      run(process.execPath, [script('backup.cjs'), '--db', bdb, '--uploads', path.join(T, 'uploads'), '--dest', path.join(T, 'backups'), '--keep-days', '14']);
      const dirs2 = fs.readdirSync(path.join(T, 'backups')).sort();
      check('36b. rotation 14 j : ancienne et temporaire supprimées, 2 récentes + dossier étranger gardés',
        dirs2.length === 3 && !dirs2.includes('la-boite-20200101T000000Z') && !dirs2.some((n) => n.startsWith('.tmp-')) &&
        dirs2.includes('sans-rapport'), JSON.stringify(dirs2));

      // Restauration
      const rdb = path.join(T, 'restaure', 'data.db');
      const rup = path.join(T, 'restaure', 'uploads');
      let refused = false;
      try { run(process.execPath, [script('restore.cjs'), bdir, '--db', rdb, '--uploads', rup], { stdio: 'pipe' }); } catch { refused = true; }
      const untouched = !fs.existsSync(rdb);
      fs.mkdirSync(rup, { recursive: true });
      fs.writeFileSync(rup + '/ancien', 'x');
      fs.writeFileSync(rdb, 'ancienne base');
      run(process.execPath, [script('restore.cjs'), bdir, '--db', rdb, '--uploads', rup, '--yes'], { stdio: 'pipe' });
      const rcopy = new Database(rdb, { readonly: true });
      const rCard = rcopy.prepare("SELECT COUNT(*) AS n FROM cards WHERE title = 'Écrite pendant WAL'").get().n;
      rcopy.close();
      const kept = fs.readdirSync(path.join(T, 'restaure')).filter((n) => n.includes('avant-restauration'));
      check('36c. restauration : --yes exigé, contenu identique, ancien état mis de côté (jamais effacé)',
        refused && untouched && rCard === 1 && fs.readFileSync(path.join(rup, 'a1'), 'utf8') === 'premier fichier' &&
        kept.length === 2 && !fs.existsSync(path.join(rup, 'ancien')), JSON.stringify({ refused, untouched, rCard, kept }));

      // Sauvegarde altérée → refus
      const bad = path.join(T, 'alteree');
      fs.cpSync(bdir, bad, { recursive: true });
      const buf = fs.readFileSync(path.join(bad, 'data.db'));
      buf[buf.length - 10] ^= 0xff;
      fs.writeFileSync(path.join(bad, 'data.db'), buf);
      let tamperRefused = false;
      try { run(process.execPath, [script('restore.cjs'), bad, '--db', path.join(T, 'x.db'), '--uploads', path.join(T, 'xu'), '--yes'], { stdio: 'pipe' }); }
      catch (e) { tamperRefused = /SHA-256/.test(String(e.stderr)); }
      check('36d. sauvegarde altérée (SHA-256 ≠ manifeste) → restauration refusée', tamperRefused && !fs.existsSync(path.join(T, 'x.db')),
        String(tamperRefused));
    }

    /* 37. Copie hors site chiffrée (age + lftp, cible file:// en test) */
    {
      const { execFileSync: run, spawnSync } = require('child_process');
      const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
      if (!has('age') || !has('lftp')) {
        console.log('SKIP  37. copie hors site — age/lftp absents (installés en CI)');
      } else {
        const T = '/tmp/la-boite-offsite-test';
        fs.rmSync(T, { recursive: true, force: true });
        fs.mkdirSync(path.join(T, 'remote'), { recursive: true });
        fs.mkdirSync(path.join(T, 'up'));
        fs.writeFileSync(path.join(T, 'up', 'piece'), 'contenu joint');
        require('../db.js').init(path.join(T, 'data.db')).close();
        run('age-keygen', ['-o', path.join(T, 'cle.txt')], { stdio: 'pipe' });
        const pub = run('age-keygen', ['-y', path.join(T, 'cle.txt')]).toString().trim();
        const env = { ...process.env, LA_BOITE_BACKUP_DIR: path.join(T, 'bk'), OFFSITE_AGE_RECIPIENT: pub,
          OFFSITE_URL: `file://${T}/remote`, OFFSITE_KEEP: '2' };
        for (let i = 0; i < 3; i++) {
          run(process.execPath, [path.join(__dirname, '..', 'scripts', 'backup.cjs'), '--db', path.join(T, 'data.db'),
            '--uploads', path.join(T, 'up'), '--dest', path.join(T, 'bk')], { stdio: 'pipe' });
          run('bash', [path.join(__dirname, '..', 'scripts', 'offsite.sh')], { env, stdio: 'pipe' });
        }
        const remote = fs.readdirSync(path.join(T, 'remote', 'la-boite')).sort();
        const latest = fs.readdirSync(path.join(T, 'bk')).filter((n) => n.startsWith('la-boite-')).sort().pop();
        const blob = fs.readFileSync(path.join(T, 'remote', 'la-boite', remote[remote.length - 1]));
        const encrypted = blob.toString('latin1').startsWith('age-encryption.org/v1') && !blob.includes(Buffer.from('SQLite format'));
        fs.mkdirSync(path.join(T, 'dec'));
        run('sh', ['-c', `age -d -i ${T}/cle.txt "${T}/remote/la-boite/${remote[remote.length - 1]}" | tar -xz -C ${T}/dec`]);
        const decFiles = fs.readdirSync(path.join(T, 'dec')).sort();
        let badKey = false;
        try { run('bash', [path.join(__dirname, '..', 'scripts', 'offsite.sh')], { env: { ...env, OFFSITE_AGE_RECIPIENT: 'pas-une-cle' }, stdio: 'pipe' }); }
        catch { badKey = true; }
        check('37. hors site : chiffré age, 2 copies gardées, la plus récente déchiffrable, sans wal/shm, clé invalide refusée',
          remote.length === 2 && remote[1] === `${latest}.tar.gz.age` && !remote.some((n) => n.endsWith('.part')) && encrypted &&
          JSON.stringify(decFiles) === JSON.stringify(['data.db', 'manifest.json', 'uploads']) &&
          fs.readFileSync(path.join(T, 'dec', 'uploads', 'piece'), 'utf8') === 'contenu joint' && badKey,
          JSON.stringify({ remote, encrypted, decFiles, badKey }));
      }
    }

    /* ============================ v1.5.0 ============================ */

    /* 38. Date de début */
    const dCard = (await req('POST', '/api/cards', { list_id: aFaire.id, title: 'Carte datée' })).json.card;
    const badStart = await req('PATCH', `/api/cards/${dCard.id}`, { start_at: '20/10/2026' });
    const okDates = await req('PATCH', `/api/cards/${dCard.id}`, { start_at: '2030-03-02', due_at: '2030-03-15T18:00' });
    const inverted = await req('PATCH', `/api/cards/${dCard.id}`, { start_at: '2030-03-20' });
    const dueBefore = await req('PATCH', `/api/cards/${dCard.id}`, { due_at: '2030-03-01T09:00' });
    const sameDay = await req('PATCH', `/api/cards/${dCard.id}`, { start_at: '2030-03-15' });
    const dDet = await req('GET', `/api/cards/${dCard.id}`);
    await page.waitForFunction((id) => /→/.test(document.querySelector(`.list-card[data-card-id="${id}"] .badge-due`)?.textContent || ''), String(dCard.id), { timeout: 6000 });
    const dBadge = await page.textContent(`.list-card[data-card-id="${dCard.id}"] .badge-due`);
    const dCopy = await req('POST', `/api/cards/${dCard.id}/copy`, {});
    check('38. date de début : format AAAA-MM-JJ, jamais après l’échéance, badge « début → échéance », copiée, journalisée',
      badStart.status === 400 && okDates.status === 200 && inverted.status === 400 && dueBefore.status === 400 &&
      sameDay.status === 200 && dDet.json.card.start_at === '2030-03-15' && /15 mars.*→.*15 mars/.test(dBadge) &&
      dCopy.json.card.start_at === '2030-03-15' && dDet.json.activity.some((a) => a.kind === 'start_changed'),
      JSON.stringify({ s: [badStart.status, okDates.status, inverted.status, dueBefore.status, sameDay.status], dBadge }));

    /* 39. Raccourcis clavier */
    await page.mouse.click(5, 700);
    await page.keyboard.press('/');
    const searchFocused = await page.evaluate(() => document.activeElement && document.activeElement.id === 'search-input');
    await page.keyboard.type('n');
    const noComposerWhileTyping = await page.evaluate(() => !document.querySelector('.composer'));
    await page.fill('#search-input', '');
    await page.evaluate(() => document.activeElement.blur());
    await page.hover(`.list-wrapper[data-list-id="${enCours.id}"] .list-header-row`);
    await page.keyboard.press('n');
    await page.waitForSelector(`.list-wrapper[data-list-id="${enCours.id}"] .composer textarea`, { timeout: 3000 });
    const composerFocused = await page.evaluate(() => document.activeElement && document.activeElement.closest('.composer') !== null);
    await page.keyboard.type('Carte au clavier');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.list-card-title')].some((t) => t.textContent === 'Carte au clavier'), null, { timeout: 6000 });
    const kbCard = (await allCards()).find((c) => c.title === 'Carte au clavier');
    await page.mouse.click(5, 700);
    await page.keyboard.press('?');
    const helpShown = await page.isVisible('#shortcuts-overlay');
    await page.keyboard.press('Escape');
    const helpHidden = await page.evaluate(() => document.querySelector('#shortcuts-overlay').hidden);
    await page.keyboard.press('f');
    const filterOpen = await page.evaluate(() => !document.querySelector('#popover-filter').hidden);
    await page.keyboard.press('Escape');
    const filterClosed = await page.evaluate(() => document.querySelector('#popover-filter').hidden);
    check('39. raccourcis : / recherche, n carte dans la liste survolée, ? aide, f filtre, Échap ferme, rien pendant la saisie',
      searchFocused && noComposerWhileTyping && composerFocused && kbCard && kbCard.list_id === enCours.id &&
      helpShown && helpHidden && filterOpen && filterClosed,
      JSON.stringify({ searchFocused, noComposerWhileTyping, composerFocused, kb: kbCard && kbCard.list_id, helpShown, helpHidden, filterOpen, filterClosed }));

    /* 39b. Composer ouvert (vide) puis événement temps réel avant la frappe : le formulaire et le focus restent */
    await page.mouse.click(5, 700);
    await page.hover(`.list-wrapper[data-list-id="${aValider.id}"] .list-header-row`);
    await page.keyboard.press('n');
    await page.waitForSelector(`.list-wrapper[data-list-id="${aValider.id}"] .composer textarea`, { timeout: 3000 });
    await req('POST', '/api/cards', { list_id: aFaire.id, title: 'Événement concurrent' });
    await page.waitForFunction(() => [...document.querySelectorAll('.list-card-title')].some((t) => t.textContent === 'Événement concurrent'), null, { timeout: 6000 });
    await page.keyboard.type('Début fin');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => [...document.querySelectorAll('.list-card-title')].some((t) => t.textContent === 'Début fin'), null, { timeout: 6000 });
    const survivor = (await allCards()).find((c) => c.title === 'Début fin');
    check('39b. saisie de carte non perdue quand un événement temps réel arrive pendant la frappe',
      !!survivor && survivor.list_id === aValider.id, JSON.stringify(survivor));

    /* 40. Réordonner dans la même liste : la carte atterrit là où on la lâche */
    const ordre = (await req('POST', '/api/lists', { board_id: 1, name: 'Ordre' })).json.list;
    const oIds = [];
    for (const t of ['O1', 'O2', 'O3']) oIds.push((await req('POST', '/api/cards', { list_id: ordre.id, title: t })).json.card.id);
    await page.waitForFunction((id) => document.querySelectorAll(`.list-cards[data-list-id="${id}"] .list-card`).length === 3, ordre.id, { timeout: 6000 });
    await page.evaluate(({ cardId, listId }) => {
      const card = document.querySelector(`.list-card[data-card-id="${cardId}"]`);
      const box = document.querySelector(`.list-cards[data-list-id="${listId}"]`);
      const cards = box.querySelectorAll('.list-card');
      const r2 = cards[1].getBoundingClientRect();
      const r3 = cards[2].getBoundingClientRect();
      const y = (r2.bottom + r3.top) / 2; // entre O2 et O3
      const dt = new DataTransfer();
      dt.setData('text/plain', String(cardId));
      card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
      box.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt, clientX: r2.left + 10, clientY: y }));
      box.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt, clientX: r2.left + 10, clientY: y }));
    }, { cardId: oIds[0], listId: ordre.id });
    await page.waitForFunction(({ id, first }) => document.querySelector(`.list-cards[data-list-id="${id}"] .list-card`)?.dataset.cardId !== String(first),
      { id: ordre.id, first: oIds[0] }, { timeout: 6000 });
    const order = (await req('GET', '/api/board/1')).json.lists.find((l) => l.id === ordre.id).cards.map((c) => c.title);
    check('40. glisser O1 entre O2 et O3 → ordre O2, O1, O3', order.join(',') === 'O2,O1,O3', order.join(','));

    /* 41. Glisser-déposer au doigt (vrais événements tactiles via CDP) */
    const mob = await browser.newContext({ baseURL: BASE, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, locale: 'fr-FR' });
    const [cName, cValue] = SESSIONS[1].split('=');
    await mob.addCookies([{ name: cName, value: cValue, url: BASE }]);
    const mp = await mob.newPage();
    mp.on('pageerror', (e) => console.log('[pageerror mobile]', e.message));
    await mp.goto('/', { waitUntil: 'domcontentloaded' });
    await mp.waitForSelector('.list-card', { timeout: 10000 });
    const cdp = await mob.newCDPSession(mp);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    const tCard = oIds[2]; // O3, dans la liste « Ordre »
    await mp.evaluate((id) => document.querySelector(`.list-card[data-card-id="${id}"]`).scrollIntoView({ inline: 'start' }), tCard);
    const from = await mp.evaluate((id) => { const r = document.querySelector(`.list-card[data-card-id="${id}"]`).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, tCard);
    // a) mouvement rapide = défilement, pas de déplacement
    await touch('touchStart', from.x, from.y);
    await touch('touchMove', from.x, from.y + 60);
    await touch('touchEnd');
    await mp.waitForTimeout(500);
    const stillThere = (await allCards()).find((c) => c.id === tCard).list_id === ordre.id;
    // b) appui long puis glisser jusqu'à la liste précédente (« Éphémère » ou la dernière avant « Ordre »)
    const targetList = await mp.evaluate((id) => {
      const wraps = [...document.querySelectorAll('.list-wrapper')];
      const i = wraps.findIndex((w) => Number(w.dataset.listId) === id);
      return Number(wraps[i - 1].dataset.listId);
    }, ordre.id);
    await touch('touchStart', from.x, from.y);
    await mp.waitForTimeout(450);
    const ghostShown = await mp.evaluate(() => !!document.querySelector('.touch-ghost'));
    // avance vers la gauche par pas : le bord gauche fait défiler le tableau jusqu'à la liste cible
    let pt = { ...from };
    for (let k = 0; k < 60; k++) {
      const tgt = await mp.evaluate((id) => {
        const b = document.querySelector(`.list-cards[data-list-id="${id}"]`);
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + 10, visible: r.left >= 0 && r.right <= innerWidth };
      }, targetList);
      if (tgt && tgt.visible) { pt = { x: tgt.x, y: tgt.y }; await touch('touchMove', pt.x, pt.y); break; }
      pt = { x: 20, y: from.y };
      await touch('touchMove', pt.x, pt.y);
      await mp.waitForTimeout(30);
    }
    await mp.waitForTimeout(100);
    const slotShown = await mp.evaluate(() => !!document.querySelector('.drop-slot'));
    await touch('touchEnd');
    await mp.waitForFunction(({ id, list }) => !!document.querySelector(`.list-cards[data-list-id="${list}"] .list-card[data-card-id="${id}"]`),
      { id: tCard, list: targetList }, { timeout: 6000 });
    const movedTouch = (await allCards()).find((c) => c.id === tCard);
    const modalOpened = await mp.evaluate(() => !document.querySelector('#modal-overlay').hidden);
    check('41. tactile : glissement rapide = défilement ; appui long → fantôme, fente, dépôt dans l’autre liste, sans ouvrir la carte',
      stillThere && ghostShown && slotShown && movedTouch.list_id === targetList && !modalOpened &&
      !(await mp.evaluate(() => !!document.querySelector('.touch-ghost'))),
      JSON.stringify({ stillThere, ghostShown, slotShown, list: movedTouch.list_id, targetList, modalOpened }));
    /* 42. Un rafraîchissement temps réel garde la position de défilement horizontal */
    await mp.evaluate(() => { document.querySelector('#board-canvas').scrollLeft = 600; });
    const before42 = await mp.evaluate(() => document.querySelector('#board-canvas').scrollLeft);
    await req('POST', '/api/cards', { list_id: aFaire.id, title: 'Déclencheur SSE' });
    await mp.waitForFunction(() => [...document.querySelectorAll('.list-card-title')].some((t) => t.textContent === 'Déclencheur SSE'), null, { timeout: 6000 });
    const after42 = await mp.evaluate(() => document.querySelector('#board-canvas').scrollLeft);
    check('42. garde-fou : un rafraîchissement temps réel conserve le défilement horizontal', before42 > 0 && after42 === before42,
      `${before42}/${after42}`);
    await mob.close();
  } catch (e) {
    check('erreur inattendue', false, e.message || e);
  } finally {
    if (browser) { try { await browser.close(); } catch { /* noop */ } }
    killed = true;
    try { server.kill('SIGTERM'); } catch { /* noop */ }
  }

  // Fin propre : on attend la mort du serveur par PID exact (jamais de pkill)
  await new Promise((resolve) => {
    const t = setTimeout(() => { try { server.kill('SIGKILL'); } catch { /* noop */ } resolve(); }, 3000);
    server.on('exit', () => { clearTimeout(t); resolve(); });
  });

  const passed = results.filter((r) => r.ok).length;
  if (passed !== results.length) {
    console.log('\n--- journal serveur (fin) ---');
    console.log(serverLog.join(''));
  }
  console.log('\n=== RÉSULTAT : ' + passed + '/' + results.length + ' tests verts ===');
  for (const r of results) console.log(`  ${r.ok ? '✔' : '✘'} ${r.name}`);
  process.exit(passed === results.length ? 0 : 1);
})();