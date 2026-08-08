import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, visibleAffinities, CONFIG } from '../src/engine/index.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

/** Orpheus (fire) vs Jack Frost (weak to fire) with a big HP pool so it survives. */
function fireVsIce({ defenderHp = 400 } = {}) {
  const state = setupMatch();
  setField(state, 0, [{ cardId: 'orpheus', active: true }]);
  setField(state, 1, [
    { cardId: 'jack-frost', active: true, hp: defenderHp, maxHp: defenderHp },
    { cardId: 'pixie' },
  ]);
  return state;
}

const agi = (player = 0, targetUid) => ({ type: 'USE_SKILL', player, skillId: 'agi', targetUid });

describe('One More', () => {
  it('grants one extra action and one extra Persona change when a weakness is struck', () => {
    let state = fireVsIce();
    expect(state.turnState.actionsRemaining).toBe(1);
    expect(state.turnState.personaChangesRemaining).toBe(1);

    state = applyAction(state, agi());

    expect(state.turnState.oneMoreUsed).toBe(true);
    expect(state.turnState.actionsRemaining).toBe(1); // spent one, gained one
    expect(state.turnState.personaChangesRemaining).toBe(2); // Baton Pass
    expect(state.log.some((l) => l.kind === 'onemore')).toBe(true);
  });

  it('grants at most one One More per turn — no infinite chains', () => {
    let state = fireVsIce();
    state = applyAction(state, agi());
    state = applyAction(state, agi());

    expect(state.turnState.oneMoreUsed).toBe(true);
    expect(state.turnState.actionsRemaining).toBe(0);
    expect(state.turnState.personaChangesRemaining).toBe(2);
  });

  it('does not grant a One More for a neutral or resisted hit', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 400, maxHp: 400 }]); // Pixie: weak dark, resists elec
    state = applyAction(state, agi());
    expect(state.turnState.oneMoreUsed).toBe(false);
    expect(state.turnState.actionsRemaining).toBe(0);
  });
});

describe('knockdown', () => {
  it('knocks the target down when a weakness lands', () => {
    let state = fireVsIce();
    state = applyAction(state, agi());
    expect(activeOf(state, 1).knockedDown).toBe(true);
  });

  it('stands Personas back up at the start of their owner\'s turn', () => {
    let state = fireVsIce();
    state = applyAction(state, agi());
    expect(activeOf(state, 1).knockedDown).toBe(true);

    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    expect(state.activePlayer).toBe(1);
    expect(activeOf(state, 1).knockedDown).toBe(false);
  });

  it('lets a guarding Persona take a weakness without going down, at half damage', () => {
    let state = fireVsIce();
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'GUARD', player: 1 });
    expect(activeOf(state, 1).guarding).toBe(true);

    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    const before = activeOf(state, 1).hp;
    state = applyAction(state, agi());
    const dealt = before - activeOf(state, 1).hp;

    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(dealt).toBe(22); // 38*8/14 = 21.71 -> x2 weakness x0.5 guard -> 21.71 -> 22
  });

  it('clears guard at the start of the guarding player\'s next turn', () => {
    let state = fireVsIce();
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'GUARD', player: 1 });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    expect(activeOf(state, 1).guarding).toBe(true); // still up during the opponent's turn
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    expect(activeOf(state, 1).guarding).toBe(false);
  });

  it('refuses to let a knocked-down Persona act', () => {
    let state = fireVsIce();
    state = applyAction(state, agi());
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    // Knock player 0's own active down artificially and try to act.
    activeOf(state, 1).knockedDown = true;
    expect(() => applyAction(state, { type: 'ATTACK', player: 1 })).toThrow(/knocked down/);
    // ...but passing is always allowed.
    expect(() => applyAction(state, { type: 'PASS', player: 1 })).not.toThrow();
  });
});

describe('hidden weaknesses', () => {
  it('hides affinities from the opponent until that damage type lands', () => {
    let state = fireVsIce();
    const before = visibleAffinities(state, activeOf(state, 1), 0);
    expect(before.weaknesses).toEqual([]);
    expect(before.resists).toEqual([]);

    // The owner always sees their own Persona in full.
    expect(visibleAffinities(state, activeOf(state, 1), 1).weaknesses).toEqual(['fire']);

    state = applyAction(state, agi());
    const after = visibleAffinities(state, activeOf(state, 1), 0);
    expect(after.weaknesses).toEqual(['fire']);
    expect(after.resists).toEqual([]); // ice not yet tested
  });

  it('reveals a resist when that type is used, not just weaknesses', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'apsaras', active: true }]); // knows Bufu
    setField(state, 1, [{ cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 }]);
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bufu' });
    expect(visibleAffinities(state, activeOf(state, 1), 0).resists).toEqual(['ice']);
  });
});

describe('status ailments', () => {
  it('burns for 5 at the end of each of the owner\'s turns, for 3 turns', () => {
    let state = fireVsIce();
    const victim = activeOf(state, 1);
    victim.ailments.push({ type: 'burn', turnsLeft: CONFIG.BURN_DURATION });
    const startHp = victim.hp;

    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] }); // player 0 ends; burn is on player 1
    expect(activeOf(state, 1).hp).toBe(startHp); // not their turn yet

    state = endTurn(state, 1);
    expect(activeOf(state, 1).hp).toBe(startHp - CONFIG.BURN_DAMAGE);
    expect(activeOf(state, 1).ailments[0].turnsLeft).toBe(2);

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(activeOf(state, 1).hp).toBe(startHp - CONFIG.BURN_DAMAGE * 3);
    expect(activeOf(state, 1).ailments).toHaveLength(0); // wore off after 3 turns
  });

  it('stops a shocked Persona from acting, then wears off at the end of that turn', () => {
    let state = fireVsIce();
    activeOf(state, 1).ailments.push({ type: 'shock', turnsLeft: CONFIG.SHOCK_DURATION });
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });

    expect(() => applyAction(state, { type: 'ATTACK', player: 1 })).toThrow(/shocked/);
    const legal = getLegalActions(state, 1);
    expect(legal.some((a) => a.type === 'ATTACK')).toBe(false);
    expect(legal.some((a) => a.type === 'PASS')).toBe(true);

    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    expect(activeOf(state, 1).ailments).toHaveLength(0);
  });

  it('refreshes rather than stacks a repeated ailment', () => {
    let state = fireVsIce();
    const victim = activeOf(state, 1);
    victim.ailments.push({ type: 'burn', turnsLeft: 1 });
    state = applyAction(state, agi());
    // Whether the Agi rider procs is a seeded roll; either way there is one entry.
    expect(activeOf(state, 1).ailments.filter((a) => a.type === 'burn').length).toBeLessThanOrEqual(1);
  });

  it('cures ailments with Amrita Soda', () => {
    let state = fireVsIce();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    activeOf(state, 0).ailments.push({ type: 'burn', turnsLeft: 3 });
    setHand(state, 0, ['amrita-soda']);

    state = applyAction(state, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(state, 0, 'amrita-soda'),
      targetUid: activeOf(state, 0).uid,
    });
    expect(activeOf(state, 0).ailments).toHaveLength(0);
  });
});

describe('targeting', () => {
  it('only allows the opponent\'s active Persona to be targeted', () => {
    const state = fireVsIce();
    const benchUid = state.players[1].field[1].uid;
    expect(() => applyAction(state, { type: 'ATTACK', player: 0, targetUid: benchUid })).toThrow(/active Persona/);
    expect(getLegalActions(state, 0).filter((a) => a.type === 'ATTACK')).toHaveLength(1);
  });

  it('opens up the enemy bench for the turn after Ambush', () => {
    let state = fireVsIce();
    setHand(state, 0, ['ambush']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'ambush') });

    expect(state.turnState.canTargetBench).toBe(true);
    const benchUid = state.players[1].field[1].uid;
    expect(() => applyAction(state, { type: 'ATTACK', player: 0, targetUid: benchUid })).not.toThrow();
    expect(getLegalActions(state, 0).filter((a) => a.type === 'ATTACK')).toHaveLength(2);

    // The permission expires with the turn.
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    expect(state.turnState.canTargetBench).toBe(false);
  });

  it('hits every enemy Persona with the Armageddon special', () => {
    let state = fireVsIce();
    setHand(state, 0, ['armageddon']);
    const before = state.players[1].field.map((p) => p.hp);

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'armageddon') });

    const after = state.players[1].field.map((p) => p.hp);
    expect(after[0]).toBeLessThan(before[0]);
    expect(after[1]).toBeLessThan(before[1]); // the bench took it too
    expect(state.turnState.actionsRemaining).toBe(0); // Armageddon uses your action
  });
});
