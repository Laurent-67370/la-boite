// app.js — « La Boîte » : rendu du tableau, SSE, drag & drop, modale, filtres
'use strict';

const state = {
  boardId: new URLSearchParams(location.search).get('board') || '1',
  boards: [],
  board: null,
  lists: [],
  labels: [],
  members: [],
  archived: [],
  archivedLists: [],
  backgrounds: [],
  modalDetail: null, // {card, checklists, comments, activity} de la carte ouverte
  showActivity: localStorage.getItem('laboite.showActivity') === '1',
  notifications: { unread: 0, notifications: [] },
  userId: null, // membre de la session (fourni par le serveur)
  me: null,
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

// En-têtes JSON ; l'auteur de chaque action est déduit de la session côté serveur
function jsonHeaders() {
  return { 'Content-Type': 'application/json', 'X-Requested-With': 'la-boite' };
}

function api(method, url, body) {
  return fetch(url, {
    method,
    headers: jsonHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function fmtWhen(iso) {
  const d = new Date(iso);
  const diff = (Date.now() - d.getTime()) / 1000;
  if (diff < 60) return 'à l’instant';
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return d.toLocaleString('fr-FR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function avatar(initials, color, name) {
  const av = document.createElement('span');
  av.className = 'member-avatar';
  av.textContent = initials || '?';
  av.style.background = color || '#7b8894';
  if (name) av.title = name;
  return av;
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
  state.archivedLists = data.archived_lists || [];
  state.backgrounds = data.backgrounds || [];
  renderBoard();
  renderPopovers();
  if (state.modalCardId) {
    const found = findCard(state.modalCardId);
    if (found) { fillModal(found.card, found.list); loadModalDetail(); } else closeModal();
  }
}

const refreshSoon = debounce(refresh, 90);
const loadNotificationsSoon = debounce(() => loadNotifications(), 150);
const loadBoardActivitySoon = debounce(() => loadBoardActivity(), 150);

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

  $('#board-template-chip').hidden = !state.board.is_template;

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
  if (isAdmin()) {
    const arch = document.createElement('button');
    arch.type = 'button';
    arch.className = 'collapse-btn list-archive-btn';
    arch.title = 'Mettre la liste à la corbeille (ses cartes sont conservées)';
    arch.textContent = '🗑';
    arch.addEventListener('mousedown', (e) => e.stopPropagation());
    arch.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Mettre la liste « ${list.name} » à la corbeille ? Elle pourra être restaurée avec ses cartes.`)) return;
      const res = await api('DELETE', `/api/lists/${list.id}`);
      if (res.ok) { toast('Liste mise à la corbeille'); refreshSoon(); }
    });
    head.appendChild(arch);
  }
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
  const cl = card.checklist;
  if (cl && cl.total) {
    const b = document.createElement('span');
    b.className = 'badge-check' + (cl.done === cl.total ? ' check-complete' : '');
    b.textContent = `☑ ${cl.done}/${cl.total}`;
    b.title = 'Éléments de checklist terminés';
    badges.appendChild(b);
  }
  if (card.attachments_count) {
    const b = document.createElement('span');
    b.className = 'badge-attach';
    b.textContent = `📎 ${card.attachments_count}`;
    b.title = `${card.attachments_count} pièce${card.attachments_count > 1 ? 's' : ''} jointe${card.attachments_count > 1 ? 's' : ''}`;
    badges.appendChild(b);
  }
  if (card.voters && card.voters.length) {
    const b = document.createElement('span');
    b.className = 'badge-votes' + (card.voters.includes(state.userId) ? ' is-mine' : '');
    b.textContent = `👍 ${card.voters.length}`;
    b.title = `${card.voters.length} vote${card.voters.length > 1 ? 's' : ''}`;
    badges.appendChild(b);
  }
  if (card.comments_count) {
    const b = document.createElement('span');
    b.className = 'badge-comments';
    b.textContent = `💬 ${card.comments_count}`;
    b.title = `${card.comments_count} commentaire${card.comments_count > 1 ? 's' : ''}`;
    badges.appendChild(b);
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
        headers: jsonHeaders(),
        body: JSON.stringify({ list_id: listId, title: value, pos })
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
    headers: jsonHeaders(),
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
      headers: jsonHeaders(),
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
      headers: jsonHeaders(),
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

function renderBackgrounds() {
  const box = $('#menu-backgrounds');
  box.textContent = '';
  for (const bg of state.backgrounds) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bg-swatch' + (state.board && state.board.background === bg ? ' on' : '');
    b.style.background = bg;
    b.title = 'Choisir ce fond';
    b.addEventListener('click', async (e) => {
      e.stopPropagation();
      const res = await api('PATCH', `/api/boards/${state.boardId}`, { background: bg });
      if (res.ok) refreshSoon(); else toast('Fond refusé');
    });
    box.appendChild(b);
  }
}

async function loadBoards() {
  const res = await fetch('/api/boards');
  if (!res.ok) return;
  state.boards = (await res.json()).boards;
  renderBoardsMenu();
}

function renderBoardsMenu() {
  const ul = $('#menu-boards');
  ul.textContent = '';
  for (const b of state.boards) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/?board=${b.id}`;
    a.className = 'menu-board' + (String(b.id) === String(state.boardId) ? ' is-current' : '');
    const sw = document.createElement('span');
    sw.className = 'menu-board-swatch';
    sw.style.background = b.background;
    a.append(sw, document.createTextNode(b.name));
    if (b.is_template) {
      const chip = document.createElement('span');
      chip.className = 'menu-board-tag';
      chip.textContent = 'Modèle';
      a.appendChild(chip);
    }
    li.appendChild(a);
    ul.appendChild(li);
  }
  const isTpl = !!(state.board && state.board.is_template);
  $('#menu-template-toggle').checked = isTpl;
  $('#from-template-form').hidden = !isTpl;
}

async function loadBoardActivity() {
  const res = await fetch(`/api/board/${state.boardId}/activity?limit=15`);
  if (!res.ok) return;
  const { activity } = await res.json();
  const box = $('#menu-activity');
  box.textContent = '';
  if (!activity.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'Aucune activité pour l’instant.';
    box.appendChild(li);
  }
  for (const a of activity) box.appendChild(buildActivityItem(a, true));
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
  renderBackgrounds();
  renderBoardsMenu();
  // Menu ouvert : l'activité suit les changements (restauration, archivage…)
  if (!$('#popover-menu').hidden) loadBoardActivitySoon();
  // La corbeille n'est reconstruite que si son contenu change : un bouton « Restaurer »
  // ne doit pas être remplacé sous le doigt à chaque événement temps réel.
  const trash = $('#menu-trash');
  const trashKey = JSON.stringify([state.archived, state.archivedLists]);
  if (trash.dataset.key === trashKey) return;
  trash.dataset.key = trashKey;
  trash.textContent = '';
  if (!state.archived.length && !state.archivedLists.length) {
    trash.appendChild($('#trash-empty') || document.createTextNode('La corbeille est vide.'));
    return;
  }
  for (const list of state.archivedLists) {
    const row = document.createElement('div');
    row.className = 'trash-row';
    const name = document.createElement('span');
    name.textContent = `Liste « ${list.name} » (${list.cards} carte${list.cards > 1 ? 's' : ''})`;
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.textContent = 'Restaurer';
    restore.addEventListener('click', async () => {
      await fetch(`/api/lists/${list.id}/unarchive`, { method: 'POST', headers: jsonHeaders() });
      refreshSoon();
      toast('Liste restaurée');
    });
    row.append(name, restore);
    trash.appendChild(row);
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
      await fetch(`/api/cards/${card.id}/unarchive`, { method: 'POST', headers: jsonHeaders() });
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
  if (state.modalCardId !== cardId) {
    state.modalDetail = null;
    $('#modal-comment-input').value = '';
    $('#modal-comment-save').disabled = true;
    $('#modal-checklists').textContent = '';
    $('#modal-feed').textContent = '';
  }
  state.modalCardId = cardId;
  $('#modal-overlay').hidden = false;
  $('#modal-copy-panel').hidden = true;
  fillModal(found.card, found.list);
  loadModalDetail();
}

async function loadModalDetail() {
  const id = state.modalCardId;
  if (!id) return;
  const res = await fetch(`/api/cards/${id}`);
  if (!res.ok || state.modalCardId !== id) return;
  state.modalDetail = await res.json();
  renderAttachments();
  renderChecklists();
  renderFeed();
}

function closeModal() {
  state.modalCardId = null;
  state.modalDetail = null;
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
        headers: jsonHeaders(),
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
        headers: jsonHeaders(),
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

  $('#modal-archive').hidden = !isAdmin();

  const voters = card.voters || [];
  const voteBtn = $('#modal-vote');
  const mine = voters.includes(state.userId);
  voteBtn.classList.toggle('is-on', mine);
  voteBtn.setAttribute('aria-pressed', String(mine));
  voteBtn.textContent = mine ? `👍 Voté (${voters.length})` : `👍 Voter${voters.length ? ` (${voters.length})` : ''}`;
  const vBox = $('#modal-voters');
  vBox.textContent = '';
  for (const id of voters) {
    const m = state.members.find((x) => x.id === id);
    if (m) vBox.appendChild(avatar(m.initials, m.color, m.name));
  }
  const me = state.members.find((m) => m.id === state.userId);
  const av = $('#modal-comment-avatar');
  av.textContent = me ? me.initials : '?';
  av.style.background = me ? me.color : '#7b8894';
}

/* -------------------------- Modale : pièces jointes -------------------------- */

function fmtSize(n) {
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`;
}

function renderAttachments() {
  const ul = $('#modal-attachments');
  const detail = state.modalDetail;
  if (!detail) return;
  ul.textContent = '';
  for (const a of detail.attachments || []) {
    const li = document.createElement('li');
    li.className = 'attachment';
    li.dataset.attachmentId = a.id;
    const thumb = document.createElement('a');
    thumb.className = 'attachment-thumb';
    thumb.target = '_blank';
    thumb.rel = 'noopener noreferrer';
    if (a.kind === 'link') {
      thumb.href = a.url;
      thumb.textContent = '🔗';
    } else {
      thumb.href = `/api/attachments/${a.id}/file`;
      if (a.previewable) {
        const img = document.createElement('img');
        img.src = `/api/attachments/${a.id}/file`;
        img.alt = '';
        img.loading = 'lazy';
        thumb.appendChild(img);
      } else {
        thumb.textContent = (a.name.split('.').pop() || 'fichier').slice(0, 4).toUpperCase();
      }
    }
    const body = document.createElement('div');
    body.className = 'attachment-body';
    const link = document.createElement('a');
    link.className = 'attachment-name';
    link.textContent = a.name;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.href = a.kind === 'link' ? a.url : `/api/attachments/${a.id}/file?download=1`;
    const meta = document.createElement('span');
    meta.className = 'feed-when';
    meta.textContent = [a.kind === 'file' ? fmtSize(a.size) : 'lien', a.member_name, fmtWhen(a.created_at)].filter(Boolean).join(' · ');
    body.append(link, meta);
    li.append(thumb, body);
    if (a.member_id === state.userId || isAdmin()) {
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'check-item-del attachment-del';
      del.title = 'Retirer la pièce jointe';
      del.textContent = '✕';
      del.addEventListener('click', async () => {
        if (!confirm(`Retirer « ${a.name} » ?`)) return;
        const res = await api('DELETE', `/api/attachments/${a.id}`);
        if (res.ok) refreshSoon(); else toast('Suppression refusée');
      });
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}

async function uploadAttachment(file) {
  if (!state.modalCardId || !file) return;
  const hint = $('#attach-hint');
  if (file.size > 10 * 1024 * 1024) { toast('Fichier trop lourd (10 Mo max)'); return; }
  hint.textContent = `Envoi de « ${file.name} »…`;
  const res = await fetch(`/api/cards/${state.modalCardId}/attachments`, {
    method: 'POST',
    headers: {
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name': encodeURIComponent(file.name),
      'X-Requested-With': 'la-boite'
    },
    body: file
  });
  hint.textContent = '';
  if (res.ok) refreshSoon();
  else if (res.status === 507) toast('Espace de stockage plein');
  else toast(res.status === 413 ? 'Fichier trop lourd (10 Mo max)' : 'Envoi impossible');
}

/* ---------------------------- Modale : checklists ---------------------------- */

function renderChecklists() {
  const box = $('#modal-checklists');
  const detail = state.modalDetail;
  if (!detail) return;
  // Préserve la saisie en cours (rendu déclenché par SSE pendant la frappe)
  const active = document.activeElement;
  const keep = active && box.contains(active) && active.dataset.key
    ? { key: active.dataset.key, value: active.value, sel: active.selectionStart } : null;

  box.textContent = '';
  for (const cl of detail.checklists) {
    const done = cl.items.filter((i) => i.checked).length;
    const pct = cl.items.length ? Math.round((done / cl.items.length) * 100) : 0;
    const sec = document.createElement('section');
    sec.className = 'checklist';
    sec.dataset.checklistId = cl.id;

    const head = document.createElement('div');
    head.className = 'checklist-head';
    const name = document.createElement('input');
    name.className = 'checklist-name';
    name.value = cl.name;
    name.dataset.key = `cl-name-${cl.id}`;
    name.setAttribute('aria-label', 'Nom de la checklist');
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    name.addEventListener('change', async () => {
      const v = name.value.trim();
      if (v && v !== cl.name) { await api('PATCH', `/api/checklists/${cl.id}`, { name: v }); loadModalDetail(); }
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn btn-ghost-dark btn-sm';
    del.textContent = 'Supprimer';
    del.addEventListener('click', async () => {
      if (!confirm(`Supprimer la checklist « ${cl.name} » ?`)) return;
      await api('DELETE', `/api/checklists/${cl.id}`);
      refreshSoon();
    });
    head.append(name, del);

    const prog = document.createElement('div');
    prog.className = 'checklist-progress';
    prog.innerHTML = `<span class="checklist-pct">${pct} %</span><span class="checklist-bar"><span style="width:${pct}%"></span></span>`;
    prog.classList.toggle('is-complete', cl.items.length > 0 && done === cl.items.length);

    const ul = document.createElement('ul');
    ul.className = 'check-items';
    for (const it of cl.items) {
      const li = document.createElement('li');
      li.className = 'check-item' + (it.checked ? ' is-checked' : '');
      li.dataset.itemId = it.id;
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = it.checked;
      cb.setAttribute('aria-label', it.name);
      cb.addEventListener('change', async () => {
        await api('PATCH', `/api/checkitems/${it.id}`, { checked: cb.checked });
        refreshSoon();
      });
      const label = document.createElement('span');
      label.className = 'check-item-name';
      label.textContent = it.name;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'check-item-del';
      rm.title = 'Supprimer l’élément';
      rm.textContent = '✕';
      rm.addEventListener('click', async () => { await api('DELETE', `/api/checkitems/${it.id}`); refreshSoon(); });
      li.append(cb, label, rm);
      ul.appendChild(li);
    }

    const add = document.createElement('form');
    add.className = 'check-add';
    const input = document.createElement('input');
    input.placeholder = 'Ajouter un élément…';
    input.dataset.key = `cl-add-${cl.id}`;
    input.setAttribute('aria-label', 'Nouvel élément');
    const ok = document.createElement('button');
    ok.type = 'submit';
    ok.className = 'btn btn-primary btn-sm';
    ok.textContent = 'Ajouter';
    add.append(input, ok);
    add.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      await api('POST', `/api/checklists/${cl.id}/items`, { name: v });
      refreshSoon();
    });

    sec.append(head, prog, ul, add);
    box.appendChild(sec);
  }

  if (keep) {
    const el = box.querySelector(`[data-key="${keep.key}"]`);
    if (el) { el.value = keep.value; el.focus(); try { el.setSelectionRange(keep.sel, keep.sel); } catch { /* noop */ } }
  }
}

/* ----------------------- Modale : commentaires et activité ------------------- */

function buildActivityItem(a, withCard) {
  const li = document.createElement('li');
  li.className = 'feed-item feed-activity';
  li.appendChild(avatar(a.member_initials, a.member_color, a.member_name));
  const body = document.createElement('div');
  body.className = 'feed-body';
  const line = document.createElement('div');
  const who = document.createElement('strong');
  who.textContent = a.member_name || 'Quelqu’un';
  line.append(who, document.createTextNode(' ' + a.text));
  if (withCard && a.card_title) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'feed-card-link';
    c.textContent = a.card_title;
    c.addEventListener('click', () => openModal(a.card_id));
    line.append(document.createTextNode(' — '), c);
  }
  const when = document.createElement('time');
  when.className = 'feed-when';
  when.dateTime = a.created_at;
  when.textContent = fmtWhen(a.created_at);
  body.append(line, when);
  li.appendChild(body);
  return li;
}

function buildCommentItem(co) {
  const li = document.createElement('li');
  li.className = 'feed-item feed-comment';
  li.dataset.commentId = co.id;
  li.appendChild(avatar(co.member_initials, co.member_color, co.member_name));
  const body = document.createElement('div');
  body.className = 'feed-body';
  const head = document.createElement('div');
  const who = document.createElement('strong');
  who.textContent = co.member_name || 'Quelqu’un';
  const when = document.createElement('time');
  when.className = 'feed-when';
  when.dateTime = co.created_at;
  when.textContent = fmtWhen(co.created_at) + (co.edited_at ? ' (modifié)' : '');
  head.append(who, document.createTextNode(' '), when);
  const bubble = document.createElement('div');
  bubble.className = 'comment-bubble';
  bubble.textContent = co.text;
  body.append(head, bubble);

  const mine = co.member_id === state.userId;
  if (mine || isAdmin()) {
    const actions = document.createElement('div');
    actions.className = 'comment-actions';
    if (mine) {
      const edit = document.createElement('button');
      edit.type = 'button';
      edit.textContent = 'Modifier';
      edit.addEventListener('click', () => startCommentEdit(bubble, co));
      actions.appendChild(edit);
    }
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = 'Supprimer';
    del.addEventListener('click', async () => {
      if (!confirm('Supprimer ce commentaire ?')) return;
      const res = await api('DELETE', `/api/comments/${co.id}`);
      if (res.ok) refreshSoon(); else toast('Suppression refusée');
    });
    actions.appendChild(del);
    body.appendChild(actions);
  }
  li.appendChild(body);
  return li;
}

function startCommentEdit(bubble, co) {
  const ta = document.createElement('textarea');
  ta.className = 'comment-edit';
  ta.value = co.text;
  ta.rows = 2;
  bubble.replaceWith(ta);
  ta.focus();
  const finish = async (commit) => {
    const v = ta.value.trim();
    if (commit && v && v !== co.text) {
      const res = await api('PATCH', `/api/comments/${co.id}`, { text: v });
      if (!res.ok) toast('Modification refusée');
    }
    loadModalDetail();
    refreshSoon();
  };
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
  });
  ta.addEventListener('blur', () => finish(true), { once: true });
}

function renderFeed() {
  const detail = state.modalDetail;
  if (!detail) return;
  const toggle = $('#modal-activity-toggle');
  toggle.textContent = state.showActivity ? 'Masquer les détails' : 'Afficher les détails';
  toggle.setAttribute('aria-pressed', String(state.showActivity));
  // Un commentaire en cours d'édition ne doit pas être écrasé
  if ($('#modal-feed .comment-edit')) return;
  const items = detail.comments.map((c) => ({ at: c.created_at, el: () => buildCommentItem(c) }));
  if (state.showActivity) {
    for (const a of detail.activity) items.push({ at: a.created_at, el: () => buildActivityItem(a, false) });
  }
  items.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0));
  const feed = $('#modal-feed');
  feed.textContent = '';
  for (const it of items) feed.appendChild(it.el());
}

/* ------------------------------ Modale : copie -------------------------------- */

function openCopyPanel() {
  const f = findCard(state.modalCardId);
  if (!f) return;
  const panel = $('#modal-copy-panel');
  $('#copy-title').value = f.card.title;
  const sel = $('#copy-list');
  sel.textContent = '';
  for (const l of state.lists) {
    const o = document.createElement('option');
    o.value = l.id;
    o.textContent = l.name;
    sel.appendChild(o);
  }
  sel.value = String(f.list.id);
  panel.hidden = false;
  $('#copy-title').focus();
}

/* -------------------------------- Notifications ------------------------------ */

async function loadNotifications() {
  const res = await fetch(`/api/members/${state.userId}/notifications`);
  if (!res.ok) return;
  state.notifications = await res.json();
  renderNotifications();
}

function renderNotifications() {
  const { unread, notifications } = state.notifications;
  const badge = $('#notif-count');
  badge.hidden = !unread;
  badge.textContent = unread > 9 ? '9+' : String(unread);
  $('#btn-notif').title = unread ? `${unread} notification${unread > 1 ? 's' : ''} non lue${unread > 1 ? 's' : ''}` : 'Notifications';
  const list = $('#notif-list');
  list.textContent = '';
  if (!notifications.length) {
    const li = document.createElement('li');
    li.className = 'feed-empty';
    li.textContent = 'Rien de nouveau.';
    list.appendChild(li);
    return;
  }
  for (const n of notifications) {
    const li = document.createElement('li');
    li.className = 'notif-item' + (n.read ? '' : ' is-unread');
    li.appendChild(avatar(n.actor_initials, n.actor_color));
    const body = document.createElement('button');
    body.type = 'button';
    body.className = 'notif-body';
    const t = document.createElement('span');
    t.textContent = n.text;
    const when = document.createElement('time');
    when.className = 'feed-when';
    when.textContent = fmtWhen(n.created_at);
    body.append(t, when);
    body.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!n.read) await api('POST', `/api/members/${state.userId}/notifications/read`, { ids: [n.id] });
      $('#popover-notif').hidden = true;
      if (n.card_id && String(n.board_id) === String(state.boardId)) openModal(n.card_id);
      else if (n.card_id) { location.href = `/?board=${n.board_id}&card=${n.card_id}`; return; }
      loadNotifications();
    });
    li.appendChild(body);
    list.appendChild(li);
  }
}

async function patchCardInModal(body) {
  if (!state.modalCardId) return;
  const res = await fetch(`/api/cards/${state.modalCardId}`, {
    method: 'PATCH',
    headers: jsonHeaders(),
    body: JSON.stringify(body)
  });
  if (res.ok) refreshSoon();
  return res;
}

/* ------------------------------- Événements ------------------------------ */

function wireStaticUI() {
  // Session
  $('#btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST', headers: jsonHeaders() });
    location.reload();
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
          headers: jsonHeaders(),
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
  const popN = $('#popover-notif');
  $('#btn-filter').addEventListener('click', (e) => {
    e.stopPropagation();
    popM.hidden = true;
    popN.hidden = true;
    popF.hidden = !popF.hidden;
  });
  $('#btn-main-menu').addEventListener('click', (e) => {
    e.stopPropagation();
    popF.hidden = true;
    popN.hidden = true;
    renderMenuPopover();
    popM.hidden = !popM.hidden;
    if (!popM.hidden) { loadBoardActivity(); loadBoards(); }
  });
  $('#btn-notif').addEventListener('click', (e) => {
    e.stopPropagation();
    popF.hidden = true;
    popM.hidden = true;
    popN.hidden = !popN.hidden;
    if (!popN.hidden) loadNotifications();
  });
  $('#notif-read-all').addEventListener('click', async (e) => {
    e.stopPropagation();
    await api('POST', `/api/members/${state.userId}/notifications/read`, {});
    loadNotifications();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.popover')) { popF.hidden = true; popM.hidden = true; popN.hidden = true; }
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
    const res = await fetch(`/api/cards/${id}`, { method: 'DELETE', headers: jsonHeaders() });
    closeModal();
    if (res.ok) { toast('Carte mise à la corbeille'); refreshSoon(); }
  });

  // Votes
  $('#modal-vote').addEventListener('click', async () => {
    const f = findCard(state.modalCardId);
    if (!f) return;
    const mine = (f.card.voters || []).includes(state.userId);
    const res = await api('POST', `/api/cards/${f.card.id}/votes`, mine ? { remove: true } : {});
    if (res.ok) refreshSoon();
  });

  // Pièces jointes : sélecteur, glisser-déposer d'un fichier sur la modale, lien
  const fileInput = $('#modal-attach-file');
  fileInput.addEventListener('change', async () => {
    for (const f of fileInput.files) await uploadAttachment(f);
    fileInput.value = '';
  });
  const modal = $('#card-modal');
  modal.addEventListener('dragover', (e) => {
    if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { e.preventDefault(); modal.classList.add('file-over'); }
  });
  modal.addEventListener('dragleave', (e) => { if (!modal.contains(e.relatedTarget)) modal.classList.remove('file-over'); });
  modal.addEventListener('drop', async (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    modal.classList.remove('file-over');
    for (const f of e.dataTransfer.files) await uploadAttachment(f);
  });
  $('#modal-attach-link').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#modal-attach-url');
    const url = input.value.trim();
    if (!url || !state.modalCardId) return;
    const res = await api('POST', `/api/cards/${state.modalCardId}/attachments`, { url });
    if (res.ok) { input.value = ''; refreshSoon(); } else toast('Lien refusé (http ou https uniquement)');
  });

  // Tableaux et modèles
  $('#new-board-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#new-board-name').value.trim();
    if (!name) return;
    const res = await api('POST', '/api/boards', { name });
    if (res.ok) location.href = `/?board=${(await res.json()).board.id}`;
  });
  $('#menu-template-toggle').addEventListener('change', async (e) => {
    await api('PATCH', `/api/boards/${state.boardId}`, { is_template: e.target.checked });
    await refresh();
    loadBoards();
  });
  $('#from-template-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('#from-template-name').value.trim();
    const res = await api('POST', `/api/boards/${state.boardId}/copy`, { name });
    if (res.ok) location.href = `/?board=${(await res.json()).board.id}`;
    else toast('Création impossible');
  });

  // Checklists
  $('#modal-add-checklist').addEventListener('click', async () => {
    if (!state.modalCardId) return;
    const res = await api('POST', `/api/cards/${state.modalCardId}/checklists`, { name: 'Checklist' });
    if (!res.ok) return;
    const { checklist } = await res.json();
    await loadModalDetail();
    const input = $(`[data-key="cl-add-${checklist.id}"]`);
    if (input) input.focus();
    refreshSoon();
  });

  // Commentaires
  const commentInput = $('#modal-comment-input');
  const commentSave = $('#modal-comment-save');
  commentInput.addEventListener('input', () => { commentSave.disabled = !commentInput.value.trim(); });
  const sendComment = async () => {
    const text = commentInput.value.trim();
    if (!text || !state.modalCardId) return;
    commentSave.disabled = true;
    const res = await api('POST', `/api/cards/${state.modalCardId}/comments`, { text });
    if (res.ok) { commentInput.value = ''; loadModalDetail(); refreshSoon(); }
    else { toast('Commentaire non enregistré'); commentSave.disabled = false; }
  };
  commentSave.addEventListener('click', sendComment);
  commentInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendComment(); }
  });
  $('#modal-activity-toggle').addEventListener('click', () => {
    state.showActivity = !state.showActivity;
    try { localStorage.setItem('laboite.showActivity', state.showActivity ? '1' : '0'); } catch { /* noop */ }
    renderFeed();
  });

  // Copie
  $('#modal-copy').addEventListener('click', openCopyPanel);
  $('#copy-cancel').addEventListener('click', () => { $('#modal-copy-panel').hidden = true; });
  $('#modal-copy-panel').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.modalCardId) return;
    const res = await api('POST', `/api/cards/${state.modalCardId}/copy`, {
      title: $('#copy-title').value.trim(),
      list_id: Number($('#copy-list').value),
      keep: {
        checklists: $('#copy-keep-checklists').checked,
        labels: $('#copy-keep-labels').checked,
        members: $('#copy-keep-members').checked
      }
    });
    if (!res.ok) { toast('Copie impossible'); return; }
    const { card } = await res.json();
    $('#modal-copy-panel').hidden = true;
    toast('Carte copiée');
    await refresh();
    openModal(card.id);
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
      headers: jsonHeaders(),
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
  es.onmessage = (e) => {
    let msg = null;
    try { msg = JSON.parse(e.data); } catch { /* commentaire SSE */ }
    if (msg && msg.type === 'notification') {
      if (!msg.members || msg.members.includes(state.userId)) loadNotificationsSoon();
      return;
    }
    refreshSoon();
    if (msg && msg.type === 'card') loadNotificationsSoon();
  };
}

/* --------------------------------- Boot ---------------------------------- */

/* ------------------------------- Connexion -------------------------------- */

// Toute réponse 401 (session expirée, déconnexion ailleurs) ramène à l'écran de connexion
const nativeFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const res = await nativeFetch(input, init);
  const url = typeof input === 'string' ? input : input.url;
  if (res.status === 401 && !url.includes('/api/auth/')) showLogin();
  return res;
};

let loginShown = false;
async function showLogin() {
  if (loginShown) return;
  loginShown = true;
  const overlay = $('#login-overlay');
  overlay.hidden = false;
  const box = $('#login-members');
  box.textContent = '';
  let chosen = null;
  try {
    const { members } = await (await nativeFetch('/api/auth/members')).json();
    for (const m of members) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'login-member';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', 'false');
      b.dataset.memberId = m.id;
      b.append(avatar(m.initials, m.color), document.createTextNode(m.name));
      b.addEventListener('click', () => {
        chosen = m.id;
        for (const o of box.children) o.setAttribute('aria-checked', String(o === b));
        $('#login-code').focus();
      });
      box.appendChild(b);
    }
  } catch { $('#login-error').textContent = 'Serveur injoignable.'; }
  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    if (!chosen) { err.textContent = 'Choisissez votre nom.'; return; }
    const res = await nativeFetch('/api/auth/login', {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ member_id: chosen, code: $('#login-code').value })
    });
    if (res.ok) { location.reload(); return; }
    $('#login-code').value = '';
    err.textContent = res.status === 429
      ? 'Trop d’essais : réessayez dans 15 minutes.'
      : 'Code incorrect.';
  });
}

function renderMe() {
  const me = state.me;
  const av = $('#me-avatar');
  av.textContent = me.initials;
  av.style.background = me.color;
  $('#me-name').textContent = me.name;
}

async function boot() {
  const meRes = await nativeFetch('/api/auth/me');
  if (!meRes.ok) { showLogin(); return; }
  state.me = (await meRes.json()).member;
  state.userId = state.me.id;
  renderMe();
  await refresh();
  connectSSE();
  wireStaticUI();
  loadNotifications();
  loadBoards();
  const cardParam = Number(new URLSearchParams(location.search).get('card'));
  if (cardParam) openModal(cardParam);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

document.addEventListener('DOMContentLoaded', boot);