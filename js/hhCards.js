/**
 * Deck 52 cartes : codes « Ah », « Kd », … Pas de doublon.
 */
(function (global) {
  const RANKS = '23456789TJQKA';
  const SUITS = { h: '♥', d: '♦', c: '♣', s: '♠' };
  const SUIT_KEYS = Object.keys(SUITS);

  /** Colonnes du sélecteur matriciel : rang (A → 2). */
  const MATRIX_RANK_COLS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
  /** Lignes : pique, cœur, carreau, trèfle. */
  const MATRIX_SUIT_ROWS = ['s', 'h', 'd', 'c'];

  function allCardCodes() {
    const out = [];
    for (let r = 0; r < RANKS.length; r += 1) {
      for (let s = 0; s < SUIT_KEYS.length; s += 1) {
        out.push(RANKS[r] + SUIT_KEYS[s]);
      }
    }
    return out;
  }

  function parseCard(code) {
    const t = String(code || '').trim();
    if (t.length !== 2) return null;
    const rank = t[0].toUpperCase() === 'T' ? 'T' : t[0].toUpperCase();
    const suit = t[1].toLowerCase();
    if (!RANKS.includes(rank) || !SUITS[suit]) return null;
    return { code: rank + suit, rank, suit };
  }

  function suitClass(suit) {
    if (suit === 'h') return 'hh-playing-card--heart';
    if (suit === 'd') return 'hh-playing-card--diamond';
    if (suit === 'c') return 'hh-playing-card--club';
    return 'hh-playing-card--spade';
  }

  function rankDisplay(rank) {
    if (rank === 'T') return '10';
    return rank;
  }

  function usedSetFromHand(hand) {
    const used = new Set();
    const hc = hand && hand.hole_cards ? hand.hole_cards : {};
    Object.keys(hc).forEach((k) => {
      const arr = hc[k];
      if (Array.isArray(arr)) {
        arr.forEach((c) => {
          const p = parseCard(c);
          if (p) used.add(p.code);
        });
      }
    });
    const tl = hand && Array.isArray(hand.timeline) ? hand.timeline : [];
    tl.forEach((ev) => {
      if (ev && ev.kind === 'BOARD' && Array.isArray(ev.cards)) {
        ev.cards.forEach((c) => {
          const p = parseCard(c);
          if (p) used.add(p.code);
        });
      }
    });
    return used;
  }

  global.HHCards = {
    allCardCodes,
    parseCard,
    suitClass,
    rankDisplay,
    usedSetFromHand,
    SUITS,
    MATRIX_RANK_COLS,
    MATRIX_SUIT_ROWS,
  };
})(typeof window !== 'undefined' ? window : globalThis);
