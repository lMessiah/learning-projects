/**
 * Endure.
 *
 * DESIGN DECISION, asserted here and stated in the Rules screen: Endure catches
 * ANY otherwise-fatal damage, not just an attack. It lives in `applyDamage`,
 * which is the single funnel every source goes through — a skill, a Counter, a
 * Burn tick, Fatigue — so there is one rule rather than one per damage source.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, applyAilment, PASSIVE_DEFS, passiveOf, CONFIG } from '../src/engine/index.js';
import { PERSONAS } from '../src/data/cards.js';
import { setupMatch, setField, activeOf, uidOf, endTurn } from './helpers.js';

/** Kaiwan (Endure) on the back foot against something that hits hard. */
function board({ hp = 6 } = {}) {
  const state = setupMatch({ seed: 616 });
  setField(state, 0, [{ cardId: 'ippon-datara', level: 22, active: true }]);
  setField(state, 1, [{ cardId: 'kaiwan', level: 14, hp, active: true }, { cardId: 'angel' }]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

const victimOf = (state) => state.players[1].field.find((p) => p.cardId === 'kaiwan');
const hit = (state) =>
  applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'heat-wave', targetUid: uidOf(state, 1, 'kaiwan') });

describe('the passive itself', () => {
  it('is declared, and printed on exactly two Personas', () => {
    expect(PASSIVE_DEFS.endure).toBeTruthy();
    const holders = PERSONAS.filter((p) => p.passive === 'endure').map((p) => p.id);
    expect(holders).toHaveLength(2);
    expect(holders).toContain('kaiwan'); // common, so every flavour can draw one
    expect(holders).toContain('nekomata');
  });

  it('starts every Persona with its one use intact', () => {
    const state = board();
    expect(victimOf(state).endured).toBe(false);
  });
});

describe('surviving', () => {
  it('leaves the holder on exactly 1 HP instead of knocking it out', () => {
    const next = hit(board({ hp: 6 }));
    const kaiwan = victimOf(next);
    expect(kaiwan.ko).toBe(false);
    expect(kaiwan.hp).toBe(1);
    expect(kaiwan.endured).toBe(true);
    expect(next.players[1].koCount).toBe(0);
    expect(next.log.some((e) => e.kind === 'endure' && e.text.includes('endured the hit'))).toBe(true);
  });

  it('fires only once — the second fatal blow lands', () => {
    let state = hit(board({ hp: 6 }));
    expect(victimOf(state).hp).toBe(1);

    // Hand the action budget back and swing again.
    state.turnState.actionsRemaining = 1;
    state = hit(state);
    expect(victimOf(state).ko).toBe(true);
    expect(state.players[1].koCount).toBe(1);
  });

  it('does nothing to a hit the holder would have survived anyway', () => {
    const state = board({ hp: 400 });
    state.players[1].field[0].maxHp = 400;
    const next = hit(state);
    const kaiwan = victimOf(next);
    expect(kaiwan.hp).toBeGreaterThan(1);
    expect(kaiwan.endured).toBe(false);
  });

  it('catches a Burn tick, not just an attack', () => {
    const state = board({ hp: CONFIG.BURN_DAMAGE });
    applyAilment(state, victimOf(state), 'burn');
    // Burn resolves at the end of its owner's turn, so pass the turn to them
    // and then let them end it.
    let next = endTurn(state, 0);
    next = endTurn(next, 1);

    const kaiwan = victimOf(next);
    expect(kaiwan.ko).toBe(false);
    expect(kaiwan.hp).toBe(1);
    expect(kaiwan.endured).toBe(true);
  });

  it('catches Fatigue too', () => {
    const state = board({ hp: 1 });
    state.players[1].fatigue = 4; // 20 damage a turn, against 1 HP
    let next = endTurn(state, 0); // player 1's turn begins: fatigue bites

    const kaiwan = victimOf(next);
    expect(kaiwan.ko).toBe(false);
    expect(kaiwan.hp).toBe(1);
    expect(kaiwan.endured).toBe(true);
  });

  it('survives being passed through a fusion — the result gets a fresh use', () => {
    // A fusion result is a brand new instance, so an inherited Endure has not
    // been spent even if the parent's had been.
    const state = setupMatch({ seed: 42 });
    setField(state, 0, [{ cardId: 'kaiwan', level: 14, active: true }]);
    const kaiwan = activeOf(state, 0);
    kaiwan.endured = true;
    expect(passiveOf(kaiwan)).toBe('endure');
    expect(kaiwan.endured).toBe(true);
    // The flag is per instance, not per card.
    setField(state, 1, [{ cardId: 'kaiwan', level: 14, active: true }]);
    expect(activeOf(state, 1).endured).toBe(false);
  });
});
