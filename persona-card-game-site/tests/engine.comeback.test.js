/**
 * Comeback mechanics.
 *
 * All three are keyed off the same number — how many more of your own Personas
 * have been knocked out than your opponent's — and all three are inert at
 * parity or ahead, so the player who is winning never gets a hand up.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, drawCards, koDeficit, momentumBonus, CONFIG, createMatch } from '../src/engine/index.js';
import { cardQuality } from '../src/data/cards.js';
import { levelsEarnedFor } from '../src/engine/effects.js';
import { setupMatch, setField, activeOf, endTurn, fakePersona } from './helpers.js';

/** A deck that alternates the worst card in the game with the best. */
const ALTERNATING = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'armageddon' : 'amrita-soda'));

function deckedMatch({ seed, deficit }) {
  const state = setupMatch({ seed });
  const player = state.players[0];
  player.deck = [...ALTERNATING];
  player.hand = [];
  player.discard = [];
  player.koCount = deficit;
  state.players[1].koCount = 0;
  return state;
}

/** Draw `n` cards and report how many were the high-quality ones. */
function drawQuality(state, n) {
  drawCards(state, 0, n);
  return state.players[0].hand.filter((c) => c.cardId === 'armageddon').length;
}

describe('the deficit itself', () => {
  it('counts how far behind a player is, and is negative when ahead', () => {
    const state = setupMatch();
    state.players[0].koCount = 5;
    state.players[1].koCount = 2;
    expect(koDeficit(state, 0)).toBe(3);
    expect(koDeficit(state, 1)).toBe(-3);
  });
});

describe('Momentum Draw', () => {
  it('takes the top card while level or ahead', () => {
    // The deck alternates worst/best, so an unweighted 10-card draw is exactly
    // the first ten cards: five of each, every time.
    for (const deficit of [0, -3]) {
      const state = deckedMatch({ seed: 7, deficit: Math.max(0, deficit) });
      state.players[0].koCount = 0;
      state.players[1].koCount = Math.abs(Math.min(0, deficit));
      expect(drawQuality(state, 10)).toBe(5);
      expect(state.players[0].deck).toEqual(ALTERNATING.slice(10));
    }
  });

  it('skews toward stronger cards while behind, more so the further behind', () => {
    const total = (deficit) => {
      let high = 0;
      for (let seed = 1; seed <= 40; seed++) high += drawQuality(deckedMatch({ seed, deficit }), 10);
      return high;
    };

    const even = total(0); // 40 trials x 5 = 200 by construction
    const behind2 = total(2);
    const behind6 = total(6);

    expect(even).toBe(200);
    expect(behind2).toBeGreaterThan(even);
    expect(behind6).toBeGreaterThan(behind2);
  });

  it('stays deterministic: the same seed and deficit draw the same cards', () => {
    const a = deckedMatch({ seed: 99, deficit: 4 });
    const b = deckedMatch({ seed: 99, deficit: 4 });
    drawCards(a, 0, 8);
    drawCards(b, 0, 8);
    expect(a.players[0].hand.map((c) => c.cardId)).toEqual(b.players[0].hand.map((c) => c.cardId));
    expect(a.rng).toEqual(b.rng);
  });

  it('scores cards on one scale, so a Persona and an Item can be compared', () => {
    expect(cardQuality('amrita-soda')).toBe(0);
    expect(cardQuality('armageddon')).toBe(1);
    expect(cardQuality('anzu')).toBeGreaterThan(cardQuality('pixie'));
    for (const id of ['pixie', 'anzu', 'medicine', 'soma', 'theurgy']) {
      expect(cardQuality(id)).toBeGreaterThanOrEqual(0);
      expect(cardQuality(id)).toBeLessThanOrEqual(1);
    }
  });
});

/* ------------------------------------------------------------------ *
 * The curve, and what it refuses to reward
 * ------------------------------------------------------------------ */

describe('the momentum curve', () => {
  it('is inert below the activation deficit', () => {
    for (const n of [-3, -1, 0, 1]) expect(momentumBonus(n)).toBe(0);
    expect(CONFIG.MOMENTUM_MIN_DEFICIT).toBe(2);
    expect(momentumBonus(CONFIG.MOMENTUM_MIN_DEFICIT)).toBeGreaterThan(0);
  });

  it('front-loads: it is nearly maxed the moment it switches on', () => {
    const share = (n) => momentumBonus(n) / CONFIG.MOMENTUM_CAP;
    expect(share(2)).toBeCloseTo(0.84, 2);
    expect(share(3)).toBeCloseTo(0.94, 2);
    expect(share(5)).toBeCloseTo(0.99, 2);
  });

  it('is concave and capped, so falling further behind buys almost nothing', () => {
    // Every step is smaller than the one before it — the definition of concave —
    // and the whole thing is bounded by the cap.
    const steps = [3, 4, 5, 6, 7].map((n) => momentumBonus(n) - momentumBonus(n - 1));
    for (let i = 1; i < steps.length; i++) expect(steps[i]).toBeLessThan(steps[i - 1]);
    for (const n of [2, 5, 10, 40]) expect(momentumBonus(n)).toBeLessThan(CONFIG.MOMENTUM_CAP);

    // The bagging case in one number: throwing away four more Personas to fall
    // from -2 to -6 is worth less than a fifth of what arriving at -2 was worth.
    const first = momentumBonus(2);
    const rest = momentumBonus(6) - momentumBonus(2);
    expect(rest).toBeLessThan(first / 5);
  });

  it('never lets the losing player out-draw what the curve promises', () => {
    // 40 seeds x 10 cards: the share of high-quality cards climbs from -2 but
    // the gain flattens, exactly as the curve says it should.
    const total = (deficit) => {
      let high = 0;
      for (let seed = 1; seed <= 40; seed++) high += drawQuality(deckedMatch({ seed, deficit }), 10);
      return high;
    };
    const at1 = total(1);
    const at2 = total(2);
    const at6 = total(6);

    expect(at1).toBe(200); // below the threshold: uniform, five of each
    expect(at2).toBeGreaterThan(at1);
    expect(at6 - at2).toBeLessThan(at2 - at1); // the tail is flat
  });
});

describe('playability gating', () => {
  /** A deck alternating a Persona too big to play with a worthless Item. */
  const gatedMatch = ({ seed, fieldLevel }) => {
    const state = setupMatch({ seed });
    setField(state, 0, [{ cardId: 'pixie', level: fieldLevel, active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    const player = state.players[0];
    player.deck = Array.from({ length: 40 }, (_, i) => (i % 2 ? 'anzu' : 'amrita-soda'));
    player.hand = [];
    player.discard = [];
    player.koCount = 6; // deep into momentum
    state.players[1].koCount = 0;
    return state;
  };

  const anzuDrawn = (state, n) => {
    drawCards(state, 0, n);
    return state.players[0].hand.filter((c) => c.cardId === 'anzu').length;
  };

  it('prices an unplayable Persona as junk however good it is on paper', () => {
    // Anzu is level 22 and a genuinely strong card; on a level-3 board the
    // ceiling is 13, so it is a brick and momentum must not chase it.
    expect(cardQuality('anzu')).toBeGreaterThan(cardQuality('amrita-soda'));

    let stuck = 0;
    let reachable = 0;
    for (let seed = 1; seed <= 40; seed++) {
      stuck += anzuDrawn(gatedMatch({ seed, fieldLevel: 3 }), 10);
      reachable += anzuDrawn(gatedMatch({ seed, fieldLevel: 20 }), 10);
    }

    // Out of reach: every card weighs the same, so 400 draws land on roughly
    // the 200 Anzus chance alone would give (this is a weighted roll, not the
    // top of the deck, so it wobbles).
    expect(Math.abs(stuck - 200)).toBeLessThan(30);
    // In reach: the same deck, the same deficit, and now momentum wants it.
    expect(reachable).toBeGreaterThan(stuck + 40);
  });

  it('leaves Items and Specials alone — they are playable at any board state', () => {
    // Armageddon is a Special, so its quality never falls to junk no matter how
    // small the board is. The original alternating deck proves it.
    const state = deckedMatch({ seed: 3, deficit: 6 });
    setField(state, 0, [{ cardId: 'pixie', level: 3, active: true }]);
    let high = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = deckedMatch({ seed, deficit: 6 });
      setField(s, 0, [{ cardId: 'pixie', level: 3, active: true }]);
      high += drawQuality(s, 10);
    }
    expect(high).toBeGreaterThan(200);
    expect(state.players[0].deck.length).toBe(40); // untouched by the setup
  });
});

describe('the staggered thresholds', () => {
  it('turns the comeback stack on one knockout at a time', () => {
    expect(CONFIG.MOMENTUM_MIN_DEFICIT).toBe(2);
    expect(CONFIG.COMEBACK_UNDERDOG_DEFICIT).toBe(3);
    expect(CONFIG.WHIMS_DEFICIT).toBe(4);
    // Strictly increasing: nothing shares an activation point with anything else.
    expect(CONFIG.MOMENTUM_MIN_DEFICIT).toBeLessThan(CONFIG.COMEBACK_UNDERDOG_DEFICIT);
    expect(CONFIG.COMEBACK_UNDERDOG_DEFICIT).toBeLessThan(CONFIG.WHIMS_DEFICIT);
  });

  it('leaves a player two knockouts down with momentum and nothing else', () => {
    let state = setupMatch({ seed: 5 });
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    state.players[0].koCount = CONFIG.MOMENTUM_MIN_DEFICIT;
    state.players[1].koCount = 0;

    expect(momentumBonus(koDeficit(state, 0))).toBeGreaterThan(0);

    state = endTurn(state, 0);
    const before = state.players[0].hand.length;
    state = endTurn(state, 1);
    expect(state.players[0].hand.length - before).toBe(CONFIG.DRAW_PER_TURN); // not yet Underdog
  });
});

describe('Underdog Draw', () => {
  function drawsAtStartOfTurn(deficit) {
    let state = setupMatch({ seed: 5 });
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    state.players[0].koCount = deficit;
    state.players[1].koCount = 0;

    state = endTurn(state, 0);
    const before = state.players[0].hand.length;
    state = endTurn(state, 1); // player 0's turn begins
    return state.players[0].hand.length - before;
  }

  it(`draws ${CONFIG.COMEBACK_UNDERDOG_DRAW} a turn once behind by ${CONFIG.COMEBACK_UNDERDOG_DEFICIT}`, () => {
    expect(drawsAtStartOfTurn(CONFIG.COMEBACK_UNDERDOG_DEFICIT)).toBe(CONFIG.COMEBACK_UNDERDOG_DRAW);
    expect(drawsAtStartOfTurn(CONFIG.COMEBACK_UNDERDOG_DEFICIT + 3)).toBe(CONFIG.COMEBACK_UNDERDOG_DRAW);
  });

  it('draws the normal amount below that threshold', () => {
    expect(drawsAtStartOfTurn(0)).toBe(CONFIG.DRAW_PER_TURN);
    expect(drawsAtStartOfTurn(CONFIG.COMEBACK_UNDERDOG_DEFICIT - 1)).toBe(CONFIG.DRAW_PER_TURN);
  });
});

describe('level catch-up', () => {
  const at = (level) => fakePersona('pixie', { level });

  it('teaches nothing for beating something far below you', () => {
    expect(levelsEarnedFor(at(20), at(20 - CONFIG.COMEBACK_FARM_GAP))).toBe(0);
    expect(levelsEarnedFor(at(20), at(1))).toBe(0);
  });

  it('still pays one level for a fair fight', () => {
    expect(levelsEarnedFor(at(20), at(20 - CONFIG.COMEBACK_FARM_GAP + 1))).toBe(1);
    expect(levelsEarnedFor(at(20), at(20))).toBe(1);
  });

  it('still pays double for punching up', () => {
    expect(levelsEarnedFor(at(20), at(20 + CONFIG.LEVEL_UP_GAP))).toBe(2);
  });

  it('applies in a real knockout, and says so in the log', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'ippon-datara', active: true, level: 30 }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 1 }, { cardId: 'silky' }]);
    const before = activeOf(state, 0).level;

    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(state.players[1].field[0].ko).toBe(true);
    expect(activeOf(state, 0).level).toBe(before); // no farming
    expect(state.log.some((l) => l.text.includes('learned nothing'))).toBe(true);
  });
});

describe('no Awakening mechanic', () => {
  it('never turns the KO tally into a level or SP burst', () => {
    // The same knockout, once at parity and once from six Personas down. The
    // killer must come out of both identical: the deficit feeds draws, not
    // stats. (Bloodlust is the one exception, and it is a printed passive on a
    // specific card — Ippon-Datara has none.)
    const knockout = (deficit) => {
      let state = setupMatch();
      setField(state, 0, [{ cardId: 'ippon-datara', active: true, level: 10, sp: 5 }]);
      setField(state, 1, [{ cardId: 'pixie', active: true, hp: 1, level: 8 }, { cardId: 'silky' }]);
      state.players[0].koCount = deficit;
      state.players[1].koCount = 0;
      state = applyAction(state, { type: 'ATTACK', player: 0 });
      const { level, sp, maxSp, strength, magic, endurance } = activeOf(state, 0);
      return { level, sp, maxSp, strength, magic, endurance };
    };

    const even = knockout(0);
    expect(knockout(6)).toEqual(even);
    expect(even.level).toBe(11); // the ordinary +1 for the KO, nothing more
  });

  it('has no awakening flag anywhere in a fresh match state', () => {
    const state = createMatch({ seed: 1, players: [{ name: 'A', deckId: 'p3' }, { name: 'B', deckId: 'p4' }] });
    expect(JSON.stringify(state).toLowerCase()).not.toContain('awaken');
    expect(Object.keys(CONFIG).some((key) => /AWAKEN/i.test(key))).toBe(false);
  });
});
