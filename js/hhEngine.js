/**
 * État d’une main à partir du timeline + curseur d’actions.
 */
(function (global) {
  const RN = () => global.HHReplayCore;
  const TP = () => global.TablePositions;

  function clampN(n) {
    return Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
  }

  /**
   * Mises obligatoires par siège avant distribution (SB, BB, straddles, etc.).
   * Colonne JSON `antes_bb` : historique du nom ; ne contient plus d’antes par joueur.
   * Si tout est à 0 mais que la main a déjà des actions (données anciennes), on reconstitue SB/BB depuis les niveaux de blindes.
   */
  function normalizePosted(hand) {
    const n = clampN(hand.player_count);
    const raw = hand.antes_bb;
    const out = new Array(n).fill(0);
    if (Array.isArray(raw)) {
      for (let i = 0; i < n; i += 1) out[i] = Math.max(0, Number(raw[i]) || 0);
    }
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += out[i];
    if (sum < 1e-9 && totalActionCount(hand.timeline) > 0) {
      const blinds = TP().blindSeatIndices(n);
      const sb = Number(hand.small_blind_bb) || 0;
      const bb = Number(hand.big_blind_bb) || 0;
      if (sb > 0 && bb > 0) {
        out[blinds.sb] = sb;
        out[blinds.bb] = bb;
      }
    }
    return out;
  }

  function normalizeStacks(hand) {
    const n = clampN(hand.player_count);
    const raw = hand.stacks_bb;
    const out = new Array(n).fill(100);
    if (Array.isArray(raw)) {
      for (let i = 0; i < n; i += 1) out[i] = Math.max(0, Number(raw[i]) || 0);
    }
    return out;
  }

  function totalActionCount(timeline) {
    let c = 0;
    (timeline || []).forEach((ev) => {
      if (ev && ev.kind === 'ACTION' && typeof ev.label === 'string') c += 1;
    });
    return c;
  }

  /**
   * Borne du replayer en visualisation : dernière position où la river est clôturée
   * (rue SHOWDOWN après ROUND_END), ou la main est finie (un seul actif), ou la river
   * est encore jouable mais le tour est clos (checks égaux). Ignore les actions après.
   */
  function viewReplayActionMax(hand) {
    const total = totalActionCount(hand.timeline);
    for (let ac = total; ac >= 0; ac -= 1) {
      const st = computeHandState(hand, ac);
      if (
        st.street === 'SHOWDOWN' ||
        st.isHandFinished ||
        (st.street === 'RIVER' && st.canCloseRound)
      ) {
        return ac;
      }
    }
    return total;
  }

  /**
   * Premier à parler postflop : premier siège actif à gauche du bouton (BTN = indice 0).
   * En HU, c’est la BB (indice 1), pas le BTN/SB qui relance mal si on partait de la SB.
   */
  function firstPostflopActor(n, folded) {
    const nn = clampN(n);
    const btnSeat = 0;
    const start = (btnSeat + 1) % nn;
    for (let k = 0; k < nn; k += 1) {
      const seat = (start + k) % nn;
      if (!folded.has(seat)) return seat;
    }
    return start;
  }

  /**
   * Siège du premier joueur à parler préflop.
   * Si `first_to_act` est absent (ex. JSON `null`), ne pas utiliser `Number(null) === 0` (BTN) : prendre le défaut UTG.
   */
  function resolveFirstToActPreflop(hand, n) {
    const nn = clampN(n);
    const ftaRaw = hand.first_to_act;
    if (ftaRaw != null && Number.isFinite(Number(ftaRaw))) {
      return Math.max(0, Math.min(nn - 1, Math.floor(Number(ftaRaw))));
    }
    return TP().defaultFirstToActIndex(nn);
  }

  function replayOptsForStreet(street, hand) {
    const sb = Number(hand.small_blind_bb) || 0.5;
    const bb = Number(hand.big_blind_bb) || 1;
    const posted = normalizePosted(hand);
    if (street === 'PREFLOP') {
      return {
        postBlinds: true,
        smallBlindBb: sb,
        bigBlindBb: bb,
        preflopPosted: posted.slice(),
      };
    }
    return { postBlinds: false, smallBlindBb: sb, bigBlindBb: bb };
  }

  function sumCommitted(committed) {
    let s = 0;
    (committed || []).forEach((v) => {
      const x = Number(v) || 0;
      if (x > 0) s += x;
    });
    return s;
  }

  /**
   * @param {object} hand
   * @param {number} actionCursor nombre d’événements ACTION appliqués (0 = avant la 1re action)
   * @returns {object} état UI / validation
   */
  function computeHandState(hand, actionCursor) {
    const RNk = RN();
    const n = clampN(hand.player_count);
    const firstPreflop = resolveFirstToActPreflop(hand, n);
    const sbBb = Math.max(1e-9, Number(hand.small_blind_bb) || 0.5);
    const bbBb = Math.max(1e-9, Number(hand.big_blind_bb) || 1);
    const dead = Math.max(0, Number(hand.dead_money_bb) || 0);
    const stacks0 = normalizeStacks(hand);
    const posted = normalizePosted(hand);

    const invested = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) invested[i] = posted[i];
    /** Jetons déjà « scellés » au pot (dead money + rues terminées). Les mises devant sont dans replay.committed, pas ici. */
    let potCarried = dead;

    let street = 'PREFLOP';
    let streetActions = [];
    let firstToActStreet = firstPreflop;
    const board = { flop: [], turn: null, river: null };
    let appliedActions = 0;

    const carryFolded = new Set();
    const carryAllIn = new Array(n).fill(false);

    function carryReplayOpts() {
      const base = replayOptsForStreet(street, hand);
      return Object.assign({}, base, {
        initialFolded: new Set(carryFolded),
        initialAllInSeat: carryAllIn.slice(),
      });
    }

    const timeline = Array.isArray(hand.timeline) ? hand.timeline : [];

    function applyActionLabel(label) {
      const opts = carryReplayOpts();
      const before = RNk.replayNavStateStreet(n, streetActions, firstToActStreet, opts);
      const after = RNk.replayNavStateStreet(n, streetActions.concat([label]), firstToActStreet, opts);
      for (let i = 0; i < n; i += 1) {
        const d = (after.committed[i] || 0) - (before.committed[i] || 0);
        if (d > 0) invested[i] += d;
      }
      streetActions.push(label);
    }

    for (let ti = 0; ti < timeline.length; ti += 1) {
      const ev = timeline[ti];
      if (!ev || !ev.kind) continue;

      if (ev.kind === 'ROUND_END') {
        const opts = carryReplayOpts();
        const st = RNk.replayNavStateStreet(n, streetActions, firstToActStreet, opts);
        potCarried += sumCommitted(st.committed);
        carryFolded.clear();
        st.folded.forEach((s) => carryFolded.add(s));
        for (let ai = 0; ai < n; ai += 1) carryAllIn[ai] = !!st.allInSeat[ai];
        streetActions = [];
        if (street === 'PREFLOP') street = 'FLOP';
        else if (street === 'FLOP') street = 'TURN';
        else if (street === 'TURN') street = 'RIVER';
        else if (street === 'RIVER') street = 'SHOWDOWN';
        firstToActStreet = firstPostflopActor(n, carryFolded);
        continue;
      }

      if (ev.kind === 'BOARD' && Array.isArray(ev.cards)) {
        const c = ev.cards.slice();
        if (c.length >= 3 && board.flop.length === 0) {
          board.flop = c.slice(0, 3);
        } else if (c.length >= 1 && board.flop.length === 3 && board.turn == null) {
          board.turn = c[0];
        } else if (c.length >= 1 && board.turn != null && board.river == null) {
          board.river = c[0];
        }
        continue;
      }

      if (ev.kind === 'ACTION' && typeof ev.label === 'string') {
        if (appliedActions >= actionCursor) break;
        applyActionLabel(ev.label);
        appliedActions += 1;
        continue;
      }
    }

    const replayOpts = carryReplayOpts();
    const replay = RNk.replayNavStateStreet(n, streetActions, firstToActStreet, replayOpts);
    const potDisplay = potCarried + sumCommitted(replay.committed);
    const stacksBehind = stacks0.map((s, i) => Math.max(0, s - invested[i]));

    let activePlayerCount = 0;
    for (let ai = 0; ai < n; ai += 1) {
      if (!replay.folded.has(ai)) activePlayerCount += 1;
    }
    const isHandFinished = activePlayerCount <= 1;

    const crumbs = RNk.navPathCrumbLabels(n, streetActions, firstToActStreet, carryReplayOpts());
    const lastInc = computeLastRaiseIncrement(
      streetActions,
      firstToActStreet,
      street,
      n,
      hand,
      carryFolded,
      carryAllIn
    );
    const canCloseRoundNow =
      !isHandFinished &&
      street !== 'SHOWDOWN' &&
      canBettingRoundClose(n, streetActions, firstToActStreet, street, hand, replay);
    /** Tour clos : plus d’action (Check/Call) — sinon le siège suivant recevrait un Check alors que la rue est finie. */
    const legal =
      isHandFinished || street === 'SHOWDOWN' || canCloseRoundNow
        ? []
        : computeLegalActions({
            n,
            street,
            streetActions,
            sbBb,
            bbBb,
            replay,
            stacksBehind,
            lastInc,
          });

    return {
      n,
      street,
      streetActions,
      firstToActStreet,
      replay,
      replayCarry: {
        initialFolded: Array.from(carryFolded),
        initialAllInSeat: carryAllIn.slice(),
      },
      potCarried,
      potDisplay,
      board,
      stacksBehind,
      invested,
      crumbs,
      legal,
      activePlayerCount,
      isHandFinished,
      totalActions: totalActionCount(timeline),
      canCloseRound: canCloseRoundNow,
    };
  }

  function computeLastRaiseIncrement(streetActions, firstToAct, street, n, hand, carryFolded, carryAllIn) {
    const bbBb = Math.max(1e-9, Number(hand.big_blind_bb) || 1);
    const RNk = RN();
    let lastInc = bbBb;
    const base = replayOptsForStreet(street, hand);
    const opts = Object.assign({}, base, {
      initialFolded: carryFolded ? new Set(carryFolded) : new Set(),
      initialAllInSeat: carryAllIn && carryAllIn.slice ? carryAllIn.slice() : new Array(clampN(n)).fill(false),
    });
    for (let k = 0; k < streetActions.length; k += 1) {
      const path = streetActions.slice(0, k);
      const st = RNk.replayNavStateStreet(n, path, firstToAct, opts);
      const label = streetActions[k];
      const after = RNk.replayNavStateStreet(n, path.concat([label]), firstToAct, opts);
      if (RNk.isRaiseLikeAction(label)) {
        const inc = after.maxCommit - st.maxCommit;
        if (inc > 0) lastInc = Math.max(bbBb, inc);
      }
    }
    if (streetActions.length === 0 && street === 'PREFLOP') {
      lastInc = bbBb;
    }
    if (street !== 'PREFLOP' && streetActions.length === 0) {
      lastInc = bbBb;
    }
    return lastInc;
  }

  function canBettingRoundClose(n, streetActions, firstToAct, street, hand, replay) {
    const RNk = RN();
    const opts = replayOptsForStreet(street, hand);
    const st = replay || RNk.replayNavStateStreet(n, streetActions, firstToAct, opts);
    const alive = [];
    for (let i = 0; i < n; i += 1) if (!st.folded.has(i)) alive.push(i);
    if (alive.length < 2) return true;
    if (street !== 'PREFLOP' && (!streetActions || streetActions.length === 0)) {
      return false;
    }
    const path = streetActions || [];
    const hadRaise = path.some((lbl) => RNk.isRaiseLikeAction(lbl));
    /**
     * Sans relance : postflop — orbite jusqu’à revenir au premier intervenant.
     * Préflop sans relance — tout le monde peut être à la hauteur de la BB alors que c’est encore à elle de
     * check/raise : on exige que la **dernière** action ait été prise **par la BB** (siège actif avant ce coup).
     */
    if (!hadRaise && alive.length >= 2) {
      if (path.length === 0) return false;
      if (street === 'PREFLOP') {
        const bbSeat = TP().blindSeatIndices(n).bb;
        const beforeLast = RNk.replayNavStateStreet(n, path.slice(0, -1), firstToAct, opts);
        if (beforeLast.activeSeat !== bbSeat) return false;
      } else if (st.activeSeat !== firstToAct) {
        return false;
      }
    }
    const mc = st.maxCommit;
    for (const i of alive) {
      if ((st.committed[i] || 0) < mc && !st.allInSeat[i]) return false;
    }
    return true;
  }

  function computeLegalActions(ctx) {
    const RNk = RN();
    const { n, street, streetActions, bbBb, replay, stacksBehind, lastInc } = ctx;
    let active = 0;
    for (let i = 0; i < n; i += 1) if (!replay.folded.has(i)) active += 1;
    if (active <= 1) return [];
    const seat = replay.activeSeat;
    const out = [];
    if (replay.folded.has(seat)) return out;
    if (replay.allInSeat && replay.allInSeat[seat]) return out;

    const committedSeat = replay.committed[seat] || 0;
    const maxC = replay.maxCommit;
    const toCall = Math.max(0, maxC - committedSeat);
    const stack = stacksBehind[seat] || 0;

    if (toCall > 0) {
      out.push({ type: 'fold', label: 'Fold' });
      if (stack <= 1e-9) return out;
      if (stack <= toCall + 1e-9) {
        out.push({ type: 'call', label: 'Call', allIn: true });
        return out;
      }
      out.push({ type: 'call', label: 'Call', allIn: false });
    } else {
      out.push({ type: 'check', label: 'Check' });
    }

    if (toCall >= stack - 1e-9) {
      return out;
    }

    const minRaiseTotal = maxC + Math.max(bbBb, lastInc || bbBb);
    const maxRaiseTotal = committedSeat + stack;
    if (maxRaiseTotal + 1e-9 >= minRaiseTotal) {
      const openBet =
        street !== 'PREFLOP' && (!streetActions || !streetActions.some((lbl) => RNk.isRaiseLikeAction(lbl)));
      out.push({
        type: 'raise',
        openBet,
        minTotal: minRaiseTotal,
        maxTotal: maxRaiseTotal,
      });
    }
    return out;
  }

  function formatRaiseLabel(totalBb, asBet) {
    const v = Number(totalBb);
    if (!Number.isFinite(v)) return asBet ? 'Bet 1 bb' : 'Raise 1 bb';
    const s = String(v).replace('.', ',');
    return (asBet ? 'Bet ' : 'Raise ') + s + ' bb';
  }

  function streetBreadcrumbLabel(street) {
    if (street === 'PREFLOP') return 'Préflop';
    if (street === 'FLOP') return 'Flop';
    if (street === 'TURN') return 'Turn';
    if (street === 'RIVER') return 'River';
    if (street === 'SHOWDOWN') return 'Abattage';
    return String(street || '');
  }

  /**
   * Fil d’Ariane : alternance marqueurs de rue (non cliquables) et actions
   * `{ kind: 'street', label }` / `{ kind: 'action', label, actionIndex }`.
   */
  function globalNavCrumbs(hand, actionCursor) {
    const RNk = RN();
    const n = clampN(hand.player_count);
    const firstPreflop = resolveFirstToActPreflop(hand, n);
    const sbBb = Math.max(1e-9, Number(hand.small_blind_bb) || 0.5);
    const bbBb = Math.max(1e-9, Number(hand.big_blind_bb) || 1);
    const dead = Math.max(0, Number(hand.dead_money_bb) || 0);
    const posted = normalizePosted(hand);
    const invested = new Array(n).fill(0);
    for (let i = 0; i < n; i += 1) invested[i] = posted[i];
    let potCarried = dead;

    let street = 'PREFLOP';
    let streetActions = [];
    let firstToActStreet = firstPreflop;
    let appliedActions = 0;
    const entries = [];
    let lastMarkedStreet = null;
    const timeline = Array.isArray(hand.timeline) ? hand.timeline : [];

    const carryFoldedGn = new Set();
    const carryAllInGn = new Array(n).fill(false);

    function carryReplayOptsGn() {
      const base = replayOptsForStreet(street, hand);
      return Object.assign({}, base, {
        initialFolded: new Set(carryFoldedGn),
        initialAllInSeat: carryAllInGn.slice(),
      });
    }

    function applyActionLabel(label) {
      if (street !== lastMarkedStreet) {
        entries.push({ kind: 'street', label: streetBreadcrumbLabel(street) });
        lastMarkedStreet = street;
      }
      const opts = carryReplayOptsGn();
      const before = RNk.replayNavStateStreet(n, streetActions, firstToActStreet, opts);
      const after = RNk.replayNavStateStreet(n, streetActions.concat([label]), firstToActStreet, opts);
      for (let i = 0; i < n; i += 1) {
        const d = (after.committed[i] || 0) - (before.committed[i] || 0);
        if (d > 0) invested[i] += d;
      }
      streetActions.push(label);
      const seg = RNk.navPathCrumbLabels(n, streetActions, firstToActStreet, carryReplayOptsGn());
      entries.push({ kind: 'action', label: seg[seg.length - 1], actionIndex: appliedActions });
    }

    for (let ti = 0; ti < timeline.length; ti += 1) {
      const ev = timeline[ti];
      if (!ev || !ev.kind) continue;
      if (ev.kind === 'ROUND_END') {
        const opts = carryReplayOptsGn();
        const st = RNk.replayNavStateStreet(n, streetActions, firstToActStreet, opts);
        potCarried += sumCommitted(st.committed);
        carryFoldedGn.clear();
        st.folded.forEach((s) => carryFoldedGn.add(s));
        for (let ai = 0; ai < n; ai += 1) carryAllInGn[ai] = !!st.allInSeat[ai];
        streetActions = [];
        if (street === 'PREFLOP') street = 'FLOP';
        else if (street === 'FLOP') street = 'TURN';
        else if (street === 'TURN') street = 'RIVER';
        else if (street === 'RIVER') street = 'SHOWDOWN';
        firstToActStreet = firstPostflopActor(n, carryFoldedGn);
        continue;
      }
      if (ev.kind === 'BOARD') continue;
      if (ev.kind === 'ACTION' && typeof ev.label === 'string') {
        if (appliedActions >= actionCursor) break;
        applyActionLabel(ev.label);
        appliedActions += 1;
      }
    }
    return entries;
  }

  /**
   * Curseurs d’action (nombre d’ACTION déjà appliquées) au début de chaque rue
   * avec board connu : préflop = 0 ; flop/turn/river = premier instant où la rue
   * est active, le board de la rue est posé et aucune action n’a encore été jouée sur cette rue.
   */
  function viewStreetEntryActionCursors(hand) {
    const total = totalActionCount(hand.timeline);
    const out = { preflop: 0, flop: null, turn: null, river: null };
    for (let ac = 0; ac <= total; ac += 1) {
      const st = computeHandState(hand, ac);
      if (out.flop == null && st.street === 'FLOP' && st.board.flop.length >= 3 && st.streetActions.length === 0) {
        out.flop = ac;
      }
      if (out.turn == null && st.street === 'TURN' && st.board.turn != null && st.streetActions.length === 0) {
        out.turn = ac;
      }
      if (out.river == null && st.street === 'RIVER' && st.board.river != null && st.streetActions.length === 0) {
        out.river = ac;
      }
    }
    return out;
  }

  global.HHEngine = {
    clampN,
    normalizePosted,
    /** @deprecated alias de normalizePosted (colonne `antes_bb` = mises devant). */
    normalizeAntes: normalizePosted,
    normalizeStacks,
    totalActionCount,
    viewReplayActionMax,
    viewStreetEntryActionCursors,
    computeHandState,
    formatRaiseLabel,
    replayOptsForStreet,
    firstPostflopActor,
    globalNavCrumbs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
