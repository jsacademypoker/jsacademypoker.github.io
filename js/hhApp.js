/** Client Supabase : le bundle UMD doit être chargé avant ce fichier (voir index.html). */
function hhCreateClient(url, key) {
  if (!window.supabase || typeof window.supabase.createClient !== 'function') {
    throw new Error('SDK Supabase non chargé (script dist/umd/supabase.js manquant).');
  }
  return window.supabase.createClient(url, key);
}

const $ = (id) => document.getElementById(id);
const RN = () => window.HHReplayCore;
const HE = () => window.HHEngine;
const HC = () => window.HHCards;
const TP = () => window.TablePositions;

const LOGO_BACK = 'assets/logo-js-academy.png';

const state = {
  mode: 'list',
  sb: null,
  draft: null,
  listRows: [],
  viewQueue: [],
  viewHandIndex: 0,
  viewActionCursor: 0,
  /** Visualiser : sièges (indices) dont l’utilisateur masque les cartes (dos) tant que la révélation forcée ne s’applique pas */
  viewHoleHidden: new Set(),
  /** Visualiser : mains déjà chargées depuis Supabase (clé = id) */
  viewHandCache: new Map(),
  /** Création : après validation des paramètres, le bloc se replie tant qu’une main (draft) existe */
  setupCollapsed: false,
  /** Tags distincts déjà vus (liste + fetch `hands.tags`) pour la liste déroulante en création */
  knownTags: [],
  /** Dossiers HH (table hh_folders) */
  folderRows: [],
  /** Dossier cible (création, + Dossier, suppression) ; null = racine / « Non classées » */
  listTargetFolderId: null,
  listExpandedFolderIds: new Set(),
  /** Prochaine main créée via « Créer une main » depuis la liste : classement dans ce dossier */
  assignFolderFromListToNextDraft: false,
  folderForNextNewDraft: null,
};

/** Clé d’expansion pour la section « Non classées » dans listExpandedFolderIds */
const LIST_UC_EXPAND_KEY = '__hh_uc__';

/** Libellé affiché pour les mains sans dossier (non persisté en base). */
const LIST_UC_LABEL = 'Non classées';

const HH_ICON_PLAY =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
const HH_ICON_EDIT =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>';
const HH_ICON_DELETE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';
const HH_ICON_NEW_FOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V8c0-1.11-.89-2-2-2zm-1 8h-3v3h-2v-3h-3v-2h3V9h2v3h3v2z"/></svg>';
const HH_ICON_NEW_HAND =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zm2 14h-3v3h-2v-3h-3v-2h3V9h2v5h3v2zm-3-7V3.5L18.5 9H13z"/></svg>';

function hhIconButton(classNames, svgHtml, ariaLabel) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = classNames;
  b.setAttribute('aria-label', ariaLabel);
  b.innerHTML = '<span class="hh-btn-icon" aria-hidden="true">' + svgHtml + '</span>';
  return b;
}

/** État du sélecteur matriciel (trous ou board). */
const cardPickerState = {
  type: null,
  seat: null,
  needed: 0,
  boardKind: null,
  selected: [],
};

let saveHandInFlight = false;

function cfg() {
  const c = typeof window !== 'undefined' && window.HH_SUPABASE ? window.HH_SUPABASE : {};
  return { url: c.url || '', anonKey: c.anonKey || '' };
}

function setMsg(text, kind) {
  const el = $('msg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.remove('is-err', 'is-ok');
  if (kind === 'err') el.classList.add('is-err');
  if (kind === 'ok') el.classList.add('is-ok');
}

function setRaiseFeedback(text) {
  const el = $('raise-feedback');
  if (!el) return;
  const t = (text || '').trim();
  el.textContent = t;
  el.hidden = !t;
}

function emptyDraft() {
  return {
    id: null,
    title: '',
    player_count: 6,
    first_to_act: 0,
    small_blind_bb: 0.5,
    big_blind_bb: 1,
    dead_money_bb: 0,
    tags: [],
    stacks_bb: [],
    antes_bb: [],
    player_names: [],
    hole_cards: {},
    timeline: [],
    folder_id: null,
  };
}

function totalActions(tl) {
  return HE().totalActionCount(tl);
}

function lastTimelineEvent(tl) {
  const t = tl || [];
  for (let i = t.length - 1; i >= 0; i -= 1) if (t[i] && t[i].kind) return t[i];
  return null;
}

function needsBoardAfterRoundEnd(hand) {
  const last = lastTimelineEvent(hand.timeline);
  if (!last || last.kind !== 'ROUND_END') return false;
  const st = HE().computeHandState(hand, totalActions(hand.timeline));
  if (st.street === 'FLOP' && st.board.flop.length < 3) return true;
  if (st.street === 'TURN' && st.board.turn == null) return true;
  if (st.street === 'RIVER' && st.board.river == null) return true;
  return false;
}

function nextBoardKind(hand) {
  const st = HE().computeHandState(hand, totalActions(hand.timeline));
  if (st.board.flop.length < 3) return 'flop';
  if (st.board.turn == null) return 'turn';
  if (st.board.river == null) return 'river';
  return null;
}

/**
 * Tronque la timeline après la `keepActionCount`‑ième action (incluse) ; enlève tout BOARD / ROUND_END
 * qui suivent cette action (pour rester cohérent en remontant le fil d’Ariane).
 */
function trimTimelineToActionCount(timeline, keepActionCount) {
  const tl = Array.isArray(timeline) ? timeline : [];
  if (keepActionCount <= 0) return [];
  const tot = HE().totalActionCount(tl);
  if (keepActionCount >= tot) return tl.slice();
  let idxEnd = -1;
  let seen = 0;
  for (let i = 0; i < tl.length; i += 1) {
    const ev = tl[i];
    if (ev && ev.kind === 'ACTION' && typeof ev.label === 'string') {
      seen += 1;
      idxEnd = i;
      if (seen >= keepActionCount) break;
    }
  }
  if (idxEnd < 0) return [];
  return tl.slice(0, idxEnd + 1);
}

function removeTrailingActions(timeline, removeCount) {
  const total = HE().totalActionCount(timeline);
  const keep = Math.max(0, total - removeCount);
  return trimTimelineToActionCount(timeline, keep);
}

/**
 * Création : fil d’Ariane — tronque après la (idx+1)‑ième action.
 * Si le tour d’enchères est clos sans événement ROUND_END (troncature), enchaîne
 * comme après une action normale : Fin de tour + modale board si besoin.
 */
function navigateBreadcrumbToActionIndex(clickedActionIndex) {
  if (!state.draft) return;
  const total = HE().totalActionCount(state.draft.timeline);
  const remove = total - (clickedActionIndex + 1);
  state.draft.timeline = removeTrailingActions(state.draft.timeline, remove);
  const ac = totalActions(state.draft.timeline);
  const last = lastTimelineEvent(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);
  if (last && last.kind === 'ACTION' && st.canCloseRound && !st.isHandFinished) {
    pushRoundEnd();
  } else {
    renderCreateUi();
  }
}

/** Création : une action en moins (équivalent à reculer d’un cran dans le fil d’Ariane). */
function goBackOneCreateBreadcrumbStep() {
  if (!state.draft) return;
  const total = HE().totalActionCount(state.draft.timeline);
  if (total <= 0) return;
  state.draft.timeline = removeTrailingActions(state.draft.timeline, 1);
  const ac = totalActions(state.draft.timeline);
  const last = lastTimelineEvent(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);
  if (last && last.kind === 'ACTION' && st.canCloseRound && !st.isHandFinished) {
    pushRoundEnd();
  } else {
    renderCreateUi();
  }
}

function openRaiseRowForLegal(raiseLeg) {
  const raiseRow = $('raise-row');
  if (!raiseRow || !raiseLeg) return;
  setRaiseFeedback('');
  raiseRow.hidden = false;
  const inp = $('raise-amount');
  if (inp) {
    inp.min = String(raiseLeg.minTotal);
    inp.max = String(raiseLeg.maxTotal);
    inp.value = String(raiseLeg.minTotal);
    inp.setAttribute(
      'aria-label',
      raiseLeg.openBet ? 'Montant total du bet en big blinds' : 'Montant total du raise en big blinds'
    );
    inp.placeholder = raiseLeg.openBet ? 'Bet (bb)' : 'Raise (bb)';
    inp.focus();
    inp.select();
  }
}

function fillFirstActSelect(n) {
  const sel = $('setup-first-act');
  if (!sel) return;
  sel.innerHTML = '';
  const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
  const labels = TP().positionLabelsForPlayerCount(nn);
  for (let i = 0; i < labels.length; i += 1) {
    const o = document.createElement('option');
    o.value = String(i);
    o.textContent = labels[i];
    sel.appendChild(o);
  }
  /** Premier à parler par défaut : siège après la BB (ex. LJ à 6 joueurs). */
  sel.value = String(TP().defaultFirstToActIndex(nn));
}

function renderSetupGrids(n) {
  const stacks = $('setup-stacks');
  const antes = $('setup-antes');
  if (!stacks || !antes) return;
  stacks.innerHTML = '';
  antes.innerHTML = '';
  const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
  const labels = TP().positionLabelsForPlayerCount(nn);
  const blinds = TP().blindSeatIndices(nn);
  for (let i = 0; i < nn; i += 1) {
    const dSt = state.draft;
    const wrapS = document.createElement('div');
    const labS = document.createElement('label');
    labS.className = 'hh-label';
    labS.textContent = labels[i];
    const inpName = document.createElement('input');
    inpName.className = 'hh-input hh-setup-player-name';
    inpName.type = 'text';
    inpName.maxLength = 48;
    inpName.placeholder = 'Nom (facultatif)';
    inpName.dataset.seat = String(i);
    inpName.setAttribute('autocomplete', 'off');
    const prevNm =
      dSt && Array.isArray(dSt.player_names) && typeof dSt.player_names[i] === 'string'
        ? dSt.player_names[i]
        : '';
    inpName.value = prevNm;
    const inpS = document.createElement('input');
    inpS.className = 'hh-input hh-setup-stack';
    inpS.type = 'number';
    inpS.step = '0.01';
    inpS.min = '0';
    inpS.dataset.seat = String(i);
    const prevStack =
      dSt && Array.isArray(dSt.stacks_bb) && dSt.stacks_bb.length >= nn
        ? Number(dSt.stacks_bb[i]) || 0
        : null;
    inpS.value = prevStack != null && prevStack > 0 ? String(prevStack) : '100';
    wrapS.appendChild(labS);
    wrapS.appendChild(inpName);
    wrapS.appendChild(inpS);
    stacks.appendChild(wrapS);

    const wrapA = document.createElement('div');
    const labA = document.createElement('label');
    labA.className = 'hh-label';
    labA.textContent = labels[i];
    const inpA = document.createElement('input');
    inpA.className = 'hh-input';
    inpA.type = 'number';
    inpA.step = '0.01';
    inpA.min = '0';
    inpA.dataset.seat = String(i);
    const d = state.draft;
    const prevMises =
      d && Array.isArray(d.antes_bb) && d.antes_bb.length >= nn ? Number(d.antes_bb[i]) : null;
    if (prevMises != null && !Number.isNaN(prevMises)) {
      inpA.value = String(prevMises);
    } else if (i === blinds.sb) {
      inpA.value = '0.5';
    } else if (i === blinds.bb) {
      inpA.value = '1';
    } else {
      inpA.value = '0';
    }
    wrapA.appendChild(labA);
    wrapA.appendChild(inpA);
    antes.appendChild(wrapA);
  }
}

function readSetupForm() {
  const f = $('form-setup');
  if (!f) return null;
  const fd = new FormData(f);
  const n = Math.max(2, Math.min(10, Math.floor(Number(fd.get('player_count'))) || 6));
  const sb = Number(fd.get('small_blind_bb'));
  const bb = Number(fd.get('big_blind_bb'));
  if (!(sb > 0) || !(bb > 0) || sb > bb) {
    setMsg('Blindes invalides (positives, petite blinde ≤ grosse blinde).', 'err');
    return null;
  }
  const stacks_bb = [];
  const antes_bb = [];
  const player_names = [];
  for (let i = 0; i < n; i += 1) player_names[i] = '';
  $('setup-stacks').querySelectorAll('input.hh-setup-player-name').forEach((inp) => {
    const si = Number(inp.dataset.seat);
    if (si >= 0 && si < n) player_names[si] = String(inp.value || '').trim();
  });
  $('setup-stacks').querySelectorAll('input.hh-setup-stack').forEach((inp) => {
    stacks_bb[Number(inp.dataset.seat)] = Math.max(0, Number(inp.value) || 0);
  });
  $('setup-antes').querySelectorAll('input').forEach((inp) => {
    antes_bb[Number(inp.dataset.seat)] = Math.max(0, Number(inp.value) || 0);
  });
  const fta = Math.max(0, Math.min(n - 1, Math.floor(Number(fd.get('first_to_act'))) || 0));
  return {
    player_count: n,
    small_blind_bb: sb,
    big_blind_bb: bb,
    dead_money_bb: Math.max(0, Number(fd.get('dead_money_bb')) || 0),
    first_to_act: fta,
    stacks_bb,
    antes_bb,
    player_names,
  };
}

/** Barre création (visible sans éditeur) : évite de garder l’ID / titre d’une HH annulée. */
function syncCreateToolbarForFreshSession() {
  const idEl = $('create-hand-id');
  if (idEl) idEl.textContent = 'Nouvelle main (non enregistrée)';
  const titleEl = $('hand-title');
  if (titleEl) titleEl.value = '';
}

function resetSetupFormToDefaults() {
  const f = $('form-setup');
  if (!f) return;
  const d = emptyDraft();
  const pcInp = f.querySelector('[name="player_count"]');
  if (pcInp) pcInp.value = String(HE().clampN(d.player_count));
  const sbIn = f.querySelector('[name="small_blind_bb"]');
  const bbIn = f.querySelector('[name="big_blind_bb"]');
  const dmIn = f.querySelector('[name="dead_money_bb"]');
  if (sbIn) sbIn.value = String(d.small_blind_bb);
  if (bbIn) bbIn.value = String(d.big_blind_bb);
  if (dmIn) dmIn.value = String(d.dead_money_bb);
  const n = HE().clampN(d.player_count);
  fillFirstActSelect(n);
  renderSetupGrids(n);
}

function cancelCreateHand() {
  if (state.mode !== 'create') return;
  const hadDraft = !!state.draft;
  state.assignFolderFromListToNextDraft = false;
  closeCardPickerModal();
  state.draft = null;
  state.setupCollapsed = false;
  if ($('create-editor')) $('create-editor').hidden = true;
  syncCreateToolbarForFreshSession();
  resetSetupFormToDefaults();
  updateCreateSetupPanelDom();
  setMode('list');
  if (hadDraft) setMsg('Création annulée.', 'ok');
}

function populateSetupFormFields() {
  const f = $('form-setup');
  if (!f) return;
  const d = state.draft;
  const pcInp = f.querySelector('[name="player_count"]');
  if (d && pcInp) {
    pcInp.value = String(HE().clampN(d.player_count));
    const sbIn = f.querySelector('[name="small_blind_bb"]');
    const bbIn = f.querySelector('[name="big_blind_bb"]');
    const dmIn = f.querySelector('[name="dead_money_bb"]');
    if (sbIn) sbIn.value = String(d.small_blind_bb ?? 0.5);
    if (bbIn) bbIn.value = String(d.big_blind_bb ?? 1);
    if (dmIn) dmIn.value = String(d.dead_money_bb ?? 0);
  }
  const n = Math.max(2, Math.min(10, Math.floor(Number(pcInp && pcInp.value)) || 6));
  fillFirstActSelect(n);
  const fta = $('setup-first-act');
  if (fta && d) fta.value = String(Math.max(0, Math.min(n - 1, Math.floor(Number(d.first_to_act)) || 0)));
  renderSetupGrids(n);
}

function populateSetupSummary() {
  const el = $('create-setup-summary');
  if (!el || !state.draft) return;
  const n = HE().clampN(state.draft.player_count);
  const sb = state.draft.small_blind_bb;
  const bb = state.draft.big_blind_bb;
  el.textContent = n + ' joueurs · blinds ' + sb + '/' + bb + ' bb';
}

function updateCreateSetupPanelDom() {
  const shell = $('create-setup-form-shell');
  const bar = $('create-setup-collapsed-bar');
  const cancelBtn = $('setup-cancel');
  if (!shell || !bar) return;
  const hasDraft = !!state.draft;
  const collapsed = hasDraft && state.setupCollapsed;
  shell.hidden = collapsed;
  bar.hidden = !collapsed;
  if (cancelBtn) cancelBtn.hidden = !hasDraft || collapsed;
}

function expandSetupPanel() {
  state.setupCollapsed = false;
  populateSetupFormFields();
  updateCreateSetupPanelDom();
}

function collapseSetupPanel() {
  if (!state.draft) return;
  state.setupCollapsed = true;
  populateSetupSummary();
  updateCreateSetupPanelDom();
}

function onPlayerCountInput() {
  const f = $('form-setup');
  if (!f) return;
  const pcInp = f.querySelector('[name="player_count"]');
  const n = Math.max(2, Math.min(10, Math.floor(Number(pcInp && pcInp.value)) || 6));
  fillFirstActSelect(n);
  renderSetupGrids(n);
}

function usedSetForHolePickerSeat(seat) {
  const u = new Set(HC().usedSetFromHand(state.draft));
  const cur = state.draft.hole_cards[String(seat)];
  if (Array.isArray(cur)) cur.forEach((c) => c && u.delete(c));
  return u;
}

function refreshCardPickerMatrix() {
  const root = $('card-picker-matrix');
  if (!root) return;
  root.innerHTML = '';
  const ranks = HC().MATRIX_RANK_COLS;
  const suits = HC().MATRIX_SUIT_ROWS;
  const usedBase =
    cardPickerState.type === 'hole' && cardPickerState.seat != null
      ? usedSetForHolePickerSeat(cardPickerState.seat)
      : new Set(HC().usedSetFromHand(state.draft));
  const grid = document.createElement('div');
  grid.className = 'hh-card-matrix';
  const corner = document.createElement('div');
  corner.className = 'hh-card-matrix-corner';
  grid.appendChild(corner);
  ranks.forEach((r) => {
    const h = document.createElement('div');
    h.className = 'hh-card-matrix-head';
    h.textContent = HC().rankDisplay(r);
    grid.appendChild(h);
  });
  suits.forEach((suit) => {
    const rowLab = document.createElement('div');
    rowLab.className = 'hh-card-matrix-rowhead';
    rowLab.textContent = HC().SUITS[suit];
    rowLab.setAttribute('aria-label', suit === 's' ? 'Pique' : suit === 'h' ? 'Cœur' : suit === 'd' ? 'Carreau' : 'Trèfle');
    grid.appendChild(rowLab);
    ranks.forEach((rank) => {
      const code = rank + suit;
      const selIdx = cardPickerState.selected.indexOf(code);
      const isSel = selIdx >= 0;
      const blocked = usedBase.has(code) && !isSel;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'hh-card-matrix-cell ' + HC().suitClass(suit);
      if (blocked) btn.classList.add('is-blocked');
      if (isSel) btn.classList.add('is-selected');
      btn.disabled = blocked && !isSel;
      btn.dataset.card = code;
      const inner = document.createElement('span');
      inner.className = 'hh-card-matrix-cell-inner';
      const rankSpan = document.createElement('span');
      rankSpan.className = 'hh-card-matrix-rank';
      rankSpan.textContent = HC().rankDisplay(rank);
      const suitSpan = document.createElement('span');
      suitSpan.className = 'hh-card-matrix-suit';
      suitSpan.textContent = HC().SUITS[suit];
      inner.appendChild(rankSpan);
      inner.appendChild(suitSpan);
      btn.appendChild(inner);
      if (isSel) {
        const badge = document.createElement('span');
        badge.className = 'hh-card-matrix-order';
        badge.textContent = String(selIdx + 1);
        btn.appendChild(badge);
      }
      btn.addEventListener('click', () => onCardPickerMatrixClick(code, blocked));
      grid.appendChild(btn);
    });
  });
  root.appendChild(grid);
}

function updateCardPickerSelectionPreview() {
  const el = $('card-picker-selection');
  if (!el) return;
  const n = cardPickerState.needed;
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    parts.push(cardPickerState.selected[i] || '—');
  }
  el.textContent = parts.join(' · ');
}

function onCardPickerMatrixClick(code, blocked) {
  if (blocked) return;
  const idx = cardPickerState.selected.indexOf(code);
  if (idx >= 0) {
    cardPickerState.selected.splice(idx, 1);
  } else {
    if (cardPickerState.selected.length >= cardPickerState.needed) return;
    cardPickerState.selected.push(code);
  }
  refreshCardPickerMatrix();
  updateCardPickerSelectionPreview();
}

function closeCardPickerModal() {
  const modal = $('modal-card-picker');
  if (modal) modal.hidden = true;
  cardPickerState.type = null;
  cardPickerState.seat = null;
  cardPickerState.selected = [];
}

function openCardPickerModal(ctx) {
  if (!state.draft) return;
  const ac = totalActions(state.draft.timeline);
  if (HE().computeHandState(state.draft, ac).isHandFinished) return;
  const modal = $('modal-card-picker');
  if (!modal) return;
  cardPickerState.type = ctx.type;
  cardPickerState.seat = ctx.seat != null ? ctx.seat : null;
  if (ctx.type === 'hole') {
    cardPickerState.needed = 2;
    cardPickerState.boardKind = null;
    const prev = state.draft.hole_cards[String(ctx.seat)];
    cardPickerState.selected = Array.isArray(prev) ? prev.filter(Boolean).slice(0, 2) : [];
  } else {
    const kind = ctx.boardKind || nextBoardKind(state.draft);
    if (!kind) return;
    cardPickerState.boardKind = kind;
    cardPickerState.needed = kind === 'flop' ? 3 : 1;
    cardPickerState.selected = [];
  }
  const title = $('card-picker-title');
  const help = $('card-picker-help');
  const labels = HE().seatDisplayLabels(state.draft);
  if (title) {
    if (ctx.type === 'hole') {
      title.textContent = 'Main — ' + labels[ctx.seat];
    } else if (cardPickerState.boardKind === 'flop') {
      title.textContent = 'Flop (3 cartes)';
    } else if (cardPickerState.boardKind === 'turn') {
      title.textContent = 'Turn';
    } else {
      title.textContent = 'River';
    }
  }
  if (help) {
    help.textContent =
      'Lignes : pique, cœur, carreau, trèfle. Colonnes : rang. Cliquez pour sélectionner ou retirer (' +
      cardPickerState.needed +
      ' carte' +
      (cardPickerState.needed > 1 ? 's' : '') +
      ').';
  }
  refreshCardPickerMatrix();
  updateCardPickerSelectionPreview();
  modal.hidden = false;
}

function onCardPickerOk() {
  if (!state.draft || !cardPickerState.type) return;
  if (cardPickerState.selected.length !== cardPickerState.needed) {
    setMsg('Sélectionnez exactement ' + cardPickerState.needed + ' carte(s) distinctes.', 'err');
    return;
  }
  const uniq = new Set(cardPickerState.selected);
  if (uniq.size !== cardPickerState.selected.length) {
    setMsg('Les cartes doivent être distinctes.', 'err');
    return;
  }
  const kind = cardPickerState.type;
  const seat = cardPickerState.seat;
  const sel = cardPickerState.selected.slice();
  closeCardPickerModal();
  setMsg('', null);
  if (kind === 'hole') {
    state.draft.hole_cards[String(seat)] = sel;
    renderCreateUi();
  } else {
    pushBoard(sel);
  }
}

function onCardPickerCancel() {
  closeCardPickerModal();
  setMsg('', null);
}

function scheduleBoardPickerIfNeeded() {
  if (!state.draft) return;
  const modal = $('modal-card-picker');
  if (modal && !modal.hidden) return;
  if (!needsBoardAfterRoundEnd(state.draft)) return;
  const ac = totalActions(state.draft.timeline);
  if (HE().computeHandState(state.draft, ac).isHandFinished) return;
  openCardPickerModal({ type: 'board' });
}

function renderHoleCardGrid() {
  const g = $('hole-card-grid');
  if (!g || !state.draft) return;
  const n = HE().clampN(state.draft.player_count);
  const labels = HE().seatDisplayLabels(state.draft);
  g.innerHTML = '';

  function appendBack(card, idx) {
    card.className = 'hh-playing-card hh-playing-card--back' + (idx === 0 ? ' hh-playing-card--tilt-l' : ' hh-playing-card--tilt-r');
    const img = document.createElement('img');
    img.className = 'hh-card-back-logo';
    img.src = LOGO_BACK;
    img.alt = '';
    card.appendChild(img);
  }

  function appendFace(card, code, idx) {
    const p = HC().parseCard(code);
    if (!p) {
      appendBack(card, idx);
      return;
    }
    card.className =
      'hh-playing-card ' + HC().suitClass(p.suit) + (idx === 0 ? ' hh-playing-card--tilt-l' : ' hh-playing-card--tilt-r');
    const inner = document.createElement('div');
    inner.className = 'hh-playing-card-inner';
    const rEl = document.createElement('span');
    rEl.className = 'hh-playing-card-rank';
    rEl.textContent = HC().rankDisplay(p.rank);
    const sEl = document.createElement('span');
    sEl.className = 'hh-playing-card-suit';
    sEl.textContent = HC().SUITS[p.suit];
    inner.appendChild(rEl);
    inner.appendChild(sEl);
    card.appendChild(inner);
  }

  for (let i = 0; i < n; i += 1) {
    const wrap = document.createElement('div');
    wrap.className = 'hh-hole-card-slot';
    const lab = document.createElement('div');
    lab.className = 'hh-label';
    lab.textContent = labels[i];
    wrap.appendChild(lab);

    const codes = state.draft.hole_cards[String(i)] || [];
    const complete = codes.length >= 2 && codes[0] && codes[1];

    const pairBtn = document.createElement('button');
    pairBtn.type = 'button';
    pairBtn.className = 'hh-hole-card-pair-btn';
    pairBtn.setAttribute(
      'aria-label',
      complete ? 'Modifier la main — ' + labels[i] : 'Choisir la main — ' + labels[i]
    );

    const visual = document.createElement('div');
    visual.className = 'hh-hole-card-pair-visual poker-table--hh';
    const cardsRow = document.createElement('div');
    cardsRow.className = 'hh-hole-cards';
    for (let idx = 0; idx < 2; idx += 1) {
      const card = document.createElement('div');
      if (!complete) appendBack(card, idx);
      else appendFace(card, codes[idx], idx);
      cardsRow.appendChild(card);
    }
    visual.appendChild(cardsRow);
    pairBtn.appendChild(visual);
    pairBtn.addEventListener('click', () => openCardPickerModal({ type: 'hole', seat: i }));
    wrap.appendChild(pairBtn);
    g.appendChild(wrap);
  }
}

function renderBreadcrumb(elId, hand, actionCursor, interactive) {
  const el = $(elId);
  if (!el) return;
  el.innerHTML = '';
  const entries = HE().globalNavCrumbs(hand, actionCursor);
  let actionCount = 0;
  for (let j = 0; j < entries.length; j += 1) {
    if (entries[j].kind === 'action') actionCount += 1;
  }
  if (actionCount === 0) {
    const sp = document.createElement('span');
    sp.className = 'crumb-current';
    sp.textContent = 'Racine';
    el.appendChild(sp);
    return;
  }
  const rootBtn = document.createElement('button');
  rootBtn.type = 'button';
  rootBtn.className = 'crumb-btn';
  rootBtn.textContent = 'Racine';
  rootBtn.addEventListener('click', () => {
    if (!interactive) return;
    state.draft.timeline = removeTrailingActions(state.draft.timeline, actionCount);
    renderCreateUi();
  });
  const onActionCrumb = (idx) => {
    if (!interactive) return;
    navigateBreadcrumbToActionIndex(idx);
  };
  el.appendChild(rootBtn);
  for (let i = 0; i < entries.length; i += 1) {
    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = '›';
    el.appendChild(sep);
    const e = entries[i];
    if (e.kind === 'street') {
      const sp = document.createElement('span');
      sp.className = 'crumb-street';
      sp.textContent = e.label;
      el.appendChild(sp);
      continue;
    }
    const isLast = e.actionIndex === actionCount - 1;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'crumb-btn' + (isLast ? ' is-current-node' : '');
    btn.textContent = e.label;
    const idx = e.actionIndex;
    btn.addEventListener('click', () => onActionCrumb(idx));
    el.appendChild(btn);
  }
}

function renderActionBar(stPre) {
  const bar = $('action-bar');
  const raiseRow = $('raise-row');
  if (!bar || !state.draft) return;
  setRaiseFeedback('');
  bar.innerHTML = '';
  if (raiseRow) {
    raiseRow.hidden = true;
    const inpHide = $('raise-amount');
    if (inpHide) {
      inpHide.placeholder = '';
      inpHide.removeAttribute('aria-label');
    }
  }
  const ac = totalActions(state.draft.timeline);
  const st = stPre || HE().computeHandState(state.draft, ac);
  if (st.isHandFinished) {
    const info = document.createElement('p');
    info.className = 'hh-hand-finished-note';
    info.textContent =
      'Main terminée — un seul joueur encore actif. Aucune autre action ni tour d’enchères n’est possible.';
    bar.appendChild(info);
    return;
  }
  if (st.street === 'SHOWDOWN') {
    const info = document.createElement('p');
    info.className = 'hh-hand-finished-note';
    info.textContent =
      'Abattage : enchères terminées, plusieurs joueurs encore actifs (pas d’autre mise ici).';
    bar.appendChild(info);
    return;
  }
  st.legal.forEach((L) => {
    if (L.type === 'raise') return;
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = L.label;
    b.addEventListener('click', () => appendAction(L.label));
    bar.appendChild(b);
  });
  const raiseLeg = st.legal.find((x) => x.type === 'raise');
  if (raiseLeg) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = raiseLeg.openBet ? 'Bet…' : 'Raise…';
    b.addEventListener('click', () => openRaiseRowForLegal(raiseLeg));
    bar.appendChild(b);
    const allInBtn = document.createElement('button');
    allInBtn.type = 'button';
    allInBtn.textContent = 'All-in';
    allInBtn.addEventListener('click', () => {
      appendAction(HE().formatRaiseLabel(raiseLeg.maxTotal, !!raiseLeg.openBet));
    });
    bar.appendChild(allInBtn);
  }
}

function appendAction(label) {
  if (!state.draft) return;
  const ac0 = totalActions(state.draft.timeline);
  if (HE().computeHandState(state.draft, ac0).isHandFinished) return;
  state.draft.timeline = state.draft.timeline.concat([{ kind: 'ACTION', label }]);
  const ac1 = totalActions(state.draft.timeline);
  const st1 = HE().computeHandState(state.draft, ac1);
  if (!st1.isHandFinished && st1.canCloseRound) {
    const le = lastTimelineEvent(state.draft.timeline);
    if (!le || le.kind !== 'ROUND_END') {
      state.draft.timeline = state.draft.timeline.concat([{ kind: 'ROUND_END' }]);
      scheduleBoardPickerIfNeeded();
    }
  }
  const rr = $('raise-row');
  if (rr) rr.hidden = true;
  renderCreateUi();
}

function onRaiseOk() {
  const inp = $('raise-amount');
  if (!inp || !state.draft) return;
  const v = Number(inp.value);
  const ac = totalActions(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);
  if (st.isHandFinished) return;
  const r = st.legal.find((x) => x.type === 'raise');
  if (!r) return;
  if (!Number.isFinite(v) || v < r.minTotal - 1e-9 || v > r.maxTotal + 1e-9) {
    setRaiseFeedback(r.openBet ? 'Montant de bet invalide.' : 'Montant de raise invalide.');
    return;
  }
  setRaiseFeedback('');
  appendAction(HE().formatRaiseLabel(v, !!r.openBet));
  setMsg('', null);
}

function pushRoundEnd() {
  if (!state.draft) return;
  if (HE().computeHandState(state.draft, totalActions(state.draft.timeline)).isHandFinished) return;
  state.draft.timeline = state.draft.timeline.concat([{ kind: 'ROUND_END' }]);
  renderCreateUi();
  scheduleBoardPickerIfNeeded();
}

function pushBoard(cards) {
  if (!state.draft) return;
  if (HE().computeHandState(state.draft, totalActions(state.draft.timeline)).isHandFinished) return;
  state.draft.timeline = state.draft.timeline.concat([{ kind: 'BOARD', cards }]);
  renderCreateUi();
}

function openBoardModal() {
  openCardPickerModal({ type: 'board' });
}

/**
 * @param {'view'|'create'} holeUiMode — en création : 2 cartes par siège, dos tant que la paire n’est pas choisie dans « Cartes ».
 */
/**
 * @param {{ forceReveal?: boolean, hiddenSeats?: Set<number> }} [viewHoleOpts] — mode view uniquement
 */
function paintCardsOnTable(tableRoot, hand, st, hideHole, holeUiMode, viewHoleOpts) {
  if (!tableRoot) return;
  tableRoot.querySelectorAll('.hh-seat-dock').forEach((n) => n.remove());
  tableRoot.querySelectorAll('.hh-hole-cards').forEach((n) => n.remove());
  const n = HE().clampN(hand.player_count);
  const seats = tableRoot.querySelectorAll('.poker-table-seat');
  const hc = hand.hole_cards || {};
  const mode = holeUiMode || 'view';

  function appendBack(card, idx) {
    card.className = 'hh-playing-card hh-playing-card--back' + (idx === 0 ? ' hh-playing-card--tilt-l' : ' hh-playing-card--tilt-r');
    const img = document.createElement('img');
    img.className = 'hh-card-back-logo';
    img.src = LOGO_BACK;
    img.alt = '';
    card.appendChild(img);
  }

  function appendFace(card, code, idx) {
    const p = HC().parseCard(code);
    if (!p) return;
    card.className = 'hh-playing-card ' + HC().suitClass(p.suit) + (idx === 0 ? ' hh-playing-card--tilt-l' : ' hh-playing-card--tilt-r');
    const inner = document.createElement('div');
    inner.className = 'hh-playing-card-inner';
    const rEl = document.createElement('span');
    rEl.className = 'hh-playing-card-rank';
    rEl.textContent = HC().rankDisplay(p.rank);
    const sEl = document.createElement('span');
    sEl.className = 'hh-playing-card-suit';
    sEl.textContent = HC().SUITS[p.suit];
    inner.appendChild(rEl);
    inner.appendChild(sEl);
    card.appendChild(inner);
  }

  function appendSeatDock(seat, wrap) {
    const dock = document.createElement('div');
    dock.className = 'hh-seat-dock';
    const clip = document.createElement('div');
    clip.className = 'hh-seat-cards-clip';
    clip.appendChild(wrap);
    dock.appendChild(clip);
    seat.appendChild(dock);
  }

  for (let i = 0; i < seats.length; i += 1) {
    const raw = hc[String(i)];
    const codes = Array.isArray(raw) ? raw : [];
    const complete = codes.length >= 2 && codes[0] && codes[1];

    if (mode === 'create') {
      if (st.replay.folded.has(i)) continue;
      const wrap = document.createElement('div');
      wrap.className = 'hh-hole-cards';
      for (let idx = 0; idx < 2; idx += 1) {
        const card = document.createElement('div');
        if (!complete) {
          appendBack(card, idx);
        } else if (hideHole) {
          appendBack(card, idx);
        } else {
          appendFace(card, codes[idx], idx);
        }
        wrap.appendChild(card);
      }
      appendSeatDock(seats[i], wrap);
      continue;
    }

    if (st.replay.folded.has(i)) continue;

    const vOpt = viewHoleOpts || {};
    const forceReveal = !!vOpt.forceReveal;
    const hid = vOpt.hiddenSeats instanceof Set ? vOpt.hiddenSeats : new Set();
    const hideFace = complete && !forceReveal && hid.has(i);

    const wrap = document.createElement('div');
    wrap.className = 'hh-hole-cards' + (complete ? ' hh-hole-cards--peekable' : '');
    if (complete) {
      wrap.dataset.seat = String(i);
      wrap.title = 'Cliquer pour afficher ou masquer cette main (tant que les cartes ne sont pas révélées automatiquement)';
    }
    for (let idx = 0; idx < 2; idx += 1) {
      const card = document.createElement('div');
      if (!complete) {
        appendBack(card, idx);
      } else if (hideFace) {
        appendBack(card, idx);
      } else {
        appendFace(card, codes[idx], idx);
      }
      wrap.appendChild(card);
    }
    appendSeatDock(seats[i], wrap);
  }
}

function paintBoardCenter(tableRoot, board, hideBoard, potBb) {
  if (!tableRoot) return;
  tableRoot.querySelectorAll('.hh-board-wrap').forEach((n) => n.remove());
  const felt = tableRoot.querySelector('.poker-table-felt');
  if (!felt) return;
  const wrap = document.createElement('div');
  wrap.className = 'hh-board-wrap';
  const potEl = document.createElement('div');
  potEl.className = 'hh-pot-display hh-pot-display--board';
  potEl.textContent = 'Pot ' + RN().formatBb(potBb) + ' bb';
  potEl.setAttribute('aria-label', 'Pot total : ' + RN().formatBb(potBb) + ' bb');
  const row = document.createElement('div');
  row.className = 'hh-board-row hh-board-row--fixed';
  const flop = board.flop || [];
  const codes5 = [flop[0] || null, flop[1] || null, flop[2] || null, board.turn || null, board.river || null];
  codes5.forEach((code, idx) => {
    const slot = document.createElement('div');
    slot.className = 'hh-board-slot';
    if (!code) {
      slot.classList.add('hh-board-slot--empty');
      const ph = document.createElement('div');
      ph.className = 'hh-playing-card hh-playing-card--board-placeholder';
      ph.setAttribute('aria-hidden', 'true');
      slot.appendChild(ph);
      row.appendChild(slot);
      return;
    }
    const card = document.createElement('div');
    if (hideBoard) {
      card.className = 'hh-playing-card hh-playing-card--back' + (idx % 2 === 0 ? ' hh-playing-card--tilt-l' : ' hh-playing-card--tilt-r');
      const img = document.createElement('img');
      img.className = 'hh-card-back-logo';
      img.src = LOGO_BACK;
      img.alt = '';
      card.appendChild(img);
    } else {
      const p = HC().parseCard(code);
      if (!p) return;
      card.className = 'hh-playing-card ' + HC().suitClass(p.suit);
      const inner = document.createElement('div');
      inner.className = 'hh-playing-card-inner';
      const rEl = document.createElement('span');
      rEl.className = 'hh-playing-card-rank';
      rEl.textContent = HC().rankDisplay(p.rank);
      const sEl = document.createElement('span');
      sEl.className = 'hh-playing-card-suit';
      sEl.textContent = HC().SUITS[p.suit];
      inner.appendChild(rEl);
      inner.appendChild(sEl);
      card.appendChild(inner);
    }
    slot.appendChild(card);
    row.appendChild(slot);
  });
  wrap.appendChild(potEl);
  wrap.appendChild(row);
  felt.appendChild(wrap);
}

function ensureSeatDockForStack(seat) {
  let dock = seat.querySelector('.hh-seat-dock');
  if (!dock) {
    dock = document.createElement('div');
    dock.className = 'hh-seat-dock';
    const clip = document.createElement('div');
    clip.className = 'hh-seat-cards-clip hh-seat-cards-clip--empty';
    dock.appendChild(clip);
    seat.appendChild(dock);
  }
  return dock;
}

function paintSeatStacks(tableRoot, stacksBehind, folded, committed, allInSeat, hand) {
  if (!tableRoot || !Array.isArray(stacksBehind)) return;
  const foldedSet = folded || new Set();
  const committedArr = committed || [];
  const allInArr = allInSeat || [];
  tableRoot.querySelectorAll('.hh-seat-stack').forEach((el) => el.remove());
  tableRoot.querySelectorAll('.hh-seat-name').forEach((el) => el.remove());
  const seatLabels = hand ? HE().seatDisplayLabels(hand) : null;
  const seats = tableRoot.querySelectorAll('.poker-table-seat');
  for (let i = 0; i < seats.length; i += 1) {
    if (i >= stacksBehind.length) continue;
    const stackBb = Number(stacksBehind[i]) || 0;
    const potStreet = Number(committedArr[i]) || 0;
    const isAllInUi =
      !foldedSet.has(i) &&
      ((allInArr[i] === true) || (stackBb <= 1e-9 && potStreet > 1e-9));
    const dock = ensureSeatDockForStack(seats[i]);
    const el = document.createElement('div');
    el.className = 'hh-seat-stack hh-seat-stack--meta' + (isAllInUi ? ' hh-seat-stack--allin' : '');
    const val = document.createElement('span');
    val.className = 'hh-seat-stack-value';
    if (isAllInUi) {
      val.textContent = 'All-in';
      const whoAi = seatLabels && seatLabels[i] ? seatLabels[i] + ' — ' : '';
      el.setAttribute('aria-label', whoAi + 'All-in');
    } else {
      const t = RN().formatBb(stacksBehind[i]) + ' bb';
      val.textContent = t;
      const who = seatLabels && seatLabels[i] ? seatLabels[i] + ' — ' : '';
      el.setAttribute('aria-label', who + 'Stack : ' + t);
    }
    if (seatLabels && seatLabels[i]) {
      const nameRow = document.createElement('div');
      nameRow.className = 'hh-seat-stack-player';
      nameRow.textContent = seatLabels[i];
      nameRow.setAttribute('aria-hidden', 'true');
      const sep = document.createElement('div');
      sep.className = 'hh-seat-stack-sep';
      sep.setAttribute('aria-hidden', 'true');
      el.appendChild(nameRow);
      el.appendChild(sep);
    }
    val.setAttribute('aria-hidden', 'true');
    el.appendChild(val);
    dock.appendChild(el);
  }
}

/** Révélation forcée des trous en visualisation : fin de main, abattage, ou tapis intégral multi-joueurs. */
function shouldForceRevealAllHoles(st) {
  if (!st) return false;
  if (st.isHandFinished) return true;
  if (st.street === 'SHOWDOWN') return true;
  const n = st.n || HE().clampN(0);
  const alive = [];
  for (let i = 0; i < n; i += 1) {
    if (!st.replay.folded.has(i)) alive.push(i);
  }
  if (alive.length < 2) return false;
  for (let k = 0; k < alive.length; k += 1) {
    if ((Number(st.stacksBehind[alive[k]]) || 0) > 1e-9) return false;
  }
  let anyCommit = false;
  for (let k = 0; k < alive.length; k += 1) {
    if ((Number(st.replay.committed[alive[k]]) || 0) > 1e-9) {
      anyCommit = true;
      break;
    }
  }
  return anyCommit;
}

function renderPokerTable(tableRoot, hand, actionCursor, interactiveSeat, hideCards, hideBoard, holeUiMode, viewOpts) {
  if (!tableRoot || !hand) return;
  const n = HE().clampN(hand.player_count);
  const labels = HE().seatDisplayLabels(hand);
  const ac = actionCursor == null ? totalActions(hand.timeline) : actionCursor;
  const st = HE().computeHandState(hand, ac);
  const dead = Number(hand.dead_money_bb) || 0;
  tableRoot.classList.add('poker-table--hh');
  const activeSeatIdx =
    st.isHandFinished || st.street === 'SHOWDOWN' ? null : st.replay.activeSeat;
  RN().renderTable(
    tableRoot,
    n,
    labels,
    activeSeatIdx,
    dead,
    st.replay.committed,
    st.replay.folded,
    st.replay.allInSeat,
    interactiveSeat,
    { showPositionLabels: false }
  );
  paintBoardCenter(tableRoot, st.board, hideBoard, st.potDisplay);
  const mode = holeUiMode || 'view';
  const holeOpts =
    mode === 'view' && viewOpts
      ? {
          forceReveal: shouldForceRevealAllHoles(st),
          hiddenSeats: viewOpts.viewHiddenSeats instanceof Set ? viewOpts.viewHiddenSeats : new Set(),
        }
      : undefined;
  paintCardsOnTable(tableRoot, hand, st, hideCards, mode, holeOpts);
  paintSeatStacks(tableRoot, st.stacksBehind, st.replay.folded, st.replay.committed, st.replay.allInSeat, hand);
}

function onSeatClickCreate(seat) {
  if (!state.draft) return;
  const ac = totalActions(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);
  if (st.isHandFinished) return;
  const baseOpts = HE().replayOptsForStreet(st.street, state.draft);
  const rc = st.replayCarry || { initialFolded: [], initialAllInSeat: [] };
  const opts = Object.assign({}, baseOpts, {
    initialFolded: rc.initialFolded,
    initialAllInSeat: rc.initialAllInSeat,
  });
  const trim = RN().trimNavPathToSeatAtDecision(
    HE().clampN(state.draft.player_count),
    st.streetActions,
    st.firstToActStreet,
    seat,
    opts
  );
  if (trim.ok) {
    const rem = st.streetActions.length - trim.path.length;
    state.draft.timeline = removeTrailingActions(state.draft.timeline, rem);
    renderCreateUi();
    return;
  }
  const ext = RN().extendNavPathWithFoldsHH(
    HE().clampN(state.draft.player_count),
    st.streetActions,
    st.firstToActStreet,
    seat,
    opts
  );
  if (!ext.ok) {
    setMsg('Impossible d’atteindre ce siège par des plis automatiques.', 'err');
    return;
  }
  const add = ext.path.length - st.streetActions.length;
  for (let i = 0; i < add; i += 1) {
    state.draft.timeline = state.draft.timeline.concat([{ kind: 'ACTION', label: 'Fold' }]);
  }
  renderCreateUi();
}

function mergeKnownTagsFromListRows() {
  const set = new Set(state.knownTags || []);
  (state.listRows || []).forEach((h) => {
    (h.tags || []).forEach((t) => {
      const s = String(t).trim();
      if (s) set.add(s);
    });
  });
  state.knownTags = Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
}

async function fetchKnownTagsFromDb() {
  const { url, anonKey } = cfg();
  if (!url || !anonKey) return;
  try {
    if (!state.sb) state.sb = hhCreateClient(url, anonKey);
    const { data, error } = await state.sb.from('hands').select('tags');
    if (error) return;
    const set = new Set(state.knownTags || []);
    (data || []).forEach((row) => {
      (row.tags || []).forEach((t) => {
        const s = String(t).trim();
        if (s) set.add(s);
      });
    });
    state.knownTags = Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  } catch (_) {
    /* réseau / parse */
  }
}

function renderHandTagsBlock() {
  const sel = $('hand-tag-select');
  const chips = $('hand-tags-chips');
  if (!sel || !chips || !state.draft) return;
  const current = [];
  const seen = new Set();
  for (const x of state.draft.tags || []) {
    const s = String(x).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    current.push(s);
  }
  state.draft.tags = current;

  sel.innerHTML = '';
  const ph = document.createElement('option');
  ph.value = '';
  ph.textContent = '— Tag existant —';
  sel.appendChild(ph);
  const curLower = new Set(current.map((t) => t.toLowerCase()));
  for (const t of state.knownTags || []) {
    if (curLower.has(String(t).toLowerCase())) continue;
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    sel.appendChild(o);
  }

  chips.innerHTML = '';
  for (let i = 0; i < current.length; i += 1) {
    const t = current[i];
    const wrap = document.createElement('span');
    wrap.className = 'hh-tag hh-tag--draft';
    wrap.appendChild(document.createTextNode(t));
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'hh-tag-remove';
    btn.dataset.tagIndex = String(i);
    btn.setAttribute('aria-label', 'Retirer le tag ' + t);
    btn.textContent = '×';
    wrap.appendChild(btn);
    chips.appendChild(wrap);
  }
}

function addDraftTag(raw) {
  if (!state.draft) return false;
  const t = String(raw || '').trim();
  if (!t) return false;
  const tags = (state.draft.tags || []).slice();
  if (tags.some((x) => String(x).toLowerCase() === t.toLowerCase())) return false;
  state.draft.tags = tags.concat([t]);
  const kl = (state.knownTags || []).map((x) => String(x).toLowerCase());
  if (!kl.includes(t.toLowerCase())) {
    state.knownTags = (state.knownTags || []).concat([t]).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
  }
  return true;
}

function normalizeDraftTags() {
  if (!state.draft) return;
  const seen = new Set();
  const out = [];
  for (const t of state.draft.tags || []) {
    const s = String(t).trim();
    if (!s) continue;
    const k = s.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  state.draft.tags = out;
}

function renderCreateUi() {
  if (!state.draft) {
    if ($('create-editor')) $('create-editor').hidden = true;
    syncCreateToolbarForFreshSession();
    return;
  }
  $('create-editor').hidden = false;
  $('hand-title').value = state.draft.title || '';
  populateHandFolderSelect();
  renderHandTagsBlock();
  $('create-hand-id').textContent = state.draft.id ? 'ID : ' + state.draft.id : 'Nouvelle main (non enregistrée)';
  const ac = totalActions(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);
  renderBreadcrumb('breadcrumb', state.draft, ac, true);
  renderActionBar(st);
  const lastEv = lastTimelineEvent(state.draft.timeline);
  const btnEnd = $('btn-round-end');
  const btnBoard = $('btn-board');
  if (btnEnd) {
    btnEnd.hidden = st.isHandFinished || !st.canCloseRound;
    btnEnd.disabled = !!(lastEv && lastEv.kind === 'ROUND_END');
  }
  if (btnBoard) {
    btnBoard.hidden = st.isHandFinished || !needsBoardAfterRoundEnd(state.draft);
  }
  renderPokerTable($('poker-table'), state.draft, null, st.isHandFinished ? null : onSeatClickCreate, false, false, 'create');
  renderHoleCardGrid();
}

function setMode(mode) {
  state.mode = mode;
  document.querySelectorAll('#mode-nav button').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.mode === mode);
  });
  $('panel-create').hidden = mode !== 'create';
  $('panel-list').hidden = mode !== 'list';
  $('panel-view').hidden = mode !== 'view';
  setMsg('', null);
  if (mode === 'create') {
    if (!state.draft) {
      state.setupCollapsed = false;
      syncCreateToolbarForFreshSession();
    }
    if (!state.draft || !state.setupCollapsed) populateSetupFormFields();
    updateCreateSetupPanelDom();
    void fetchKnownTagsFromDb().then(() => {
      if (state.mode === 'create' && state.draft) renderHandTagsBlock();
    });
    if (state.draft) {
      renderCreateUi();
      void refreshList();
    }
  }
  if (mode === 'list') {
    if (!state.draft) state.assignFolderFromListToNextDraft = false;
    refreshList();
  }
  if (mode === 'view') {
    if (state.viewQueue.length) loadViewHand();
    else {
      state.viewHand = null;
      renderViewPanel();
      setMsg('Aucune main sélectionnée. Utilisez la liste ou « Visualiser la sélection ».', 'err');
    }
  }
}

async function refreshList() {
  const { url, anonKey } = cfg();
  if (!url || !anonKey) {
    setMsg('Configurez js/config.js (URL + clé anon Supabase).', 'err');
    return;
  }
  state.sb = hhCreateClient(url, anonKey);
  const [fr, hr] = await Promise.all([
    state.sb.from('hh_folders').select('*').order('name'),
    state.sb.from('hands').select('*').order('created_at', { ascending: false }),
  ]);
  if (fr.error) {
    setMsg(fr.error.message, 'err');
    return;
  }
  if (hr.error) {
    setMsg(hr.error.message, 'err');
    return;
  }
  state.folderRows = fr.data || [];
  state.listRows = hr.data || [];
  mergeKnownTagsFromListRows();
  renderUnifiedList();
  if (state.mode === 'create' && state.draft) renderCreateUi();
}

function syncListFolderToolbar() {
  const btn = $('btn-folder-delete');
  if (!btn) return;
  btn.hidden = state.listTargetFolderId == null;
}

function sortHandsByCreatedDesc(arr) {
  return arr.slice().sort((a, b) => {
    const ta = a.created_at ? new Date(a.created_at).getTime() : 0;
    const tb = b.created_at ? new Date(b.created_at).getTime() : 0;
    return tb - ta;
  });
}

function parseListTagFilter() {
  const filterStr = ($('list-tag-filter') && $('list-tag-filter').value) || '';
  return filterStr
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function handMatchesListTags(h, tagsF) {
  if (!tagsF.length) return true;
  const ht = h.tags || [];
  return tagsF.some((t) => ht.includes(t));
}

function wireListDragCleanupOnce() {
  if (window.__hhListDragCleanupWired) return;
  window.__hhListDragCleanupWired = true;
  document.addEventListener('dragend', () => {
    document.querySelectorAll('.hh-drop-target').forEach((el) => el.classList.remove('hh-drop-target'));
  });
}

function bindFolderRowDropTarget(tr, folderId) {
  tr.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    tr.classList.add('hh-drop-target');
  });
  tr.addEventListener('dragleave', (e) => {
    if (!tr.contains(e.relatedTarget)) tr.classList.remove('hh-drop-target');
  });
  tr.addEventListener('drop', async (e) => {
    e.preventDefault();
    tr.classList.remove('hh-drop-target');
    const hid = e.dataTransfer.getData('text/hh-hand-id') || e.dataTransfer.getData('text/plain');
    if (!hid) return;
    const target = folderId;
    const h = state.listRows.find((x) => String(x.id) === String(hid));
    if (!h) return;
    const cur = h.folder_id != null && h.folder_id !== '' ? String(h.folder_id) : '';
    const want = target != null && target !== '' ? String(target) : '';
    if (cur === want) return;
    await setHandFolder(hid, target);
  });
}

/** Indentation gauche (rem) alignée sur les lignes dossier (`depth` = profondeur dans l’arbre). */
function hhListFolderIndentRem(depth) {
  return 0.35 + depth * 0.85;
}

function appendHandRowToList(tb, h, tagsF, folderDepth = 0) {
  if (!handMatchesListTags(h, tagsF)) return;
  const tr = document.createElement('tr');
  tr.className = 'hh-hands-row hh-hand-row--draggable';
  tr.draggable = true;
  tr.dataset.handId = String(h.id);
  tr.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/hh-hand-id', String(h.id));
    e.dataTransfer.setData('text/plain', String(h.id));
    tr.classList.add('hh-hand-row--dragging');
  });
  tr.addEventListener('dragend', () => tr.classList.remove('hh-hand-row--dragging'));
  const td0 = document.createElement('td');
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.dataset.id = h.id;
  td0.appendChild(cb);
  tr.appendChild(td0);
  const td1 = document.createElement('td');
  td1.textContent = h.title || '(sans titre)';
  tr.appendChild(td1);
  const td2 = document.createElement('td');
  td2.textContent = h.created_at ? new Date(h.created_at).toLocaleString('fr-FR') : '';
  tr.appendChild(td2);
  const td3 = document.createElement('td');
  td3.textContent = String(h.player_count);
  tr.appendChild(td3);
  const td4 = document.createElement('td');
  (h.tags || []).forEach((t) => {
    const sp = document.createElement('span');
    sp.className = 'hh-tag';
    sp.textContent = t;
    td4.appendChild(sp);
  });
  tr.appendChild(td4);
  const td5 = document.createElement('td');
  td5.className = 'hh-list-actions';
  const b1 = hhIconButton('hh-btn hh-btn--icon', HH_ICON_PLAY, 'Replayer');
  b1.addEventListener('click', () => {
    state.viewQueue = [h.id];
    state.viewHandIndex = 0;
    state.viewActionCursor = 0;
    setMode('view');
    loadViewHand();
  });
  const b2 = hhIconButton('hh-btn hh-btn--icon', HH_ICON_EDIT, 'Éditer');
  b2.addEventListener('click', () => {
    loadHandIntoDraft(h);
  });
  td5.appendChild(b1);
  td5.appendChild(b2);
  const b3 = hhIconButton('hh-btn hh-btn--icon hh-btn--danger', HH_ICON_DELETE, 'Supprimer');
  b3.addEventListener('click', async () => {
    if (!confirm('Supprimer cette main ?')) return;
    const { error } = await state.sb.from('hands').delete().eq('id', h.id);
    if (error) setMsg(error.message, 'err');
    else {
      setMsg('Supprimé.', 'ok');
      refreshList();
    }
  });
  td5.appendChild(b3);
  tr.appendChild(td5);
  const indentRem = hhListFolderIndentRem(folderDepth) + 'rem';
  [td0, td1, td2, td3, td4, td5].forEach((td) => {
    td.style.paddingLeft = indentRem;
  });
  cb.addEventListener('change', () => {
    tr.classList.toggle('is-selected', cb.checked);
  });
  tr.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    if (e.target.closest('input[type="checkbox"]')) return;
    cb.checked = !cb.checked;
    tr.classList.toggle('is-selected', cb.checked);
  });
  tb.appendChild(tr);
}

function folderChildFolders(folderId) {
  return state.folderRows.filter(
    (f) => f.parent_id != null && String(f.parent_id) === String(folderId)
  );
}

function handsInFolder(folderId) {
  return state.listRows.filter((h) => {
    const fid = h.folder_id != null && h.folder_id !== '' ? String(h.folder_id) : null;
    return fid === String(folderId);
  });
}

/** Options plates pour le sélecteur dossier en création (profondeur = indentation dans le libellé). */
function buildCreateFolderOptionsFlat() {
  const out = [{ value: '', label: LIST_UC_LABEL, depth: 0 }];
  function walk(parentId, depth) {
    const wantParent = parentId == null ? null : String(parentId);
    const kids = state.folderRows.filter((f) => {
      const pid = f.parent_id == null || f.parent_id === '' ? null : String(f.parent_id);
      if (wantParent == null) return pid == null;
      return pid === wantParent;
    });
    kids.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
    kids.forEach((f) => {
      const indent = depth > 0 ? '\u2007'.repeat(depth * 2) + '· ' : '';
      out.push({ value: String(f.id), label: indent + f.name, depth });
      walk(f.id, depth + 1);
    });
  }
  walk(null, 0);
  return out;
}

function populateHandFolderSelect() {
  const sel = $('hand-folder-select');
  if (!sel || !state.draft) return;
  const cur =
    state.draft.folder_id != null && state.draft.folder_id !== '' ? String(state.draft.folder_id) : '';
  const opts = buildCreateFolderOptionsFlat();
  const known = new Set(opts.map((o) => o.value));
  sel.innerHTML = '';
  opts.forEach((opt) => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.label;
    sel.appendChild(o);
  });
  if (cur && !known.has(cur)) {
    const o = document.createElement('option');
    o.value = cur;
    o.textContent = '\u2007· (dossier introuvable)';
    sel.appendChild(o);
  }
  sel.value = cur || '';
}

/** Dossier `rootId` et tous ses descendants (pour reclasser les mains avant suppression). */
function collectFolderDescendantIds(rootId) {
  const ids = [];
  function walk(id) {
    ids.push(id);
    state.folderRows.forEach((f) => {
      if (f.parent_id != null && String(f.parent_id) === String(id)) walk(f.id);
    });
  }
  walk(rootId);
  return ids;
}

function appendFolderBranch(tb, folder, depth, tagsF) {
  const subfolders = folderChildFolders(folder.id);
  subfolders.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  const handsHere = handsInFolder(folder.id);
  const hasExpandable = subfolders.length > 0 || handsHere.length > 0;
  const expanded = state.listExpandedFolderIds.has(folder.id);

  const tr = document.createElement('tr');
  tr.className = 'hh-list-folder-row';
  if (state.listTargetFolderId != null && String(state.listTargetFolderId) === String(folder.id)) {
    tr.classList.add('is-target-folder');
  }
  tr.dataset.dropFolderId = String(folder.id);
  bindFolderRowDropTarget(tr, folder.id);

  const td0 = document.createElement('td');
  td0.colSpan = 6;
  td0.className = 'hh-list-folder-cell';

  const inner = document.createElement('div');
  inner.className = 'hh-list-folder-inner';
  inner.style.paddingLeft = hhListFolderIndentRem(depth) + 'rem';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'hh-folder-toggle hh-folder-toggle--table';
  toggle.textContent = hasExpandable ? (expanded ? '▼' : '▶') : '·';
  toggle.disabled = !hasExpandable;
  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!hasExpandable) return;
    if (expanded) state.listExpandedFolderIds.delete(folder.id);
    else state.listExpandedFolderIds.add(folder.id);
    renderUnifiedList();
  });

  const titleWrap = document.createElement('div');
  titleWrap.className = 'hh-list-folder-title-wrap';

  const nameSpan = document.createElement('span');
  nameSpan.className = 'hh-list-folder-name';
  nameSpan.textContent = folder.name;
  nameSpan.title = 'Cliquer pour renommer · Maj+clic : dossier cible (création, + Dossier)';

  const renameBox = document.createElement('div');
  renameBox.className = 'hh-list-folder-rename-box';
  renameBox.hidden = true;

  const sizer = document.createElement('span');
  sizer.className = 'hh-list-folder-rename-sizer';
  sizer.setAttribute('aria-hidden', 'true');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'hh-list-folder-rename-input';
  nameInput.setAttribute('aria-label', 'Nom du dossier');
  nameInput.value = folder.name;

  function syncRenameSizer() {
    const raw = nameInput.value;
    sizer.textContent = raw.length ? raw : '\u00a0';
  }

  renameBox.appendChild(sizer);
  renameBox.appendChild(nameInput);

  let escFromRename = false;

  nameSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.shiftKey) {
      e.preventDefault();
      state.listTargetFolderId = folder.id;
      renderUnifiedList();
      return;
    }
    nameSpan.hidden = true;
    renameBox.hidden = false;
    nameInput.value = folder.name;
    syncRenameSizer();
    nameInput.focus();
    nameInput.select();
  });

  nameInput.addEventListener('input', () => syncRenameSizer());
  nameInput.addEventListener('click', (e) => e.stopPropagation());

  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      escFromRename = true;
      renameBox.hidden = true;
      nameSpan.hidden = false;
      nameInput.value = folder.name;
      nameInput.blur();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      nameInput.blur();
    }
  });

  nameInput.addEventListener('blur', async () => {
    if (escFromRename) {
      escFromRename = false;
      return;
    }
    if (renameBox.hidden) return;
    const v = nameInput.value.trim();
    renameBox.hidden = true;
    nameSpan.hidden = false;
    if (!v || v === folder.name) {
      nameSpan.textContent = folder.name;
      return;
    }
    const ok = await renameFolderInDb(folder.id, v);
    if (!ok) nameSpan.textContent = folder.name;
  });

  titleWrap.appendChild(nameSpan);
  titleWrap.appendChild(renameBox);

  td0.addEventListener('click', (e) => {
    if (!renameBox.hidden) return;
    if (e.target.closest('.hh-list-folder-name')) return;
    if (e.target.closest('.hh-list-folder-rename-box')) return;
    if (e.target.closest('.hh-folder-toggle')) return;
    if (e.target.closest('.hh-list-folder-actions')) return;
    if (!hasExpandable) return;
    if (expanded) state.listExpandedFolderIds.delete(folder.id);
    else state.listExpandedFolderIds.add(folder.id);
    renderUnifiedList();
  });

  const folderActions = document.createElement('div');
  folderActions.className = 'hh-list-folder-actions';

  const createHandBtn = hhIconButton(
    'hh-btn hh-btn--icon hh-btn--small',
    HH_ICON_NEW_HAND,
    'Créer une main dans ce dossier'
  );
  createHandBtn.title = 'Créer une main dans ce dossier';
  createHandBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.assignFolderFromListToNextDraft = true;
    state.folderForNextNewDraft = folder.id;
    setMode('create');
  });

  const subBtn = hhIconButton(
    'hh-btn hh-btn--icon hh-btn--small',
    HH_ICON_NEW_FOLDER,
    'Créer un sous-dossier ici'
  );
  subBtn.title = 'Créer un sous-dossier ici';
  subBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    state.listExpandedFolderIds.add(folder.id);
    void createListFolderUnder(folder.id);
  });

  const delBtn = hhIconButton(
    'hh-btn hh-btn--icon hh-btn--small hh-btn--danger',
    HH_ICON_DELETE,
    'Supprimer ce dossier'
  );
  delBtn.title = 'Supprimer ce dossier';
  delBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    void deleteFolderById(folder.id);
  });

  folderActions.appendChild(createHandBtn);
  folderActions.appendChild(subBtn);
  folderActions.appendChild(delBtn);

  inner.appendChild(toggle);
  inner.appendChild(titleWrap);
  inner.appendChild(folderActions);
  td0.appendChild(inner);
  tr.appendChild(td0);
  tb.appendChild(tr);

  if (!expanded) return;
  sortHandsByCreatedDesc(handsHere).forEach((h) => appendHandRowToList(tb, h, tagsF, depth));
  subfolders.forEach((c) => appendFolderBranch(tb, c, depth + 1, tagsF));
}

function renderUnifiedList() {
  wireListDragCleanupOnce();
  const tb = $('hands-tbody');
  if (!tb) return;
  tb.innerHTML = '';
  const tagsF = parseListTagFilter();

  const ucHandsAll = state.listRows.filter((h) => {
    const fid = h.folder_id != null && h.folder_id !== '' ? String(h.folder_id) : null;
    return fid == null;
  });
  const ucExpanded = state.listExpandedFolderIds.has(LIST_UC_EXPAND_KEY);
  const ucHasExpandable = ucHandsAll.length > 0;

  const trUc = document.createElement('tr');
  trUc.className = 'hh-list-folder-row hh-list-uc-row';
  if (state.listTargetFolderId == null) trUc.classList.add('is-target-folder');
  trUc.dataset.dropFolderId = '';
  bindFolderRowDropTarget(trUc, null);

  const tdUc = document.createElement('td');
  tdUc.colSpan = 6;
  tdUc.className = 'hh-list-folder-cell';
  const innerUc = document.createElement('div');
  innerUc.className = 'hh-list-folder-inner';
  innerUc.style.paddingLeft = hhListFolderIndentRem(0) + 'rem';

  const toggleUc = document.createElement('button');
  toggleUc.type = 'button';
  toggleUc.className = 'hh-folder-toggle hh-folder-toggle--table';
  toggleUc.textContent = ucHasExpandable ? (ucExpanded ? '▼' : '▶') : '·';
  toggleUc.disabled = !ucHasExpandable;
  toggleUc.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!ucHasExpandable) return;
    if (ucExpanded) state.listExpandedFolderIds.delete(LIST_UC_EXPAND_KEY);
    else state.listExpandedFolderIds.add(LIST_UC_EXPAND_KEY);
    renderUnifiedList();
  });

  const titleWrapUc = document.createElement('div');
  titleWrapUc.className = 'hh-list-folder-title-wrap';

  const nameSpanUc = document.createElement('span');
  nameSpanUc.className = 'hh-list-folder-name';
  nameSpanUc.textContent = LIST_UC_LABEL;
  nameSpanUc.title =
    'Dossier cible : mains sans dossier (« Créer une main », + Dossier). Clic ou Maj+clic sur le libellé.';

  nameSpanUc.addEventListener('click', (e) => {
    e.stopPropagation();
    if (e.shiftKey) e.preventDefault();
    state.listTargetFolderId = null;
    renderUnifiedList();
  });

  titleWrapUc.appendChild(nameSpanUc);

  tdUc.addEventListener('click', (e) => {
    if (e.target.closest('.hh-list-folder-name')) return;
    if (e.target.closest('.hh-folder-toggle')) return;
    if (e.target.closest('.hh-list-folder-actions')) return;
    if (!ucHasExpandable) return;
    if (ucExpanded) state.listExpandedFolderIds.delete(LIST_UC_EXPAND_KEY);
    else state.listExpandedFolderIds.add(LIST_UC_EXPAND_KEY);
    renderUnifiedList();
  });
  innerUc.appendChild(toggleUc);
  innerUc.appendChild(titleWrapUc);
  tdUc.appendChild(innerUc);
  trUc.appendChild(tdUc);
  tb.appendChild(trUc);

  if (ucExpanded) {
    sortHandsByCreatedDesc(ucHandsAll).forEach((h) => appendHandRowToList(tb, h, tagsF, 0));
  }

  const top = state.folderRows.filter((f) => !f.parent_id);
  top.sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));
  top.forEach((f) => appendFolderBranch(tb, f, 0, tagsF));

  syncListFolderToolbar();
}

async function createListFolderUnder(fixedParent) {
  if (!state.sb) return;
  const name = String(window.prompt('Nom du dossier :', '') || '').trim();
  if (!name) return;
  const parent_id =
    fixedParent === undefined
      ? state.listTargetFolderId || null
      : fixedParent != null && fixedParent !== ''
        ? fixedParent
        : null;
  const { error } = await state.sb.from('hh_folders').insert({ name, parent_id });
  if (error) {
    setMsg(error.message, 'err');
    return;
  }
  if (parent_id) state.listExpandedFolderIds.add(parent_id);
  setMsg('Dossier créé.', 'ok');
  await refreshList();
}

async function createListFolder() {
  await createListFolderUnder(undefined);
}

async function deleteFolderById(folderId) {
  if (!folderId || !state.sb) return;
  if (
    !window.confirm(
      'Supprimer ce dossier et ses sous-dossiers ? Les mains seront déplacées vers le dossier parent, ou vers « Non classées » si ce dossier est à la racine.'
    )
  ) {
    return;
  }
  const row = state.folderRows.find((f) => String(f.id) === String(folderId));
  const targetParent =
    row && row.parent_id != null && row.parent_id !== '' ? row.parent_id : null;
  const subtreeIds = collectFolderDescendantIds(folderId);
  if (subtreeIds.length) {
    const { error: upErr } = await state.sb
      .from('hands')
      .update({ folder_id: targetParent })
      .in('folder_id', subtreeIds);
    if (upErr) {
      setMsg(upErr.message, 'err');
      return;
    }
  }
  const { error } = await state.sb.from('hh_folders').delete().eq('id', folderId);
  if (error) {
    setMsg(error.message, 'err');
    return;
  }
  subtreeIds.forEach((id) => state.listExpandedFolderIds.delete(id));
  if (
    state.listTargetFolderId != null &&
    subtreeIds.some((id) => String(id) === String(state.listTargetFolderId))
  ) {
    state.listTargetFolderId = null;
  }
  setMsg('Dossier supprimé.', 'ok');
  await refreshList();
}

async function deleteListFolder() {
  await deleteFolderById(state.listTargetFolderId);
}

async function renameFolderInDb(folderId, newName) {
  if (!state.sb) return false;
  const name = String(newName || '').trim();
  if (!name) return false;
  const { error } = await state.sb.from('hh_folders').update({ name }).eq('id', folderId);
  if (error) {
    setMsg(error.message, 'err');
    return false;
  }
  setMsg('Dossier renommé.', 'ok');
  await refreshList();
  return true;
}

function ensureFolderBranchExpandedFor(folderId) {
  let cur = folderId;
  while (cur != null && cur !== '') {
    state.listExpandedFolderIds.add(cur);
    const f = state.folderRows.find((x) => String(x.id) === String(cur));
    cur = f && f.parent_id != null && f.parent_id !== '' ? f.parent_id : null;
  }
}

async function setHandFolder(handId, folderId) {
  if (!state.sb) return;
  const fid = folderId == null || folderId === '' ? null : folderId;
  const { error } = await state.sb.from('hands').update({ folder_id: fid }).eq('id', handId);
  if (error) {
    setMsg(error.message, 'err');
    await refreshList();
    return;
  }
  if (fid) ensureFolderBranchExpandedFor(fid);
  else state.listExpandedFolderIds.add(LIST_UC_EXPAND_KEY);
  setMsg('Dossier de la main mis à jour.', 'ok');
  await refreshList();
}

function loadHandIntoDraft(h) {
  const { url, anonKey } = cfg();
  if (url && anonKey && !state.sb) state.sb = hhCreateClient(url, anonKey);
  state.draft = {
    id: h.id,
    title: h.title || '',
    player_count: h.player_count,
    first_to_act: h.first_to_act,
    small_blind_bb: Number(h.small_blind_bb),
    big_blind_bb: Number(h.big_blind_bb),
    dead_money_bb: Number(h.dead_money_bb) || 0,
    tags: h.tags || [],
    player_names: Array.isArray(h.player_names) ? h.player_names.slice() : [],
    stacks_bb: h.stacks_bb || [],
    antes_bb: h.antes_bb || [],
    hole_cards: h.hole_cards || {},
    timeline: h.timeline || [],
    folder_id: h.folder_id != null && h.folder_id !== '' ? h.folder_id : null,
  };
  state.setupCollapsed = true;
  setMode('create');
  renderCreateUi();
  populateSetupSummary();
  updateCreateSetupPanelDom();
}

function validateCardUniqueness(hand) {
  const u = new Set();
  const hc = hand.hole_cards || {};
  for (const arr of Object.values(hc)) {
    if (!Array.isArray(arr)) continue;
    for (const c of arr) {
      if (!c) continue;
      if (u.has(c)) return false;
      u.add(c);
    }
  }
  for (const ev of hand.timeline || []) {
    if (ev && ev.kind === 'BOARD' && Array.isArray(ev.cards)) {
      for (const c of ev.cards) {
        if (!c) continue;
        if (u.has(c)) return false;
        u.add(c);
      }
    }
  }
  return true;
}

function setSaveHandLoading(on) {
  const btn = $('btn-save-hand');
  if (!btn) return;
  const label = btn.querySelector('.hh-btn-save-label');
  btn.classList.toggle('is-loading', on);
  btn.disabled = !!on;
  btn.setAttribute('aria-busy', on ? 'true' : 'false');
  if (label) label.textContent = on ? 'Enregistrement…' : 'Enregistrer';
}

async function saveHand() {
  const { url, anonKey } = cfg();
  if (!url || !anonKey) {
    setMsg('Configurez Supabase dans js/config.js', 'err');
    return;
  }
  if (!state.draft) return;
  if (!validateCardUniqueness(state.draft)) {
    setMsg('Deux fois la même carte (trouvez le doublon dans les trous ou le board).', 'err');
    return;
  }
  state.draft.title = $('hand-title').value.trim();
  const handFolderSel = $('hand-folder-select');
  if (handFolderSel) {
    const fv = (handFolderSel.value || '').trim();
    state.draft.folder_id = fv ? fv : null;
  }
  normalizeDraftTags();
  if (!state.sb) state.sb = hhCreateClient(url, anonKey);
  const nn = HE().clampN(state.draft.player_count);
  const rawNames = state.draft.player_names || [];
  const player_names = [];
  for (let i = 0; i < nn; i += 1) {
    player_names[i] = typeof rawNames[i] === 'string' ? rawNames[i].trim() : '';
  }
  state.draft.player_names = player_names;
  const row = {
    title: state.draft.title,
    player_count: state.draft.player_count,
    first_to_act: state.draft.first_to_act,
    small_blind_bb: state.draft.small_blind_bb,
    big_blind_bb: state.draft.big_blind_bb,
    dead_money_bb: state.draft.dead_money_bb,
    tags: state.draft.tags,
    player_names,
    stacks_bb: state.draft.stacks_bb,
    antes_bb: state.draft.antes_bb,
    hole_cards: state.draft.hole_cards,
    timeline: state.draft.timeline,
    folder_id: state.draft.folder_id != null && state.draft.folder_id !== '' ? state.draft.folder_id : null,
  };
  if (saveHandInFlight) return;
  saveHandInFlight = true;
  setSaveHandLoading(true);
  try {
    if (state.draft.id) {
      const { error } = await state.sb.from('hands').update(row).eq('id', state.draft.id);
      if (error) throw error;
      setMsg('Main mise à jour.', 'ok');
    } else {
      const { data, error } = await state.sb.from('hands').insert(row).select('id').single();
      if (error) throw error;
      state.draft.id = data.id;
      setMsg('Main enregistrée.', 'ok');
    }
    $('create-hand-id').textContent = 'ID : ' + state.draft.id;
    const tagSet = new Set(state.knownTags || []);
    (state.draft.tags || []).forEach((t) => {
      const s = String(t).trim();
      if (s) tagSet.add(s);
    });
    state.knownTags = Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    if (state.mode === 'create') renderHandTagsBlock();
  } catch (e) {
    setMsg(e.message || String(e), 'err');
  } finally {
    setSaveHandLoading(false);
    saveHandInFlight = false;
  }
}

function viewHandCacheKey(id) {
  return String(id);
}

/** Pré-charge une main en file d’attente (sans bloquer). */
function prefetchViewHandRow(id) {
  if (!id || !state.sb) return;
  const key = viewHandCacheKey(id);
  if (state.viewHandCache.has(key)) return;
  void state.sb
    .from('hands')
    .select('*')
    .eq('id', id)
    .single()
    .then(({ data, error }) => {
      if (!error && data) state.viewHandCache.set(key, data);
    });
}

/** Pré-charge toutes les autres mains de la file (en arrière-plan). */
function prefetchViewHandsAroundCurrent() {
  if (!state.sb || !state.viewQueue.length) return;
  const q = state.viewQueue;
  const i = state.viewHandIndex;
  for (let j = 0; j < q.length; j += 1) {
    if (j === i) continue;
    prefetchViewHandRow(q[j]);
  }
}

async function loadViewHand() {
  const id = state.viewQueue[state.viewHandIndex];
  if (!id) return;
  const { url, anonKey } = cfg();
  if (!url || !anonKey) {
    setMsg('Configurez Supabase dans js/config.js', 'err');
    return;
  }
  if (!state.sb) state.sb = hhCreateClient(url, anonKey);
  const key = viewHandCacheKey(id);
  let data = state.viewHandCache.get(key);
  let error = null;
  if (!data) {
    const res = await state.sb.from('hands').select('*').eq('id', id).single();
    error = res.error;
    data = res.data;
    if (!error && data) state.viewHandCache.set(key, data);
  }
  if (error) {
    setMsg(error.message, 'err');
    return;
  }
  state.viewHand = data;
  state.viewHoleHidden = new Set();
  const maxA = HE().viewReplayActionMax(data);
  if (state.viewActionCursor > maxA) state.viewActionCursor = maxA;
  if (state.viewActionCursor < 0) state.viewActionCursor = 0;
  renderViewPanel();
  prefetchViewHandsAroundCurrent();
}

function renderViewTitleAndStreetNav() {
  const titleEl = $('view-hand-title');
  if (!titleEl) return;
  titleEl.innerHTML = '';
  const h = state.viewHand;
  if (!h) {
    titleEl.textContent = 'Aucune main chargée.';
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'hh-view-title-block';
  const line = document.createElement('div');
  line.className = 'hh-view-title-line';
  const title = document.createElement('span');
  title.className = 'hh-view-title-text';
  title.textContent = (h.title || 'Sans titre') + ' — ' + (state.viewHandIndex + 1) + '/' + state.viewQueue.length;
  line.appendChild(title);
  wrap.appendChild(line);
  const nav = document.createElement('div');
  nav.className = 'hh-view-street-nav';
  const maxA = HE().viewReplayActionMax(h);
  const starts = HE().viewStreetEntryActionCursors(h);
  function addStreetBtn(label, ac) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hh-btn hh-btn--street';
    b.textContent = label;
    if (ac == null) {
      b.disabled = true;
      b.title = 'Cette rue n’existe pas dans cette main.';
    } else {
      const target = Math.min(ac, maxA);
      b.addEventListener('click', () => {
        state.viewActionCursor = target;
        renderViewPanel();
      });
    }
    nav.appendChild(b);
  }
  addStreetBtn('Préflop', starts.preflop);
  addStreetBtn('Flop', starts.flop);
  addStreetBtn('Turn', starts.turn);
  addStreetBtn('River', starts.river);
  wrap.appendChild(nav);
  titleEl.appendChild(wrap);
}

function renderViewPanel() {
  const h = state.viewHand;
  renderViewTitleAndStreetNav();
  if (!h) return;
  const maxA = HE().viewReplayActionMax(h);
  $('view-step-label').textContent = 'Action ' + state.viewActionCursor + ' / ' + maxA;
  renderPokerTable($('view-poker-table'), h, state.viewActionCursor, null, false, false, 'view', {
    viewHiddenSeats: state.viewHoleHidden,
  });
}

function isTypingInField(target) {
  if (!target || !target.closest) return false;
  if (target.isContentEditable) return true;
  return !!target.closest('input, textarea, select, [contenteditable="true"]');
}

function isBlockingModalOpen() {
  const picker = $('modal-card-picker');
  if (picker && !picker.hidden) return true;
  return false;
}

function canUseCreateArrowShortcuts() {
  if (state.mode !== 'create' || !state.draft || !state.setupCollapsed) return false;
  const ed = $('create-editor');
  if (!ed || ed.hidden) return false;
  return true;
}

/** Création (table prête) : ← fil d’Ariane, → Fold, ↓ Check/Call, ↑ Raise/Bet + focus montant */
function onCreateKeyboardNav(ev) {
  if (!canUseCreateArrowShortcuts()) return;
  if (isBlockingModalOpen()) return;
  if (isTypingInField(ev.target)) return;
  const k = ev.key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;

  const ac = totalActions(state.draft.timeline);
  const st = HE().computeHandState(state.draft, ac);

  if (k === 'ArrowRight') {
    const fold = st.legal.find((L) => L.type === 'fold');
    if (!fold) return;
    ev.preventDefault();
    appendAction(fold.label);
    return;
  }
  if (k === 'ArrowDown') {
    const check = st.legal.find((L) => L.type === 'check');
    const call = st.legal.find((L) => L.type === 'call');
    const leg = check || call;
    if (!leg) return;
    ev.preventDefault();
    appendAction(leg.label);
    return;
  }
  if (k === 'ArrowUp') {
    const raiseLeg = st.legal.find((L) => L.type === 'raise');
    if (!raiseLeg) return;
    ev.preventDefault();
    openRaiseRowForLegal(raiseLeg);
    return;
  }
  if (k === 'ArrowLeft') {
    ev.preventDefault();
    goBackOneCreateBreadcrumbStep();
  }
}

/** Visualisation : ←/→ actions, ↑/↓ main précédente / suivante */
function onViewKeyboardNav(ev) {
  if (state.mode !== 'view' || !state.viewHand) return;
  if (isBlockingModalOpen()) return;
  if (isTypingInField(ev.target)) return;
  const k = ev.key;
  if (k !== 'ArrowLeft' && k !== 'ArrowRight' && k !== 'ArrowUp' && k !== 'ArrowDown') return;

  if (k === 'ArrowRight') {
    const maxA = HE().viewReplayActionMax(state.viewHand);
    if (state.viewActionCursor >= maxA) return;
    ev.preventDefault();
    state.viewActionCursor += 1;
    renderViewPanel();
    return;
  }
  if (k === 'ArrowLeft') {
    if (state.viewActionCursor <= 0) return;
    ev.preventDefault();
    state.viewActionCursor -= 1;
    renderViewPanel();
    return;
  }
  if (k === 'ArrowUp') {
    if (state.viewHandIndex <= 0) return;
    ev.preventDefault();
    state.viewHandIndex -= 1;
    state.viewActionCursor = 0;
    void loadViewHand();
    return;
  }
  if (k === 'ArrowDown') {
    if (state.viewHandIndex >= state.viewQueue.length - 1) return;
    ev.preventDefault();
    state.viewHandIndex += 1;
    state.viewActionCursor = 0;
    void loadViewHand();
  }
}

function wireEvents() {
  document.querySelectorAll('#mode-nav button').forEach((b) => {
    b.addEventListener('click', () => {
      if (b.dataset.mode === 'create') state.assignFolderFromListToNextDraft = false;
      setMode(b.dataset.mode);
    });
  });
  $('btn-expand-setup').addEventListener('click', () => expandSetupPanel());
  $('setup-cancel').addEventListener('click', () => {
    if (!state.draft) return;
    populateSetupFormFields();
    state.setupCollapsed = true;
    populateSetupSummary();
    updateCreateSetupPanelDom();
  });
  $('form-setup').addEventListener('submit', (e) => {
    e.preventDefault();
    const r = readSetupForm();
    if (!r) return;
    const prev = state.draft;
    state.draft = Object.assign(emptyDraft(), prev || {}, r);
    if (!prev && state.assignFolderFromListToNextDraft) {
      state.draft.folder_id = state.folderForNextNewDraft != null ? state.folderForNextNewDraft : null;
    }
    state.assignFolderFromListToNextDraft = false;
    state.setupCollapsed = true;
    populateSetupSummary();
    updateCreateSetupPanelDom();
    renderCreateUi();
    setMsg('Table prête. Saisissez les actions.', 'ok');
  });
  const pc = $('form-setup').querySelector('[name="player_count"]');
  if (pc) pc.addEventListener('change', onPlayerCountInput);
  const btnCancelCreate = $('btn-cancel-create-hand');
  if (btnCancelCreate) btnCancelCreate.addEventListener('click', () => cancelCreateHand());
  const handFolderSelect = $('hand-folder-select');
  if (handFolderSelect && handFolderSelect.dataset.hhWired !== '1') {
    handFolderSelect.dataset.hhWired = '1';
    handFolderSelect.addEventListener('change', () => {
      if (!state.draft) return;
      const v = (handFolderSelect.value || '').trim();
      state.draft.folder_id = v ? v : null;
    });
  }
  $('btn-save-hand').addEventListener('click', () => {
    void saveHand();
  });
  const createEd = $('create-editor');
  if (createEd) {
    createEd.addEventListener('click', (ev) => {
      const rm = ev.target.closest('.hh-tag-remove');
      if (!rm || !state.draft) return;
      const idx = Number(rm.dataset.tagIndex);
      if (!Number.isFinite(idx) || idx < 0) return;
      const tags = (state.draft.tags || []).slice();
      if (idx >= tags.length) return;
      tags.splice(idx, 1);
      state.draft.tags = tags;
      renderHandTagsBlock();
    });
  }
  const selTagPick = $('hand-tag-select');
  if (selTagPick) {
    selTagPick.addEventListener('change', () => {
      if (!state.draft) return;
      const v = (selTagPick.value || '').trim();
      if (!v) return;
      addDraftTag(v);
      selTagPick.value = '';
      renderHandTagsBlock();
    });
  }
  const btnTagNew = $('btn-hand-tag-new');
  const inpTagNew = $('hand-tag-new');
  if (btnTagNew && inpTagNew) {
    btnTagNew.addEventListener('click', () => {
      if (!state.draft) return;
      if (addDraftTag(inpTagNew.value)) inpTagNew.value = '';
      renderHandTagsBlock();
    });
    inpTagNew.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      btnTagNew.click();
    });
  }
  $('btn-raise-ok').addEventListener('click', () => onRaiseOk());
  const raiseInp = $('raise-amount');
  if (raiseInp) {
    raiseInp.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      onRaiseOk();
    });
  }
  $('btn-round-end').addEventListener('click', () => pushRoundEnd());
  $('btn-board').addEventListener('click', () => openBoardModal());
  $('card-picker-cancel').addEventListener('click', () => onCardPickerCancel());
  $('card-picker-ok').addEventListener('click', () => onCardPickerOk());
  $('btn-list-refresh').addEventListener('click', () => refreshList());
  $('btn-list-create').addEventListener('click', () => {
    state.assignFolderFromListToNextDraft = true;
    state.folderForNextNewDraft = state.listTargetFolderId;
    setMode('create');
  });
  const btnFolderNew = $('btn-folder-new');
  if (btnFolderNew) btnFolderNew.addEventListener('click', () => void createListFolder());
  const btnFolderDel = $('btn-folder-delete');
  if (btnFolderDel) btnFolderDel.addEventListener('click', () => void deleteListFolder());
  $('list-tag-filter').addEventListener('input', () => renderUnifiedList());
  $('btn-list-view-selected').addEventListener('click', () => {
    const ids = [];
    $('hands-tbody').querySelectorAll('input[type=checkbox]:checked').forEach((cb) => ids.push(cb.dataset.id));
    if (!ids.length) {
      setMsg('Cochez au moins une main.', 'err');
      return;
    }
    state.viewQueue = ids;
    state.viewHandIndex = 0;
    state.viewActionCursor = 0;
    state.viewHoleHidden = new Set();
    state.viewHandCache = new Map();
    setMode('view');
    loadViewHand();
  });
  $('v-prev').addEventListener('click', () => {
    state.viewActionCursor = Math.max(0, state.viewActionCursor - 1);
    renderViewPanel();
  });
  $('v-next').addEventListener('click', () => {
    const maxA = HE().viewReplayActionMax(state.viewHand);
    state.viewActionCursor = Math.min(maxA, state.viewActionCursor + 1);
    renderViewPanel();
  });
  $('v-hand-prev').addEventListener('click', () => {
    if (state.viewHandIndex <= 0) return;
    state.viewHandIndex -= 1;
    state.viewActionCursor = 0;
    loadViewHand().then(() => {
      if (state.viewHand) {
        state.viewActionCursor = 0;
        renderViewPanel();
      }
    });
  });
  $('v-hand-next').addEventListener('click', () => {
    if (state.viewHandIndex >= state.viewQueue.length - 1) return;
    state.viewHandIndex += 1;
    state.viewActionCursor = 0;
    loadViewHand();
  });
  document.addEventListener('keydown', onViewKeyboardNav);
  document.addEventListener('keydown', onCreateKeyboardNav);
}

function wireViewHoleClicks() {
  const table = $('view-poker-table');
  if (!table || table.dataset.hhViewHoleWired === '1') return;
  table.dataset.hhViewHoleWired = '1';
  table.addEventListener('click', (ev) => {
    if (state.mode !== 'view' || !state.viewHand) return;
    const wrap = ev.target.closest('.hh-hole-cards--peekable');
    if (!wrap || wrap.dataset.seat == null) return;
    const seat = Number(wrap.dataset.seat);
    if (!Number.isFinite(seat)) return;
    const st = HE().computeHandState(state.viewHand, state.viewActionCursor);
    if (shouldForceRevealAllHoles(st)) return;
    if (state.viewHoleHidden.has(seat)) state.viewHoleHidden.delete(seat);
    else state.viewHoleHidden.add(seat);
    renderViewPanel();
  });
}

function init() {
  state.listExpandedFolderIds.add(LIST_UC_EXPAND_KEY);
  fillFirstActSelect(6);
  renderSetupGrids(6);
  wireEvents();
  wireViewHoleClicks();
  state.draft = null;
  state.setupCollapsed = false;
  if ($('create-editor')) $('create-editor').hidden = true;
  updateCreateSetupPanelDom();
  setMode('list');
}

init();
