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

function req(method, url, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request(
      `${BASE}${url}`,
      {
        method,
        headers: {
          ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
          ...(extraHeaders || {})
        }
      },
      (res) => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { /* html */ }
          resolve({ status: res.statusCode, json, text: buf });
        });
      }
    );
    r.on('error', reject);
    if (data) r.write(data);
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
  env: { ...process.env, PORT: String(PORT), SF_TRELLIS_TEST: '1' },
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
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.list-wrapper', { timeout: 10000 });

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
      headers: { 'Content-Type': 'application/json' },
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
    const n4 = await req('GET', '/api/members/4/notifications');
    check('19a. commentaire de Marina → notif Laurent (membre de la carte)', n1.json.notifications.some((n) => n.kind === 'comment' && n.actor_id === 2), JSON.stringify(n1.json));
    check('19b. mention @Julia → notif mention', n4.json.notifications.some((n) => n.kind === 'mention'), JSON.stringify(n4.json));
    await req('POST', `/api/cards/${proto.id}/members`, { member_id: 3 }, AS(1));
    const n3 = await req('GET', '/api/members/3/notifications');
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