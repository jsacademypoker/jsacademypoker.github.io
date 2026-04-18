/**
 * Replay table / fil d’Ariane (extrait et adapté de RangeViewer/rangeNavCore.js).
 * Préflop : blindes paramétrables. Postflop : pas de blindes injectées.
 */
(function (global) {
  const TP = () => global.TablePositions;

  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;');
  }

  function formatBb(value) {
    const v = Number(value);
    if (!Number.isFinite(v)) return '0';
    return v.toLocaleString('fr-FR', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    });
  }

  function nextSeatStillInHand(n, folded, fromSeat) {
    for (let step = 1; step <= n; step += 1) {
      const s = (fromSeat + step) % n;
      if (!folded.has(s)) return s;
    }
    return fromSeat;
  }

  function parseRaiseTotalBb(action) {
    const t = String(action);
    const m = t.match(
      /(?:raise|reraise|re-?raise|bet|all-?\s*in|all\s+in|shove|jam)\s*[:\s]*([\d]+(?:[,.]\d+)?)\s*bb/i
    );
    if (!m) return null;
    const v = parseFloat(String(m[1]).replace(',', '.'));
    return Number.isFinite(v) && v >= 0 ? v : null;
  }

  function isCallAction(action) {
    const t = String(action).trim();
    if (/^call$/i.test(t)) return true;
    if (/^call\b/i.test(t) && /all-?\s*in|all\s+in/i.test(t)) return true;
    return false;
  }

  function isCallOrCheckAction(action) {
    const t = String(action).trim();
    return /^check$/i.test(t) || isCallAction(action);
  }

  function isAllInAction(action) {
    const t = String(action).trim();
    if (/^all-?\s*in$/i.test(t)) return true;
    if (/^all\s+in$/i.test(t)) return true;
    return /^all-?\s*in\b/i.test(t);
  }

  function isFoldAction(action) {
    return /^fold$/i.test(String(action).trim());
  }

  function isRaiseLikeAction(action) {
    if (isFoldAction(action) || isCallOrCheckAction(action)) return false;
    if (parseRaiseTotalBb(action) != null) return true;
    if (isAllInAction(action)) return true;
    const t = String(action).toLowerCase();
    if (/\b(raise|reraise|re-?raise|bet|shove|jam)\b/.test(t)) return true;
    return false;
  }

  /**
   * @param {object} opts
   * @param {boolean} opts.postBlinds préflop true, postflop false
   * @param {number} opts.smallBlindBb
   * @param {number} opts.bigBlindBb
   * @param {number[]} [opts.preflopPosted] — mises devant par siège (préflop) ; sinon SB/BB depuis small/big.
   */
  function replayNavStateStreet(n, navPath, firstToActIndex, opts) {
    const Tp = TP();
    const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    const safeFirst =
      Number.isFinite(firstToActIndex) && firstToActIndex >= 0 && firstToActIndex < nn
        ? firstToActIndex
        : Tp.defaultFirstToActIndex(nn);
    const postBlinds = !!(opts && opts.postBlinds);
    const sbBb = postBlinds && opts ? Math.max(0, Number(opts.smallBlindBb) || 0.5) : 0;
    const bbBb = postBlinds && opts ? Math.max(0, Number(opts.bigBlindBb) || 1) : 0;
    const blinds = Tp.blindSeatIndices(nn);
    const committed = new Array(nn).fill(0);
    let maxCommit = 0;
    const posted = opts && Array.isArray(opts.preflopPosted) ? opts.preflopPosted : null;
    if (postBlinds && posted && posted.length >= nn) {
      for (let pi = 0; pi < nn; pi += 1) {
        const v = Math.max(0, Number(posted[pi]) || 0);
        committed[pi] = v;
        maxCommit = Math.max(maxCommit, v);
      }
    } else if (postBlinds && sbBb > 0 && bbBb > 0) {
      committed[blinds.sb] = sbBb;
      committed[blinds.bb] = bbBb;
      maxCommit = Math.max(sbBb, bbBb);
    }
    const folded = new Set();
    if (opts && opts.initialFolded) {
      const initF = opts.initialFolded;
      if (initF instanceof Set) initF.forEach((s) => folded.add(s));
      else if (Array.isArray(initF)) initF.forEach((s) => folded.add(s));
    }
    const allInSeat = new Array(nn).fill(false);
    if (opts && opts.initialAllInSeat && Array.isArray(opts.initialAllInSeat)) {
      for (let ii = 0; ii < nn; ii += 1) allInSeat[ii] = !!opts.initialAllInSeat[ii];
    }
    let actor = safeFirst;
    for (let guard = 0; guard < nn; guard += 1) {
      if (!folded.has(actor)) break;
      actor = (actor + 1) % nn;
    }
    const path = navPath || [];

    for (let i = 0; i < path.length; i += 1) {
      const a = path[i];
      if (!isFoldAction(a)) {
        if (isCallOrCheckAction(a)) {
          committed[actor] = maxCommit;
          if (isCallAction(a) && allInSeat.some((all, j) => all && j !== actor)) {
            allInSeat[actor] = true;
          }
        } else {
          const raised = parseRaiseTotalBb(a);
          if (raised != null) {
            committed[actor] = raised;
            maxCommit = Math.max(maxCommit, raised);
          } else if (isAllInAction(a)) {
            const prev = committed[actor] || 0;
            committed[actor] = Math.max(prev, maxCommit);
            maxCommit = Math.max(maxCommit, committed[actor]);
          }
        }
        if (isAllInAction(a)) {
          allInSeat[actor] = true;
        }
      }
      if (isFoldAction(a)) folded.add(actor);
      actor = nextSeatStillInHand(nn, folded, actor);
    }
    return { activeSeat: actor, committed, folded, allInSeat, maxCommit };
  }

  function navPathCrumbLabels(n, navPath, firstToActIndex, replayOpts, seatLabelsOverride) {
    const Tp = TP();
    const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    const seatLabels =
      Array.isArray(seatLabelsOverride) && seatLabelsOverride.length >= nn
        ? seatLabelsOverride
        : Tp.positionLabelsForPlayerCount(nn);
    const safeFirst =
      Number.isFinite(firstToActIndex) && firstToActIndex >= 0 && firstToActIndex < nn
        ? firstToActIndex
        : Tp.defaultFirstToActIndex(nn);
    const folded = new Set();
    if (replayOpts && replayOpts.initialFolded) {
      const initF = replayOpts.initialFolded;
      if (initF instanceof Set) initF.forEach((s) => folded.add(s));
      else if (Array.isArray(initF)) initF.forEach((s) => folded.add(s));
    }
    let actor = safeFirst;
    for (let guard = 0; guard < nn; guard += 1) {
      if (!folded.has(actor)) break;
      actor = (actor + 1) % nn;
    }
    const out = [];
    for (let i = 0; i < navPath.length; i += 1) {
      out.push(seatLabels[actor] + ' ' + navPath[i]);
      if (isFoldAction(navPath[i])) folded.add(actor);
      actor = nextSeatStillInHand(nn, folded, actor);
    }
    return out;
  }

  function trimNavPathToSeatAtDecision(n, navPath, firstToActIndex, targetSeat, replayOpts) {
    const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    if (!Number.isFinite(targetSeat) || targetSeat < 0 || targetSeat >= nn) {
      return { path: navPath.slice(), ok: false };
    }
    const Tp = TP();
    const ft =
      Number.isFinite(firstToActIndex) && firstToActIndex >= 0 && firstToActIndex < nn
        ? firstToActIndex
        : Tp.defaultFirstToActIndex(nn);

    for (let cut = navPath.length; cut >= 0; cut -= 1) {
      const st = replayNavStateStreet(nn, navPath.slice(0, cut), ft, replayOpts);
      const allIn = st.allInSeat && st.allInSeat[targetSeat];
      if (st.activeSeat === targetSeat && !st.folded.has(targetSeat) && !allIn) {
        return { path: navPath.slice(0, cut), ok: true };
      }
    }
    return { path: navPath.slice(), ok: false };
  }

  /**
   * Enchaîne des Fold jusqu’à ce que targetSeat soit actif (hand histories, sans arbre de ranges).
   */
  function extendNavPathWithFoldsHH(n, navPath, firstToActIndex, targetSeat, replayOpts) {
    const path = navPath.slice();
    const nn = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    if (!Number.isFinite(targetSeat) || targetSeat < 0 || targetSeat >= nn) {
      return { path: navPath.slice(), ok: false, reason: 'bad-seat' };
    }
    const Tp = TP();
    const ft =
      Number.isFinite(firstToActIndex) && firstToActIndex >= 0 && firstToActIndex < nn
        ? firstToActIndex
        : Tp.defaultFirstToActIndex(nn);

    const initial = replayNavStateStreet(nn, path, ft, replayOpts);
    if (initial.folded.has(targetSeat)) {
      return { path: navPath.slice(), ok: false, reason: 'target-folded' };
    }
    if (initial.allInSeat && initial.allInSeat[targetSeat]) {
      return { path: navPath.slice(), ok: false, reason: 'target-all-in' };
    }
    if (initial.activeSeat === targetSeat) {
      return { path, ok: true, reason: 'already-there' };
    }

    const maxSteps = nn * nn + 32;
    for (let g = 0; g < maxSteps; g += 1) {
      const state = replayNavStateStreet(nn, path, ft, replayOpts);
      if (state.activeSeat === targetSeat) {
        return { path, ok: true, reason: 'done' };
      }
      path.push('Fold');
    }
    const last = replayNavStateStreet(nn, path, ft, replayOpts);
    return { path, ok: false, reason: 'max-steps', blockedSeat: last.activeSeat };
  }

  /**
   * @param {object} [renderOpts]
   * @param {boolean} [renderOpts.showPositionLabels=false] — masquer les pastilles BTN/SB/… si false.
   */
  function renderTable(tableRoot, n, labels, activeIndex, deadBb, committed, folded, allInSeat, onSeatClick, renderOpts) {
    if (!tableRoot) return;
    const showPositionLabels = !!(renderOpts && renderOpts.showPositionLabels);
    const Tp = TP();
    tableRoot.style.removeProperty('width');
    tableRoot.style.removeProperty('height');
    tableRoot.innerHTML = '';
    const oval = document.createElement('div');
    oval.className = 'poker-table-oval';

    const felt = document.createElement('div');
    felt.className = 'poker-table-felt';
    felt.setAttribute('aria-hidden', 'true');

    const dm = Number(deadBb);
    if (Number.isFinite(dm) && dm > 0) {
      const stats = document.createElement('div');
      stats.className = 'poker-table-felt-stats';
      const deadRow = document.createElement('div');
      deadRow.className = 'poker-table-dead';
      deadRow.textContent = formatBb(dm) + ' bb';
      stats.appendChild(deadRow);
      felt.appendChild(stats);
    }
    oval.appendChild(felt);

    const track = document.createElement('div');
    track.className = 'poker-table-track';

    /* Milieu du rebord marron : entre le feutre (--felt-rx ≈ 47 % dans hh.css) et le bord ovale (~50 %). */
    const feltInsetPct = 47;
    const ovalEdgePct = 50;
    const seatRailPct = feltInsetPct + (ovalEdgePct - feltInsetPct) * 0.5;
    const outerRxPct = seatRailPct;
    const outerRyPct = seatRailPct;
    const betTowardCenterT = 0.4;

    const blinds = Tp.blindSeatIndices(n);

    function seatPercent(i) {
      const angle = Math.PI / 2 + (2 * Math.PI * i) / n;
      return {
        x: 50 + outerRxPct * Math.cos(angle),
        y: 50 + outerRyPct * Math.sin(angle),
      };
    }

    function appendBetLabel(seatIndex, label) {
      const s = seatPercent(seatIndex);
      const px = s.x + betTowardCenterT * (50 - s.x);
      const py = s.y + betTowardCenterT * (50 - s.y);
      const node = document.createElement('div');
      node.className = 'poker-table-bet-label';
      node.textContent = label;
      node.style.left = px + '%';
      node.style.top = py + '%';
      track.appendChild(node);
    }

    function appendDealerButton(btnSeatIndex) {
      const pos = seatPercent(btnSeatIndex);
      const cx = 50;
      const cy = 50;
      let ox = pos.x - cx;
      let oy = pos.y - cy;
      const len = Math.hypot(ox, oy) || 1;
      ox /= len;
      oy /= len;
      const towardX = -ox;
      const towardY = -oy;
      const leftX = towardY;
      const leftY = -towardX;
      const towardStep = 18;
      const leftStep = 14;
      const wrap = document.createElement('div');
      wrap.className = 'poker-table-dealer-btn';
      wrap.setAttribute('aria-hidden', 'true');
      wrap.style.left = pos.x + towardX * towardStep + leftX * leftStep + '%';
      wrap.style.top = pos.y + towardY * towardStep + leftY * leftStep + '%';
      const disc = document.createElement('span');
      disc.className = 'poker-table-dealer-btn-disc';
      disc.textContent = 'D';
      wrap.appendChild(disc);
      track.appendChild(wrap);
    }

    for (let i = 0; i < n; i += 1) {
      const stake = committed && committed[i] > 0 ? committed[i] : 0;
      if (stake > 0) {
        let lab = formatBb(stake) + ' bb';
        if (allInSeat && allInSeat[i]) lab = 'All-in';
        appendBetLabel(i, lab);
      }
    }

    for (let i = 0; i < n; i += 1) {
      const { x, y } = seatPercent(i);

      const seat = document.createElement('div');
      let seatClass = 'poker-table-seat' + (i === activeIndex ? ' is-active' : '');
      if (i === blinds.sb) seatClass += ' is-sb';
      if (i === blinds.bb) seatClass += ' is-bb';
      if (folded && folded.has(i)) seatClass += ' is-folded';
      seat.className = seatClass;
      seat.style.left = x + '%';
      seat.style.top = y + '%';

      if (showPositionLabels) {
        const badge = document.createElement('span');
        badge.className = 'poker-table-seat-label';
        badge.textContent = labels[i];
        seat.appendChild(badge);
      }

      if (typeof onSeatClick === 'function') {
        seat.classList.add('poker-table-seat--interactive');
        seat.setAttribute('role', 'button');
        seat.tabIndex = 0;
        const lab = labels[i] != null ? String(labels[i]) : 'Siège ' + (i + 1);
        seat.setAttribute('aria-label', 'Aller à la décision de ' + lab + ' (plis automatiques)');
        seat.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          onSeatClick(i);
        });
        seat.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onSeatClick(i);
          }
        });
      }

      track.appendChild(seat);
    }

    appendDealerButton(0);

    oval.appendChild(track);
    tableRoot.appendChild(oval);
  }

  global.HHReplayCore = {
    escapeAttr,
    formatBb,
    nextSeatStillInHand,
    parseRaiseTotalBb,
    isCallAction,
    isCallOrCheckAction,
    isAllInAction,
    isFoldAction,
    isRaiseLikeAction,
    replayNavStateStreet,
    navPathCrumbLabels,
    trimNavPathToSeatAtDecision,
    extendNavPathWithFoldsHH,
    renderTable,
  };
})(typeof window !== 'undefined' ? window : globalThis);
