/**
 * Sièges dans l’ordre horaire : BTN, SB, BB, puis (sens horaire après la BB) les positions
 * jusqu’au CO : … LJ+3, LJ+2, LJ+1, LJ, HJ, CO. Le LJ est toujours juste avant le HJ ;
 * les sièges plus tôt que le LJ sont nommés LJ+1, LJ+2, LJ+3…
 */
(function (global) {
  function middleSeatLabels(m) {
    if (m <= 0) return [];
    if (m === 1) return ['CO'];
    if (m === 2) return ['HJ', 'CO'];
    const out = [];
    const earlyCount = m - 3;
    for (let k = earlyCount; k >= 1; k -= 1) {
      out.push('LJ+' + k);
    }
    out.push('LJ', 'HJ', 'CO');
    return out;
  }

  /**
   * @param {number} n joueurs (2–10)
   * @returns {string[]}
   */
  function positionLabelsForPlayerCount(n) {
    const count = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    if (count === 2) return ['BTN', 'BB'];
    if (count === 3) return ['BTN', 'SB', 'BB'];
    return ['BTN', 'SB', 'BB'].concat(middleSeatLabels(count - 3));
  }

  /** Siège immédiatement après la BB (horaire), indice dans positionLabelsForPlayerCount. */
  function defaultFirstToActIndex(n) {
    const count = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    const bbIndex = count === 2 ? 1 : 2;
    return (bbIndex + 1) % count;
  }

  /** Sièges des blindes (ordre BTN, SB, BB, …). En HU, le BTN poste la petite blinde. */
  function blindSeatIndices(n) {
    const count = Math.max(2, Math.min(10, Math.floor(Number(n)) || 2));
    if (count === 2) return { sb: 0, bb: 1 };
    return { sb: 1, bb: 2 };
  }

  global.TablePositions = {
    positionLabelsForPlayerCount,
    defaultFirstToActIndex,
    blindSeatIndices,
  };
})(typeof window !== 'undefined' ? window : globalThis);
