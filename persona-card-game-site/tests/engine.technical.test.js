/**
 * Technicals: the deterministic ailment follow-up.
 *
 * Burn + physical/wind and Shock + physical both multiply damage, and the Shock
 * combo also puts a standing target on the floor — which is a One More by the
 * ordinary rule. Everything here is a fixed board, because the whole point of
 * the mechanic is that nothing about it is a dice roll.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, applyAilment, getLegalActions, CONFIG, technicalFor } from '../src/engine/index.js';
import { setupMatch, setField, activeOf, uidOf } from './helpers.js';


/**
 * A clean board: an attacker of our choosing against Silky, who is weak to
 * fire and resists ice — every type used below is neutral against her, so the
 * only thing moving the numbers is the Technical.
 */
function board({ attacker = 'ara-mitama', ailment = null } = {}) {
  const state = setupMatch({ seed: 5150 });
  setField(state, 0, [{ cardId: attacker, level: 20, active: true }]);
  setField(state, 1, [{ cardId: 'silky', active: true }, { cardId: 'angel' }]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  if (ailment) applyAilment(state, activeOf(state, 1), ailment);
  return state;
}

const defenderHpLost = (before, after) =>
  before.players[1].field[0].hp - after.players[1].field[0].hp;

/** Fire one skill at the enemy active and report the damage it did. */
function strike(state, skillId) {
  const next = applyAction(state, { type: 'USE_SKILL', player: 0, skillId, targetUid: uidOf(state, 1, 'silky') });
  return { state: next, dealt: defenderHpLost(state, next) };
}

const TOLERANCE = 1; // damage rounds once at the very end

describe('technicalFor', () => {
  const withAilment = (type) => ({ ko: false, ailments: type ? [{ type, turnsLeft: 3 }] : [] });

  it('pairs Burn with physical and wind, and nothing else', () => {
    expect(technicalFor(withAilment('burn'), 'phys')).toBe('burn');
    expect(technicalFor(withAilment('burn'), 'wind')).toBe('burn');
    for (const type of ['fire', 'ice', 'elec', 'light', 'dark', 'almighty']) {
      expect(technicalFor(withAilment('burn'), type), `${type} should not combo with Burn`).toBe(null);
    }
  });

  it('pairs Shock with physical only', () => {
    expect(technicalFor(withAilment('shock'), 'phys')).toBe('shock');
    for (const type of ['fire', 'ice', 'elec', 'wind', 'light', 'dark', 'almighty']) {
      expect(technicalFor(withAilment('shock'), type), `${type} should not combo with Shock`).toBe(null);
    }
  });

  it('is null with no ailment, and on something already knocked out', () => {
    expect(technicalFor(withAilment(null), 'phys')).toBe(null);
    expect(technicalFor({ ko: true, ailments: [{ type: 'burn', turnsLeft: 3 }] }, 'phys')).toBe(null);
  });
});

describe('Burn technicals', () => {
  it('multiplies a physical hit and shouts about it', () => {
    const plain = strike(board(), 'bash');
    const combo = strike(board({ ailment: 'burn' }), 'bash');

    expect(combo.dealt).toBeGreaterThan(plain.dealt);
    expect(Math.abs(combo.dealt - plain.dealt * CONFIG.TECHNICAL_MULT)).toBeLessThanOrEqual(TOLERANCE);

    const shout = combo.state.log.filter((e) => e.kind === 'technical');
    expect(shout).toHaveLength(1);
    expect(shout[0].text).toContain('TECHNICAL!');
  });

  it('multiplies a wind hit too', () => {
    const plain = strike(board({ attacker: 'koppa-tengu' }), 'garu');
    const combo = strike(board({ attacker: 'koppa-tengu', ailment: 'burn' }), 'garu');
    expect(Math.abs(combo.dealt - plain.dealt * CONFIG.TECHNICAL_MULT)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('does nothing for a fire hit — you cannot fan a fire with fire', () => {
    const plain = strike(board({ attacker: 'hua-po' }), 'agi');
    const combo = strike(board({ attacker: 'hua-po', ailment: 'burn' }), 'agi');
    expect(combo.dealt).toBe(plain.dealt);
    expect(combo.state.log.some((e) => e.kind === 'technical')).toBe(false);
  });

  it('does not knock the target down on its own', () => {
    const { state } = strike(board({ ailment: 'burn' }), 'bash');
    expect(state.players[1].field[0].knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });
});

describe('Shock technicals', () => {
  it('multiplies the hit, knocks the target down, and pays a One More', () => {
    const plain = strike(board(), 'bash');
    const combo = strike(board({ ailment: 'shock' }), 'bash');

    expect(Math.abs(combo.dealt - plain.dealt * CONFIG.TECHNICAL_MULT)).toBeLessThanOrEqual(TOLERANCE);
    expect(combo.state.players[1].field[0].knockedDown).toBe(true);
    expect(combo.state.turnState.oneMoresGranted).toBe(1);
    expect(combo.state.turnState.oneMoreActive).toBe(true);
    // The One More opens the bench, exactly as a weakness knockdown does.
    const targets = getLegalActions(combo.state, 0)
      .filter((a) => a.type === 'ATTACK')
      .map((a) => a.targetUid);
    expect(targets).toHaveLength(2);
  });

  it('replaces the plain Shock damage bonus rather than stacking with it', () => {
    // Elec on a shocked target is not a Technical, so it gets the ordinary
    // SHOCK_TAKEN_MULT. Physical is a Technical and must not get both.
    const plainPhys = strike(board(), 'bash').dealt;
    const technicalPhys = strike(board({ ailment: 'shock' }), 'bash').dealt;
    expect(technicalPhys).toBeLessThan(plainPhys * CONFIG.TECHNICAL_MULT * CONFIG.SHOCK_TAKEN_MULT - TOLERANCE);

    const plainElec = strike(board({ attacker: 'omoikane' }), 'zio').dealt;
    const shockedElec = strike(board({ attacker: 'omoikane', ailment: 'shock' }), 'zio').dealt;
    expect(Math.abs(shockedElec - plainElec * CONFIG.SHOCK_TAKEN_MULT)).toBeLessThanOrEqual(TOLERANCE);
  });

  it('cannot knock down a guarding target', () => {
    const state = board({ ailment: 'shock' });
    state.players[1].field[0].guarding = true;
    const { state: after } = strike(state, 'bash');
    expect(after.players[1].field[0].knockedDown).toBe(false);
    expect(after.turnState.oneMoresGranted).toBe(0);
  });

  it('cannot knock down something already down, and pays nothing for trying', () => {
    const state = board({ ailment: 'shock' });
    state.players[1].field[0].knockedDown = true;
    const { state: after } = strike(state, 'bash');
    expect(after.turnState.oneMoresGranted).toBe(0);
  });
});

describe('determinism', () => {
  it('produces byte-identical results from the same board', () => {
    const a = strike(board({ ailment: 'burn' }), 'bash');
    const b = strike(board({ ailment: 'burn' }), 'bash');
    expect(a.dealt).toBe(b.dealt);
    // A Technical consumes no randomness of its own: the RNG is untouched by it.
    expect(a.state.rng).toEqual(b.state.rng);
  });
});

describe('Lesser Theurgy — the only guaranteed way to start one', () => {
  /** Our Persona holding the card, against something with plain affinities. */
  function withCard() {
    const state = setupMatch({ seed: 4004 });
    setField(state, 0, [{ cardId: 'ara-mitama', level: 20, active: true }]);
    setField(state, 1, [{ cardId: 'silky', level: 20, maxHp: 400, hp: 400, active: true }]);
    state.players[0].hand = [{ uid: 'h1', cardId: 'lesser-theurgy' }];
    state.players[1].hand = [];
    return state;
  }

  const play = (state, ailment) =>
    applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: 'h1', ailment });

  it('offers both ailments as a real choice', () => {
    const options = getLegalActions(withCard(), 0).filter((a) => a.cardId === 'lesser-theurgy');
    expect(options.map((a) => a.ailment).sort()).toEqual(['burn', 'shock']);
  });

  it('always lands, with no roll involved', () => {
    for (const ailment of ['burn', 'shock']) {
      const before = withCard();
      const after = play(before, ailment);
      expect(after.players[1].field[0].ailments.map((a) => a.type)).toEqual([ailment]);
      // No randomness was consumed getting there.
      expect(after.rng).toEqual(before.rng);
    }
  });

  it('costs no action, so Shock sets up a Technical in the SAME turn', () => {
    let state = play(withCard(), 'shock');
    expect(state.turnState.actionsRemaining).toBe(1);

    state = applyAction(state, { type: 'ATTACK', player: 0, targetUid: uidOf(state, 1, 'silky') });
    expect(state.log.some((e) => e.kind === 'technical')).toBe(true);
    expect(state.players[1].field[0].knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(1);
  });

  it('is not offered against a target that already has both', () => {
    const state = withCard();
    applyAilment(state, activeOf(state, 1), 'burn');
    applyAilment(state, activeOf(state, 1), 'shock');
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'lesser-theurgy')).toHaveLength(0);
  });

  it('refuses an ailment it does not offer', () => {
    expect(() => play(withCard(), 'freeze')).toThrow(/cannot inflict/);
  });
});
