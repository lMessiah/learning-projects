import { describe, it, expect } from 'vitest';
import { applyAction, buffOf, CONFIG } from '../src/engine/index.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

/** Ara Mitama knows Tarukaja from level 1; at level 9 it also knows Rakunda. */
function buffBoard() {
  const state = setupMatch();
  setField(state, 0, [{ cardId: 'ara-mitama', level: 9, active: true }, { cardId: 'pixie' }]);
  setField(state, 1, [{ cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 }]);
  return state;
}

const tarukaja = { type: 'USE_SKILL', player: 0, skillId: 'tarukaja' };
const rakunda = { type: 'USE_SKILL', player: 0, skillId: 'rakunda' };

describe('buffs and debuffs', () => {
  it('applies a 3-turn attack buff to the user', () => {
    const state = applyAction(buffBoard(), tarukaja);
    const buff = buffOf(activeOf(state, 0), 'atk');
    expect(buff).toMatchObject({ stat: 'atk', direction: 'up', turnsLeft: CONFIG.BUFF_DURATION });
  });

  it('applies a debuff to the enemy active Persona', () => {
    const state = applyAction(buffBoard(), rakunda);
    expect(buffOf(activeOf(state, 1), 'def')).toMatchObject({ direction: 'down' });
    expect(buffOf(activeOf(state, 0), 'def')).toBe(null);
  });

  it('does not stack with itself — reapplying refreshes the duration', () => {
    let state = applyAction(buffBoard(), tarukaja);
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(2);

    state = applyAction(state, tarukaja);
    expect(activeOf(state, 0).buffs).toHaveLength(1);
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(CONFIG.BUFF_DURATION);
  });

  it('cancels a buff against its opposing debuff', () => {
    // Sapping Device is Rakunda in item form; Rakukaja would cancel it.
    let state = buffBoard();
    setField(state, 0, [{ cardId: 'pixie', level: 9, active: true }]); // Pixie learns Rakukaja at 9
    activeOf(state, 0).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'rakukaja' });
    expect(activeOf(state, 0).buffs).toHaveLength(0);
    expect(state.log.some((l) => l.text.includes('cancelled out'))).toBe(true);
  });

  it('expires after 3 of the owner\'s turns', () => {
    let state = applyAction(buffBoard(), tarukaja);
    for (let i = 0; i < 2; i++) {
      state = endTurn(state, 0);
      state = endTurn(state, 1);
    }
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(1);

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(buffOf(activeOf(state, 0), 'atk')).toBe(null);
  });

  it('keeps buffs on the Persona when it swaps to the bench', () => {
    let state = applyAction(buffBoard(), tarukaja);
    const buffedUid = activeOf(state, 0).uid;
    const benchUid = state.players[0].field.find((p) => p.uid !== buffedUid).uid;

    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: benchUid });
    expect(state.players[0].activeUid).toBe(benchUid);

    const benched = state.players[0].field.find((p) => p.uid === buffedUid);
    expect(buffOf(benched, 'atk')).toMatchObject({ direction: 'up' });
    expect(buffOf(activeOf(state, 0), 'atk')).toBe(null); // the new active is unbuffed
  });

  it('uses one shared implementation for skills, Items and Specials', () => {
    // Item: Muscle Drink == Tarukaja. (One Item per turn, so these need
    // separate turns — hence two independent boards.)
    let viaItem = buffBoard();
    setHand(viaItem, 0, ['muscle-drink']);
    viaItem = applyAction(viaItem, { type: 'PLAY_ITEM', player: 0, handUid: handUidOf(viaItem, 0, 'muscle-drink') });
    expect(buffOf(activeOf(viaItem, 0), 'atk')).toMatchObject({ direction: 'up', turnsLeft: CONFIG.BUFF_DURATION });

    // ...identical to what the Tarukaja skill produces.
    const viaSkill = applyAction(buffBoard(), tarukaja);
    expect(buffOf(activeOf(viaItem, 0), 'atk')).toEqual(buffOf(activeOf(viaSkill, 0), 'atk'));

    // Item: Sapping Device == Rakunda on the enemy active.
    let viaDebuffItem = buffBoard();
    setHand(viaDebuffItem, 0, ['sapping-device']);
    viaDebuffItem = applyAction(viaDebuffItem, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(viaDebuffItem, 0, 'sapping-device'),
    });
    expect(buffOf(activeOf(viaDebuffItem, 1), 'def')).toMatchObject({ direction: 'down' });
  });
});

describe('Dekaja and Dekunda', () => {
  it('Dekaja strips buffs from the enemy active Persona only', () => {
    let state = buffBoard();
    activeOf(state, 1).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    activeOf(state, 1).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    setHand(state, 0, ['dekaja']);

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'dekaja') });
    expect(buffOf(activeOf(state, 1), 'atk')).toBe(null); // the buff is gone
    expect(buffOf(activeOf(state, 1), 'def')).toMatchObject({ direction: 'down' }); // the debuff stays
  });

  it('Dekunda strips debuffs from your own active Persona only', () => {
    let state = buffBoard();
    activeOf(state, 0).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    activeOf(state, 0).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    setHand(state, 0, ['dekunda']);

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'dekunda') });
    expect(buffOf(activeOf(state, 0), 'def')).toBe(null);
    expect(buffOf(activeOf(state, 0), 'atk')).toMatchObject({ direction: 'up' });
  });
});

describe('Concentrate and Charge', () => {
  it('multiplies the next matching skill by 2.5 and is then consumed', () => {
    let state = buffBoard();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setHand(state, 0, ['concentrate']);

    const baseline = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    const plainDamage = 400 - activeOf(baseline, 1).hp;

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'concentrate') });
    expect(activeOf(state, 0).charges).toContain('concentrate');

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    const boostedDamage = 400 - activeOf(state, 1).hp;

    // Agi on Jack Frost: 38 * 8 / (8 + 6) = 21.714, x2 weakness -> 43.
    // With Concentrate the x2.5 lands before the single rounding step:
    // 21.714 x 2 x 2.5 = 108.57 -> 109, which is why this is not round(43 x 2.5).
    expect(plainDamage).toBe(43);
    expect(boostedDamage).toBe(109);
    expect(activeOf(state, 0).charges).toHaveLength(0); // spent
  });

  it('does not let Concentrate boost a physical skill', () => {
    let state = buffBoard();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setHand(state, 0, ['concentrate']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'concentrate') });
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });
    expect(activeOf(state, 0).charges).toContain('concentrate'); // untouched
  });
});
