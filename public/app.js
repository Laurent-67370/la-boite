// app.js — « La Boîte » : rendu du tableau, SSE, drag & drop, modale, filtres
'use strict';

const state = {
  boardId: new URLSearchParams(location.search).get('board') || '1',
  board: null,
  lists: [],
  labels: [],
  members: [],
  archived: [],
  userId: Number(localStorage.getItem('laboite.user') || 1),
  filters: { labels: new Set(), members: new Set(), due: 'any' },
  searchIds: null,
  dragCardId: null,
  dragListId: null,
  modalCardId: null,
  composerDraft: {}, // listId -> {value, top}
  suppressSseUntil: 0
};

const $ = (sel, root) => (root || document).querySelector(sel);
const scroller = $('#board-scroller');
const canvas = $('#board-canvas');
const addListBtn = document.getElementById('add-list-card');

/* ------------------------------- Utils -------------------------------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const COVERS = ['#c2382e', '#df8a3c', '#e3c73f', '#4d9e69', '#2f9fa5', '#22577a'];

function fmtDate(dueAt) {
  const d = new Date(dueAt);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const opts = { day: 'numeric', month: 'short' };
  if (!sameYear) opts.year = 'numeric';
  return d.toLocaleDateString('fr-FR', opts);
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 1800);
}

function isAdmin() {
  return state.userId === 1; // Laurent = compte d'administration de la démo
}

/* ------------------------------ Chargement ----------------------------- */

async function refresh() {
  const res = await fetch(`/api/board/${state.boardId}`);
  if (!res.ok) { console.error('board load failed', res.status); return; }
  const data = await res.json();
  state.board = data.board;
  state.lists = data.lists;
  state.labels = data.labels;
  state.members = data.members;
  state.archived = data.archived || [];
  renderBoard();
  renderPopovers();
}

const refreshSoon = debounce(refresh, 90);

/* ------------------------------- Rendu --------------------------------- */

function cardVisiblyHidden(card) {
  const f = state.filters;
  const okLabel = f.labels.size === 0 || card.labels.some((l) => f.labels.has(l.id));
  const okMember = f.members.size === 0 || card.members.some((m) => f.members.has(m.id));
  let okDue = true;
  if (f.due !== 'any') {
    if (f.due === 'none') okDue = !card.due_at;
    else if (f.due === 'past') okDue = !!card.due_at && !isDueComplete(card) && isPast(card.due_at);
    else if (f.due === 'upcoming') okDue = !!card.due_at && (!isPast(card.due_at) || isDueComplete(card));
  }
  const okSearch = !state.searchIds || state.searchIds.has(card.id);
  return !(okLabel && okMember && okDue && okSearch);
}

function isDueComplete(card) { return !!card.due_complete; }
function isPast(dueAt) { return new Date(dueAt).getTime() < Date.now(); }

function countClass(card) { return null; }

function renderBoard() {
  if (!state.board) return;
  const keepScroll = scroller.scrollLeft;

  // Dégradé de fond du tableau (stocké en db)
  canvas.style.background = state.board.background;

  // Titre du tableau
  const titleBtn = $('#board-title');
  if (document.activeElement !== titleBtn) titleBtn.textContent = state.board.name;

  // Compteur global indicatif
  const total = state.lists.reduce((n, l) => n + l.cards.length, 0);
  const wipEl = $('#board-wip');
  wipEl.hidden = false;
  wipEl.textContent = `${state.lists.length} liste${state.lists.length > 1 ? 's' : ''} · ${total} carte${total > 1 ? 's' : ''}`;

  scroller.textContent = '';
  for (const list of state.lists) scroller.appendChild(buildList(list));

  const addBtn = addListBtn;
  addBtn.hidden = false;
  if (addBtn.parentElement !== scroller) scroller.appendChild(addBtn);

  // Rejoue le brouillon du composer s'il était ouvert
  for (const [listId, draft] of Object.entries(state.composerDraft)) {
    if (!draft || !draft.value) continue;
    openComposer(Number(listId), draft.top);
    const ta = $('.composer textarea');
    if (ta) ta.value = draft.value;
  }

  scroller.scrollLeft = keepScroll;
}

function buildList(list) {
  const wrap = document.createElement('section');
  wrap.className = 'list-wrapper' + (list.collapsed ? ' is-collapsed' : '');
  wrap.dataset.listId = list.id;

  // En-tête
  const head = document.createElement('div');
  head.className = 'list-header-row';
  const nameBtn = document.createElement('button');
  nameBtn.type = 'button';
  nameBtn.className = 'list-name';
  nameBtn.textContent = list.name;
  nameBtn.title = 'Renommer la liste';
  nameBtn.addEventListener('click', () => startListRename(wrap, list));
  const count = document.createElement('span');
  count.className = 'list-count' + wipClass(list);
  count.textContent = list.wip_limit ? `${list.cards.length}/${list.wip_limit}` : String(list.cards.length);
  const fold = document.createElement('button');
  fold.type = 'button';
  fold.className = 'collapse-btn';
  fold.title = list.collapsed ? 'Déplier la liste' : 'Replier la liste';
  fold.textContent = list.collapsed ? '▸' : '⤢';
  fold.addEventListener('mousedown', (e) => e.stopPropagation());
  fold.addEventListener('click', async (e) => {
    e.stopPropagation();
    await patchList(list.id, { collapsed: list.collapsed ? 0 : 1 });
  });
  head.append(nameBtn, count, fold);
  wrap.appendChild(head);

  // Spine (liste repliée)
  const spine = document.createElement('div');
  spine.className = 'list-collapsed-spine';
  spine.innerHTML = `<span>${esc(list.name)}</span><span class="spine-count list-count">${esc(count.textContent)}</span>`;
  spine.addEventListener('click', () => patchList(list.id, { collapsed: 0 }));
  wrap.appendChild(spine);

  if (list.collapsed) { wireListDrag(wrap, list, head); return wrap; }

  // Cartes
  const cardsBox = document.createElement('div');
  cardsBox.className = 'list-cards';
  cardsBox.dataset.listId = list.id;
  list.cards.forEach((card, i) => {
    const el = buildCard(card);
    el.dataset.pos = card.pos;
    el.dataset.index = i;
    cardsBox.appendChild(el);
  });
  wireCardDropZone(cardsBox);
  wrap.appendChild(cardsBox);

  const composerBox = document.createElement('div');
  composerBox.className = 'list-composer';
  composerBox.appendChild(buildComposerLaunch(list));
  wrap.appendChild(composerBox);

  wireListDrag(wrap, list, head);
  return wrap;
}

function wipClass(list) {
  if (!list.wip_limit) return '';
  const n = list.cards.length;
  if (n < list.wip_limit) return ' wip-ok';
  if (n === list.wip_limit) return ' wip-full';
  return ' wip-over';
}

function buildCard(card) {
  const el = document.createElement('article');
  el.className = 'list-card' + (cardVisiblyHidden(card) ? ' hidden' : '');
  el.dataset.cardId = card.id;

  if (card.cover) {
    const cover = document.createElement('div');
    cover.className = 'card-cover';
    cover.style.background = card.cover;
    el.appendChild(cover);
  }

  const title = document.createElement('span');
  title.className = 'list-card-title';
  title.textContent = card.title;
  el.appendChild(title);

  const badges = document.createElement('div');
  badges.className = 'card-badges';
  if (card.description) {
    const d = document.createElement('span');
    d.className = 'badge-desc';
    d.textContent = '📝';
    d.title = 'Cette carte a une description';
    badges.appendChild(d);
  }
  if (card.due_at) {
    const due = document.createElement('span');
    due.className = 'badge-due';
    if (isDueComplete(card)) due.classList.add('due-complete');
    else if (isPast(card.due_at)) due.classList.add('due-past');
    due.textContent = '📅 ' + fmtDate(card.due_at);
    due.title = 'Échéance : ' + card.due_at + (isDueComplete(card) ? ' (terminée)' : '');
    badges.appendChild(due);
  }
  for (const m of card.members) {
    const av = document.createElement('span');
    av.className = 'member-avatar';
    av.textContent = m.initials;
    av.style.background = m.color;
    av.title = m.name;
    badges.appendChild(av);
  }
  for (const l of card.labels) {
    const chip = document.createElement('span');
    chip.className = 'label-chip';
    chip.style.background = l.color;
    chip.dataset.labelId = l.id;
    chip.title = l.name;
    badges.appendChild(chip);
  }
  if (badges.children.length) el.appendChild(badges);

  // drag & drop natif
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    state.dragCardId = card.id;
    try {
      e.dataTransfer.setData('text/plain', String(card.id));
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* dispatch synthétique */ }
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => { el.classList.remove('dragging'); state.dragCardId = null; clearSlots(); });

  el.addEventListener('click', () => openModal(card.id));
  return el;
}

function buildComposerLaunch(list) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'add-card-btn';
  btn.textContent = '+ Ajouter une carte';
  btn.addEventListener('click', () => openComposer(list.id, false));
  return btn;
}

function openComposer(listId, top) {
  const wrap = $(`.list-wrapper[data-list-id="${listId}"]`);
  if (!wrap) return;
  const box = wrap.querySelector('.list-composer');
  if (!box || box.querySelector('.composer')) return;
  const launch = box.querySelector('.add-card-btn');
  if (launch) launch.remove();

  state.composerDraft[listId] = { value: '', top: !!top };

  const composer = document.createElement('div');
  composer.className = 'composer';
  const ta = document.createElement('textarea');
  ta.placeholder = 'Titre de la carte…';
  ta.addEventListener('input', () => { if (state.composerDraft[listId]) state.composerDraft[listId].value = ta.value; });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
    if (e.key === 'Escape') close();
  });
  const row = document.createElement('div');
  row.className = 'composer-row';
  const submitBtn = document.createElement('button');
  submitBtn.type = 'button';
  submitBtn.className = 'btn btn-primary';
  submitBtn.textContent = 'Ajouter';
  submitBtn.addEventListener('click', submit);
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'composer-toggle';
  toggle.title = top ? 'Ajout : en haut' : 'Ajout : en bas';
  toggle.textContent = top ? '↑' : '↓';
  toggle.addEventListener('click', () => {
    const newPos = !top;
    if (state.composerDraft[listId]) state.composerDraft[listId].top = newPos;
    const val = ta.value;
    openComposer(listId, newPos);
    const ta2 = $('.composer textarea');
    if (ta2) { ta2.value = val; ta2.focus(); }
  });
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'btn btn-ghost-dark';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('click', close);

  row.append(submitBtn, toggle, closeBtn);
  composer.append(ta, row);
  box.appendChild(composer);

  async function submit() {
    const value = ta.value.trim();
    if (!value) { ta.focus(); return; }
    const cardsBox = $(`.list-wrapper[data-list-id="${listId}"] .list-cards`);
    const existing = cardsBox ? [...cardsBox.children].map((c) => Number(c.dataset.pos)) : [];
    const min = existing.length ? Math.min(...existing) : 100;
    const max = existing.length ? Math.max(...existing) : 0;
    const pos = top ? Math.max(0, min - 50) : max + 100;
    delete state.composerDraft[listId];
    try {
      const res = await fetch('/api/cards', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ list_id: listId, title: value, pos, created_by: state.userId })
      });
      if (!res.ok) toast('Impossible d’ajouter la carte');
      buildLaunchAgain();
      refreshSoon();
    } catch { toast('Erreur réseau'); }
  }
  function buildLaunchAgain() {
    const again = buildComposerLaunch({ id: listId });
    box.appendChild(again);
  }
  function close() {
    delete state.composerDraft[listId];
    composer.remove();
    buildLaunchAgain();
  }
}

function startListRename(wrap, list) {
  const nameBtn = wrap.querySelector('.list-name');
  const input = document.createElement('input');
  input.value = list.name;
  input.style.maxWidth = '150px';
  input.className = 'list-name';
  input.style.border = '1px solid var(--hairline)';
  input.style.borderRadius = '6px';
  input.style.background = 'var(--card-bg)';
  nameBtn.replaceWith(input);
  input.focus();
  input.select();
  const done = async (commit) => {
    const name = input.value.trim();
    if (commit && name && name !== list.name) await patchList(list.id, { name });
    refreshSoon();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
}

async function patchList(id, body) {
  const res = await fetch(`/api/lists/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  refreshSoon();
  return res;
}

/* ----------------------------- Drag & drop ----------------------------- */

function wireCardDropZone(cardsBox) {
  cardsBox.addEventListener('dragover', (e) => {
    if (state.dragCardId == null) return;
    e.preventDefault();
    showSlot(cardsBox, e.clientY);
  });
  cardsBox.addEventListener('dragleave', (e) => {
    if (!cardsBox.contains(e.relatedTarget)) cardsBox.classList.remove('drag-over');
  });
  cardsBox.addEventListener('drop', async (e) => {
    if (state.dragCardId == null) return;
    e.preventDefault();
    e.stopPropagation();
    cardsBox.classList.remove('drag-over');
    clearSlots();
    const cardId = Number(e.dataTransfer.getData('text/plain')) || state.dragCardId;
    state.dragCardId = null;
    const index = slotIndex(cardsBox, e.clientY);
    const children = [...cardsBox.querySelectorAll('.list-card')].filter((c) => Number(c.dataset.cardId) !== cardId);
    let pos;
    if (!children.length) pos = 100;
    else if (index <= 0) pos = Number(children[0].dataset.pos) / 2;
    else if (index >= children.length) pos = Number(children[children.length - 1].dataset.pos) + 50;
    else pos = (Number(children[index - 1].dataset.pos) + Number(children[index].dataset.pos)) / 2;
    await fetch(`/api/cards/${cardId}/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ list_id: Number(cardsBox.dataset.listId), pos })
    });
    refreshSoon();
  });
}

function slotIndex(cardsBox, y) {
  const children = [...cardsBox.querySelectorAll('.list-card')];
  let i = 0;
  for (const c of children) {
    const r = c.getBoundingClientRect();
    if (y > r.top + r.height / 2) i++;
    else break;
  }
  return i;
}

function showSlot(cardsBox, y) {
  clearSlots();
  cardsBox.classList.add('drag-over');
  const slot = document.createElement('div');
  slot.className = 'drop-slot';
  const i = slotIndex(cardsBox, y);
  const children = [...cardsBox.querySelectorAll('.list-card')];
  if (i >= children.length) cardsBox.appendChild(slot);
  else cardsBox.insertBefore(slot, children[i]);
}

function clearSlots() {
  document.querySelectorAll('.drop-slot').forEach((s) => s.remove());
  document.querySelectorAll('.list-cards.drag-over').forEach((c) => c.classList.remove('drag-over'));
}

function wireListDrag(wrap, list, head) {
  head.addEventListener('mousedown', (e) => { if (e.target === head || e.target.closest('.list-name')) wrap.draggable = true; });
  wrap.addEventListener('dragstart', (e) => {
    if (state.dragCardId != null) { e.preventDefault(); return; }
    state.dragListId = list.id;
    try {
      e.dataTransfer.setData('text/plain', 'list:' + list.id);
      e.dataTransfer.effectAllowed = 'move';
    } catch { /* noop */ }
    wrap.classList.add('drag-ghost');
  });
  wrap.addEventListener('dragend', () => { state.dragListId = null; wrap.draggable = false; wrap.classList.remove('drag-ghost'); });
  wrap.addEventListener('dragover', (e) => {
    if (state.dragListId == null || state.dragListId === list.id) return;
    e.preventDefault();
    e.stopPropagation();
  });
  wrap.addEventListener('drop', async (e) => {
    if (state.dragListId == null || state.dragListId === list.id) return;
    e.preventDefault();
    e.stopPropagation();
    const siblings = [...scroller.querySelectorAll('.list-wrapper')].filter((w) => Number(w.dataset.listId) !== state.dragListId);
    const x = e.clientX;
    let i = 0;
    for (const w of siblings) {
      const r = w.getBoundingClientRect();
      if (x > r.left + r.width / 2) i++; else break;
    }
    const others = state.lists.filter((l) => l.id !== state.dragListId);
    let pos;
    if (!others.length) pos = 100;
    else if (i <= 0) pos = others[0].pos / 2;
    else if (i >= others.length) pos = others[others.length - 1].pos + 100;
    else pos = (others[i - 1].pos + others[i].pos) / 2;
    const dragId = state.dragListId;
    state.dragListId = null;
    await fetch(`/api/lists/${dragId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pos })
    });
    refreshSoon();
  });
}

/* ------------------------------ Popovers -------------------------------- */

function renderPopovers() {
  renderFilterPopover();
  renderMenuPopover();
}

function renderFilterPopover() {
  const lblBox = $('#filter-labels');
  lblBox.textContent = '';
  for (const l of state.labels) {
    const row = document.createElement('label');
    row.className = 'filter-label';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.filters.labels.has(l.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.labels.add(l.id); else state.filters.labels.delete(l.id);
      applyVisibility();
    });
    const dot = document.createElement('span');
    dot.className = 'filter-dot';
    dot.style.background = l.color;
    row.append(cb, dot, document.createTextNode(l.name));
    lblBox.appendChild(row);
  }
  const memBox = $('#filter-members');
  memBox.textContent = '';
  for (const m of state.members) {
    const row = document.createElement('label');
    row.className = 'filter-mem';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = state.filters.members.has(m.id);
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.members.add(m.id); else state.filters.members.delete(m.id);
      applyVisibility();
    });
    row.append(cb, document.createTextNode(m.name + ' (' + m.initials + ')'));
    memBox.appendChild(row);
  }
}

function renderMenuPopover() {
  const stats = $('#menu-stats');
  const total = state.lists.reduce((n, l) => n + l.cards.length, 0);
  stats.textContent = `${state.board ? state.board.name : ''} — ${state.lists.length} listes, ${total} cartes.`;
  const trash = $('#menu-trash');
  trash.textContent = '';
  if (!state.archived.length) {
    trash.appendChild($('#trash-empty') || document.createTextNode('La corbeille est vide.'));
    return;
  }
  for (const card of state.archived) {
    const row = document.createElement('div');
    row.className = 'trash-row';
    const name = document.createElement('span');
    name.textContent = card.title;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restaurer';
    restore.addEventListener('click', async () => {
      await fetch(`/api/cards/${card.id}/unarchive`, { method: 'POST' });
      refreshSoon();
      toast('Carte restaurée');
    });
    row.append(name, restore);
    trash.appendChild(row);
  }
}

function applyVisibility() {
  for (const list of state.lists) {
    for (const card of list.cards) {
      const el = $(`.list-card[data-card-id="${card.id}"]`);
      if (el) el.classList.toggle('hidden', cardVisiblyHidden(card));
    }
  }
}

/* -------------------------------- Modale -------------------------------- */

function findCard(id) {
  for (const list of state.lists) for (const c of list.cards) if (c.id === id) return { card: c, list };
  return null;
}

function openModal(cardId) {
  const found = findCard(cardId);
  if (!found) return;
  state.modalCardId = cardId;
  $('#modal-overlay').hidden = false;
  fillModal(found.card, found.list);
}

function closeModal() {
  state.modalCardId = null;
  $('#modal-overlay').hidden = true;
  $('#desc-hint').textContent = '';
}

function fillModal(card, list) {
  $('#modal-list-chip').textContent = list.name;
  const title = $('#modal-title');
  if (document.activeElement !== title) title.value = card.title;
  const desc = $('#modal-desc');
  if (document.activeElement !== desc) desc.value = card.description;
  $('#modal-due').value = card.due_at ? String(card.due_at).slice(0, 16) : '';
  const doneBtn = $('#modal-due-complete');
  doneBtn.classList.toggle('is-on', !!card.due_complete);

  const labelBox = $('#modal-labels');
  labelBox.textContent = '';
  const assigned = new Set(card.labels.map((l) => l.id));
  for (const l of state.labels) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'label-pick' + (assigned.has(l.id) ? ' on' : '');
    b.style.background = l.color;
    b.textContent = l.name;
    b.addEventListener('click', async () => {
      const res = await fetch(`/api/cards/${card.id}/labels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(assigned.has(l.id) ? { label_id: l.id, remove: true } : { label_id: l.id })
      });
      if (res.ok) refreshSoon();
    });
    labelBox.appendChild(b);
  }

  const memBox = $('#modal-members');
  memBox.textContent = '';
  const memIds = new Set(card.members.map((m) => m.id));
  for (const m of state.members) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mem-pick' + (memIds.has(m.id) ? ' on' : '');
    b.style.background = m.color;
    b.textContent = m.initials;
    b.title = m.name;
    b.addEventListener('click', async () => {
      const res = await fetch(`/api/cards/${card.id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(memIds.has(m.id) ? { member_id: m.id, remove: true } : { member_id: m.id })
      });
      if (res.ok) refreshSoon();
    });
    memBox.appendChild(b);
  }

  const coverBox = $('#modal-covers');
  coverBox.textContent = '';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'cover-swatch cover-none' + (!card.cover ? ' on' : '');
  none.title = 'Sans couverture';
  none.addEventListener('click', () => patchCardInModal({ cover: null }));
  coverBox.appendChild(none);
  for (const c of COVERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cover-swatch' + (card.cover === c ? ' on' : '');
    b.style.background = c;
    b.addEventListener('click', () => patchCardInModal({ cover: c }));
    coverBox.appendChild(b);
  }

  const foot = $('#modal-foot');
  foot.hidden = !isAdmin();
}

async function patchCardInModal(body) {
  if (!state.modalCardId) return;
  const res = await fetch(`/api/cards/${state.modalCardId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (res.ok) refreshSoon();
  return res;
}

/* ------------------------------- Événements ------------------------------ */

function wireStaticUI() {
  // Sélecteur d'utilisateur
  const userSel = $('#user-select');
  userSel.value = String(state.userId);
  userSel.addEventListener('focus', () => {
    userSel.textContent = '';
    for (const m of state.members) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.initials})`;
      userSel.appendChild(opt);
    }
  });
  userSel.addEventListener('change', () => {
    state.userId = Number(userSel.value);
    localStorage.setItem('laboite.user', String(state.userId));
    if (state.modalCardId) { const f = findCard(state.modalCardId); if (f) fillModal(f.card, f.list); }
  });

  // Titre du tableau
  const titleBtn = $('#board-title');
  titleBtn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.id = 'board-title-input';
    input.value = state.board.name;
    input.className = 'board-title';
    input.style.background = '#ffffff2e';
    input.style.color = 'inherit';
    titleBtn.replaceWith(input);
    input.focus();
    input.select();
    const done = async (commit) => {
      const name = input.value.trim();
      if (commit && name && name !== state.board.name) {
        await fetch(`/api/boards/${state.boardId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name })
        });
      }
      refreshSoon();
      $('#board-title-input') && input.replaceWith(titleBtn);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); });
    input.addEventListener('blur', () => done(true));
  });

  // Recherche
  const search = $('#search-input');
  const doSearch = debounce(async () => {
    const q = search.value.trim();
    if (!q) { state.searchIds = null; applyVisibility(); return; }
    const res = await fetch(`/api/board/${state.boardId}/search?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const data = await res.json();
    state.searchIds = new Set(data.results.map((c) => c.id));
    applyVisibility();
  }, 220);
  search.addEventListener('input', doSearch);
  search.addEventListener('search', doSearch);

  // Bouton + Liste
  $('#btn-add-list').addEventListener('click', () => {
    addListBtn.scrollIntoView({ behavior: 'smooth', inline: 'end' });
    addListBtn.click();
  });

  $('#add-list-card').addEventListener('click', openNewListComposer);

  canvas.addEventListener('click', (e) => {
    if (e.target.closest('.new-list-composer')) return;
    if (e.target !== $('#add-list-card')) closeNewListComposer();
  });

  // Popovers
  const popF = $('#popover-filter');
  const popM = $('#popover-menu');
  $('#btn-filter').addEventListener('click', (e) => {
    e.stopPropagation();
    popM.hidden = true;
    popF.hidden = !popF.hidden;
  });
  $('#btn-main-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    popF.hidden = true;
    renderMenuPopover();
    popM.hidden = !popM.hidden;
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover')) { popF.hidden = true; popM.hidden = true; }
  });
  $('#filter-clear').addEventListener('click', () => {
    state.filters.labels.clear();
    state.filters.members.clear();
    state.filters.due = 'any';
    const checked = $('#popover-filter').querySelectorAll('input:checked');
    for (const el of checked) el.checked = false;
    applyVisibility();
  });
  $('#popover-filter').addEventListener('change', (e) => {
    if (e.target.name === 'filter-due') {
      state.filters.due = e.target.value;
      applyVisibility();
    }
  });

  // Modale
  $('#modal-close').addEventListener('click', closeModal);
  $('#modal-overlay').addEventListener('click', (e) => { if (e.target === $('#modal-overlay')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#modal-overlay').hidden) closeModal(); });

  const modalTitle = $('#modal-title');
  const saveTitle = debounce(() => {
    if (!state.modalCardId) return;
    const v = modalTitle.value.trim();
    if (!v) return;
    patchCardInModal({ title: v });
  }, 500);
  modalTitle.addEventListener('input', saveTitle);
  modalTitle.addEventListener('keydown', (e) => { if (e.key === 'Enter') modalTitle.blur(); });

  const modalDesc = $('#modal-desc');
  const saveDesc = debounce(async () => {
    if (!state.modalCardId) return;
    const res = await patchCardInModal({ description: modalDesc.value });
    const hint = $('#desc-hint');
    if (res && res.ok) { hint.textContent = 'Enregistré ✓'; setTimeout(() => { hint.textContent = ''; }, 1500); }
  }, 650);
  modalDesc.addEventListener('input', saveDesc);

  $('#modal-due').addEventListener('change', (e) => {
    const v = e.target.value;
    patchCardInModal({ due_at: v || null });
  });
  $('#modal-due-complete').addEventListener('click', () => {
    const f = findCard(state.modalCardId);
    if (!f) return;
    patchCardInModal({ due_complete: f.card.due_complete ? 0 : 1 });
  });
  $('#modal-due-clear').addEventListener('click', () => patchCardInModal({ due_at: null }));

  const archiveBtn = $('#modal-archive');
  archiveBtn.addEventListener('click', async () => {
    const id = state.modalCardId;
    if (!id) return;
    const res = await fetch(`/api/cards/${id}`, { method: 'DELETE' });
    closeModal();
    if (res.ok) { toast('Carte mise à la corbeille'); refreshSoon(); }
  });
}

/* -------------------------- Nouvelle liste (canvas) ---------------------- */

let newListOpen = false;
function openNewListComposer() {
  if (newListOpen) return;
  newListOpen = true;
  const box = document.createElement('div');
  box.className = 'new-list-composer';
  const input = document.createElement('input');
  input.placeholder = 'Nom de la liste…';
  const row = document.createElement('div');
  row.className = 'composer-row';
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'btn btn-primary';
  add.textContent = 'Ajouter';
  add.addEventListener('click', submit);
  const closeB = document.createElement('button');
  closeB.type = 'button';
  closeB.className = 'btn btn-ghost-dark';
  closeB.textContent = '✕';
  closeB.addEventListener('click', closeNewListComposer);
  row.append(add, closeB);
  box.append(input, row);
  $('#add-list-card').insertAdjacentElement('beforebegin', box);
  input.focus();
  async function submit() {
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    await fetch('/api/lists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ board_id: Number(state.boardId), name })
    });
    closeNewListComposer();
    refreshSoon();
  }
}
function closeNewListComposer() {
  newListOpen = false;
  const box = $('#board-canvas .new-list-composer');
  if (box) box.remove();
}

/* --------------------------------- SSE ---------------------------------- */

function connectSSE() {
  const es = new EventSource(`/api/board/${state.boardId}/events`);
  es.onmessage = () => refreshSoon();
}

/* --------------------------------- Boot ---------------------------------- */

async function boot() {
  // options initiales du select utilisateur (membres connus après 1er chargement)
  await refresh();
  const sel = $('#user-select');
  if (sel.options.length === 0) {
    for (const m of state.members) {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.name} (${m.initials})`;
      sel.appendChild(opt);
    }
    sel.value = state.members.some((m) => m.id === state.userId) ? String(state.userId) : '1';
  }
  connectSSE();
  wireStaticUI();
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);