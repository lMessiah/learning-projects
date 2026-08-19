import { describe, it, expect } from 'vitest';
import { applyAction, buffOf, CONFIG } from '../src/engine/index.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

/**
 * Ara Mitama knows Tarukaja from level 1; at level 9 it also knows Rakunda.
 *
 * Both sides field TWO Personas on purpose. Buffs cover a whole side, so a
 * one-body board cannot tell the difference between the rule and the rule it
 * replaced — every test here needs a bench to be worth anything.
 */
function buffBoard() {
  const state = setupMatch();
  setField(state, 0, [{ cardId: 'ara-mitama', level: 9, active: true }, { cardId: 'pixie' }]);
  setField(state, 1, [
    { cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 },
    { cardId: 'orpheus', hp: 400, maxHp: 400 },
  ]);
  return state;
}

/** Everyone on a side, active and bench alike. */
const fieldOf = (state, player) => state.players[player].field;
const benchPersonas = (state, player) =>
  fieldOf(state, player).filter((p) => p.uid !== state.players[player].activeUid);

const tarukaja = { type: 'USE_SKILL', player: 0, skillId: 'tarukaja' };
const rakunda = { type: 'USE_SKILL', player: 0, skillId: 'rakunda' };

/** Both players end their turn: one tick off player 0's durations, back to 0. */
const cycle = (state) => endTurn(endTurn(state, 0), 1);

describe('buffs and debuffs are field-wide', () => {
  it('a buff lands on every Persona you have out, bench included', () => {
    const state = applyAction(buffBoard(), tarukaja);
    for (const persona of fieldOf(state, 0)) {
      expect(buffOf(persona, 'atk')).toMatchObject({
        stat: 'atk',
        direction: 'up',
        turnsLeft: CONFIG.BUFF_DURATION,
      });
    }
    // ...and nothing of theirs.
    for (const persona of fieldOf(state, 1)) expect(buffOf(persona, 'atk')).toBe(null);
  });

  it('a debuff lands on every Persona THEY have out, and none of yours', () => {
    const state = applyAction(buffBoard(), rakunda);
    for (const persona of fieldOf(state, 1)) {
      expect(buffOf(persona, 'def')).toMatchObject({ direction: 'down' });
    }
    for (const persona of fieldOf(state, 0)) expect(buffOf(persona, 'def')).toBe(null);
  });

  it('the record stays per-Persona, so a body that arrives later is unbuffed', () => {
    let state = applyAction(buffBoard(), tarukaja);
    expect(fieldOf(state, 0).every((p) => buffOf(p, 'atk'))).toBe(true);

    // A third Persona is played AFTER the cast. It missed it — which is the
    // whole reason the record lives on each Persona instead of on the player.
    setHand(state, 0, ['slime']);
    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'slime') });

    const latecomer = fieldOf(state, 0).find((p) => p.cardId === 'slime');
    expect(latecomer).toBeTruthy();
    expect(buffOf(latecomer, 'atk')).toBe(null);
  });
});

describe('recasting a buff extends it', () => {
  it('two turns left plus a fresh cast is five, and the log says so', () => {
    let state = applyAction(buffBoard(), tarukaja);
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(2);

    state = applyAction(state, tarukaja);
    // Still ONE buff — extending is not stacking, the multiplier is unchanged.
    expect(activeOf(state, 0).buffs).toHaveLength(1);
    for (const persona of fieldOf(state, 0)) {
      expect(buffOf(persona, 'atk').turnsLeft).toBe(2 + CONFIG.BUFF_DURATION);
    }
    expect(state.log.some((l) => l.text.includes('extended to 5 turns'))).toBe(true);
  });

  it('never runs past the cap, however often you recast', () => {
    // One action a turn, so each recast costs a full turn cycle — which is
    // exactly why the cap sits at 2x the base: you may bank one cast ahead.
    let state = applyAction(buffBoard(), tarukaja); // 3
    state = cycle(state); // 2
    state = applyAction(state, tarukaja); // 2 + 3 = 5
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(5);

    state = cycle(state); // 4
    state = applyAction(state, tarukaja); // 4 + 3 = 7, clamped
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(CONFIG.BUFF_MAX_DURATION);
  });

  it('says so in the log when a Persona is already at the ceiling', () => {
    let state = applyAction(buffBoard(), tarukaja);
    // Sat at the cap by hand: reaching it AND casting again in the same turn is
    // not something the action budget allows, but the branch still has to work.
    for (const persona of fieldOf(state, 0)) persona.buffs[0].turnsLeft = CONFIG.BUFF_MAX_DURATION;
    state = cycle(state);
    for (const persona of fieldOf(state, 0)) persona.buffs[0].turnsLeft = CONFIG.BUFF_MAX_DURATION;

    state = applyAction(state, tarukaja);
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(CONFIG.BUFF_MAX_DURATION);
    expect(state.log.some((l) => l.text.includes('no further extension'))).toBe(true);
  });

  it('extends each Persona from ITS own remaining duration, not a shared one', () => {
    let state = applyAction(buffBoard(), tarukaja);
    state = cycle(state); // both down to 2
    // Knock the bench Persona's timer down by hand — it is the only way to get
    // two different durations on one side, and it is exactly the case the
    // grouped log has to keep straight.
    benchPersonas(state, 0)[0].buffs[0].turnsLeft = 1;

    state = applyAction(state, tarukaja);
    expect(buffOf(activeOf(state, 0), 'atk').turnsLeft).toBe(5); // 2 + 3
    expect(buffOf(benchPersonas(state, 0)[0], 'atk').turnsLeft).toBe(4); // 1 + 3
    expect(state.log.some((l) => l.text.includes('extended to 5 turns'))).toBe(true);
    expect(state.log.some((l) => l.text.includes('extended to 4 turns'))).toBe(true);
  });
});

describe('opposing buffs cancel', () => {
  it('cancels across the whole field, per Persona', () => {
    let state = buffBoard();
    setField(state, 0, [{ cardId: 'pixie', level: 9, active: true }, { cardId: 'pixie', level: 9 }]);
    for (const persona of fieldOf(state, 0)) {
      persona.buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    }

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'rakukaja' });
    for (const persona of fieldOf(state, 0)) expect(persona.buffs).toHaveLength(0);
    expect(state.log.some((l) => l.text.includes('cancelled out'))).toBe(true);
  });

  it('cancels only where the opposite is present — the rest just gain the buff', () => {
    let state = buffBoard();
    setField(state, 0, [{ cardId: 'pixie', level: 9, active: true }, { cardId: 'pixie', level: 9 }]);
    activeOf(state, 0).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'rakukaja' });
    expect(buffOf(activeOf(state, 0), 'def')).toBe(null); // cancelled
    expect(buffOf(benchPersonas(state, 0)[0], 'def')).toMatchObject({ direction: 'up' }); // applied
  });
});

describe('duration', () => {
  it("expires after 3 of the owner's turns, everywhere at once", () => {
    let state = applyAction(buffBoard(), tarukaja);
    for (let i = 0; i < 2; i++) {
      state = endTurn(state, 0);
      state = endTurn(state, 1);
    }
    for (const persona of fieldOf(state, 0)) expect(buffOf(persona, 'atk').turnsLeft).toBe(1);

    state = endTurn(state, 0);
    state = endTurn(state, 1);
    for (const persona of fieldOf(state, 0)) expect(buffOf(persona, 'atk')).toBe(null);
  });

  it('keeps buffs on a Persona through a swap — both slots are already covered', () => {
    let state = applyAction(buffBoard(), tarukaja);
    const buffedUid = activeOf(state, 0).uid;
    const benchUid = benchPersonas(state, 0)[0].uid;

    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: benchUid });
    expect(state.players[0].activeUid).toBe(benchUid);

    // The whole point of the field-wide rule: swapping no longer sheds the buff.
    expect(buffOf(state.players[0].field.find((p) => p.uid === buffedUid), 'atk')).toMatchObject({ direction: 'up' });
    expect(buffOf(activeOf(state, 0), 'atk')).toMatchObject({ direction: 'up' });
  });
});

describe('one shared implementation', () => {
  it('skills, Items and Specials all go through it', () => {
    // Item: Muscle Drink == Tarukaja. (One Item per turn, so these need
    // separate turns — hence two independent boards.)
    let viaItem = buffBoard();
    setHand(viaItem, 0, ['muscle-drink']);
    viaItem = applyAction(viaItem, { type: 'PLAY_ITEM', player: 0, handUid: handUidOf(viaItem, 0, 'muscle-drink') });
    for (const persona of fieldOf(viaItem, 0)) {
      expect(buffOf(persona, 'atk')).toMatchObject({ direction: 'up', turnsLeft: CONFIG.BUFF_DURATION });
    }

    // ...identical to what the Tarukaja skill produces.
    const viaSkill = applyAction(buffBoard(), tarukaja);
    expect(buffOf(activeOf(viaItem, 0), 'atk')).toEqual(buffOf(activeOf(viaSkill, 0), 'atk'));

    // Item: Sapping Device == Rakunda across the enemy field.
    let viaDebuffItem = buffBoard();
    setHand(viaDebuffItem, 0, ['sapping-device']);
    viaDebuffItem = applyAction(viaDebuffItem, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(viaDebuffItem, 0, 'sapping-device'),
    });
    for (const persona of fieldOf(viaDebuffItem, 1)) {
      expect(buffOf(persona, 'def')).toMatchObject({ direction: 'down' });
    }
  });
});

describe('Dekaja and Dekunda', () => {
  it('Dekaja strips buffs from the whole enemy field, leaving debuffs alone', () => {
    let state = buffBoard();
    for (const persona of fieldOf(state, 1)) {
      persona.buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
      persona.buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    }
    setHand(state, 0, ['dekaja']);

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'dekaja') });
    for (const persona of fieldOf(state, 1)) {
      expect(buffOf(persona, 'atk')).toBe(null); // the buff is gone
      expect(buffOf(persona, 'def')).toMatchObject({ direction: 'down' }); // the debuff stays
    }
  });

  it('Dekunda strips debuffs from your whole field, leaving your buffs alone', () => {
    let state = buffBoard();
    for (const persona of fieldOf(state, 0)) {
      persona.buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
      persona.buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    }
    setHand(state, 0, ['dekunda']);

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'dekunda') });
    for (const persona of fieldOf(state, 0)) {
      expect(buffOf(persona, 'def')).toBe(null);
      expect(buffOf(persona, 'atk')).toMatchObject({ direction: 'up' });
    }
  });

  it('one Dekaja answers one Tarukaja — the whole field, not a third of it', () => {
    let state = applyAction(buffBoard(), tarukaja);
    // Hand it to the OTHER player, who is the one being buffed against.
    setHand(state, 1, ['dekaja']);
    state = endTurn(state, 0);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 1, handUid: handUidOf(state, 1, 'dekaja') });

    for (const persona of fieldOf(state, 0)) expect(buffOf(persona, 'atk')).toBe(null);
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
