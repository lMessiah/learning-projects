/**
 * Passives.
 *
 * One printed passive per Persona at most, always-on or auto-triggered, never
 * an activated choice. Each hook gets its own test here; Trickster's chaining
 * lives in engine.onemore.test.js where the rest of the One More rules are.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  visibleAffinities,
  CONFIG,
  PASSIVE_DEFS,
  passiveOf,
  printedPassive,
  hasPassive,
} from '../src/engine/index.js';
import { PERSONAS, PASSIVE_IDS } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf, endTurn } from './helpers.js';

describe('the passive table', () => {
  it('never prints more than one passive on a card, and only known ones', () => {
    for (const persona of PERSONAS) {
      expect(Array.isArray(persona.passive)).toBe(false); // a single id, never a list
      if (persona.passive) {
        expect(PASSIVE_IDS).toContain(persona.passive);
        expect(PASSIVE_DEFS[persona.passive]).toBeTruthy();
      }
    }
  });

  it('implements every id the data is allowed to use', () => {
    for (const id of PASSIVE_IDS) expect(PASSIVE_DEFS[id]).toBeTruthy();
    for (const id of Object.keys(PASSIVE_DEFS)) expect(PASSIVE_IDS).toContain(id);
  });

  it('gives every passive a name and a description the UI can print', () => {
    for (const def of Object.values(PASSIVE_DEFS)) {
      expect(def.name).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(20);
    }
  });

  it('puts the interesting passives on starter-tier Personas', () => {
    expect(printedPassive('pixie')).toBe('trickster');
    expect(printedPassive('orpheus')).toBe('analyst');
    expect(printedPassive('apsaras')).toBe('soul-battery');
    expect(printedPassive('ara-mitama')).toBe('stalwart');
  });

  it('reads the passive off the instance, so a fusion can change it', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    expect(passiveOf(activeOf(state, 0))).toBe('trickster');
    expect(hasPassive(activeOf(state, 0), 'trickster')).toBe(true);
    expect(hasPassive(activeOf(state, 0), 'stalwart')).toBe(false);
  });
});

describe('Stalwart — onKnockdownAttempt', () => {
  /** Apsaras (Bufu) against Ara Mitama, which is weak to ice and holds Stalwart. */
  function iceOnStalwart(hp) {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'apsaras', active: true }]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true, hp, maxHp: 100 }]);
    return state;
  }

  it('refuses the knockdown while above half HP', () => {
    let state = iceOnStalwart(100);
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bufu' });

    const wall = activeOf(state, 1);
    expect(wall.hp).toBeLessThan(100); // it still takes the weakness damage
    expect(wall.hp).toBeGreaterThan(50);
    expect(wall.knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0); // and grants no One More
    expect(state.log.some((l) => l.text.includes('Stalwart'))).toBe(true);
  });

  it('goes down once the hit drops it to half HP or below', () => {
    let state = iceOnStalwart(60);
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bufu' });

    const wall = activeOf(state, 1);
    expect(wall.hp).toBeLessThanOrEqual(50);
    expect(wall.knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(1);
  });
});

describe('Counter — onDamageTaken', () => {
  /** Ippon-Datara swinging physical skills at Odin, which holds Counter. */
  function physOnCounter({ knockedDown = false } = {}) {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'ippon-datara', active: true }]);
    setField(state, 1, [{ cardId: 'odin', active: true, hp: 900, maxHp: 900 }]);
    activeOf(state, 1).knockedDown = knockedDown;
    return state;
  }

  it('reflects a quarter of a physical hit back at the attacker', () => {
    let state = physOnCounter();
    const attackerHpBefore = activeOf(state, 0).hp;
    const defenderHpBefore = activeOf(state, 1).hp;

    state = applyAction(state, { type: 'ATTACK', player: 0 });

    const dealt = defenderHpBefore - activeOf(state, 1).hp;
    const lost = attackerHpBefore - activeOf(state, 0).hp;
    expect(dealt).toBeGreaterThan(0);
    expect(lost).toBe(Math.round(dealt * CONFIG.COUNTER_REFLECT));
    expect(state.log.some((l) => l.text.includes('Counter'))).toBe(true);
  });

  it('does not reflect magic', () => {
    let state = physOnCounter();
    setField(state, 0, [{ cardId: 'apsaras', active: true }]); // Bufu, and Odin is weak to ice
    const attackerHpBefore = activeOf(state, 0).hp;

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bufu' });

    expect(activeOf(state, 0).hp).toBe(attackerHpBefore);
  });

  it('does not reflect while the holder is already knocked down', () => {
    let state = physOnCounter({ knockedDown: true });
    const attackerHpBefore = activeOf(state, 0).hp;

    state = applyAction(state, { type: 'ATTACK', player: 0 });

    expect(activeOf(state, 0).hp).toBe(attackerHpBefore);
  });

  it('never counters a counter', () => {
    // Both sides hold Counter; the reflected damage must not bounce back again.
    let state = physOnCounter();
    setField(state, 0, [{ cardId: 'odin', active: true, hp: 900, maxHp: 900 }]);
    const before = activeOf(state, 0).hp;

    state = applyAction(state, { type: 'ATTACK', player: 0 });

    const reflectLogs = state.log.filter((l) => l.text.includes('counters for'));
    expect(reflectLogs).toHaveLength(1);
    expect(activeOf(state, 0).hp).toBeLessThan(before);
  });
});

describe('Analyst — onDamageDealt', () => {
  it('lays the whole affinity chart bare when it damages an enemy', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]); // Analyst, knows Agi
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 900, maxHp: 900 }]); // weak dark, resists elec

    expect(visibleAffinities(state, activeOf(state, 1), 0).weaknesses).toEqual([]);

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });

    const seen = visibleAffinities(state, activeOf(state, 1), 0);
    expect(seen.weaknesses).toEqual(['dark']); // never struck with dark, but known now
    expect(seen.resists).toEqual(['elec']);
  });

  it('reveals nothing extra for a Persona without the passive', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'hua-po', active: true }]); // also knows Agi, no Analyst
    setField(state, 1, [{ cardId: 'pixie', active: true, hp: 900, maxHp: 900 }]);

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });

    expect(visibleAffinities(state, activeOf(state, 1), 0).weaknesses).toEqual([]);
  });
});

describe('Bloodlust — damage multiplier', () => {
  function bloodlustAttack({ behindBy }) {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'take-minakata', active: true }]); // Bloodlust
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    state.players[0].koCount = behindBy;
    state.players[1].koCount = 0;
    const before = activeOf(state, 1).hp;
    const next = applyAction(state, { type: 'ATTACK', player: 0 });
    return before - next.players[1].field[0].hp;
  }

  it('hits harder while behind on the KO tally', () => {
    const level = bloodlustAttack({ behindBy: 0 });
    const behind = bloodlustAttack({ behindBy: 2 });
    expect(behind).toBeGreaterThan(level);
    // Damage rounds once, at the very end, so comparing two rounded figures
    // leaves a single point of slack.
    expect(Math.abs(behind - level * CONFIG.BLOODLUST_MULT)).toBeLessThanOrEqual(1);
  });

  it('does nothing while ahead', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'take-minakata', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    state.players[0].koCount = 0;
    state.players[1].koCount = 4; // player 0 is well ahead
    const before = activeOf(state, 1).hp;
    const after = applyAction(state, { type: 'ATTACK', player: 0 });
    expect(before - after.players[1].field[0].hp).toBe(bloodlustAttack({ behindBy: 0 }));
  });
});

describe('Soul Battery — onTurnStart', () => {
  /** One full round for player 0, with `cardId` in the active slot. */
  function regenFor(cardId) {
    let state = setupMatch();
    setField(state, 0, [{ cardId, active: true, sp: 0 }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    return activeOf(state, 0).sp;
  }

  it('regenerates double SP in the active slot', () => {
    expect(regenFor('silky')).toBe(CONFIG.SP_REGEN_PER_TURN); // no passive
    expect(regenFor('apsaras')).toBe(CONFIG.SP_REGEN_PER_TURN * CONFIG.SOUL_BATTERY_MULT);
  });

  it('pays nothing on the bench, because nothing regenerates there', () => {
    let state = setupMatch();
    setField(state, 0, [
      { cardId: 'silky', active: true, sp: 0 },
      { cardId: 'apsaras', sp: 0 }, // Soul Battery, benched
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);

    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(state.players[0].field[1].sp).toBe(0);
  });
});

describe('Sacrificial Lamb — onFusionMaterial', () => {
  it('hands the fusion result extra levels', () => {
    let state = setupMatch();
    // Girimehkala = Moon + Hermit, combined level 32+. Hua Po holds the passive.
    setField(state, 0, [
      { cardId: 'mothman', active: true, level: 17 },
      { cardId: 'hua-po', level: 20 },
      { cardId: 'silky' }, // spare body so the fusion isn't gutting the board
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);

    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-girimehkala');
    expect(fuse).toBeTruthy();
    state = applyAction(state, fuse);

    const result = state.players[0].field.find((p) => p.cardId === 'girimehkala');
    const printed = PERSONAS.find((p) => p.id === 'girimehkala').level;
    expect(result.level).toBe(printed + CONFIG.SACRIFICIAL_LAMB_LEVELS);
    // The extra levels come with stats, not just a bigger number.
    expect(result.maxHp).toBeGreaterThan(PERSONAS.find((p) => p.id === 'girimehkala').hp);
  });

  it('leaves the result at its printed level when neither parent is a Lamb', () => {
    let state = setupMatch();
    setField(state, 0, [
      { cardId: 'mothman', active: true, level: 17 },
      { cardId: 'ippon-datara', level: 20 }, // Hermit, no passive
      { cardId: 'silky' },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);

    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-girimehkala');
    state = applyAction(state, fuse);

    const result = state.players[0].field.find((p) => p.cardId === 'girimehkala');
    expect(result.level).toBe(PERSONAS.find((p) => p.id === 'girimehkala').level);
  });
});

describe('fusion inheritance of passives', () => {
  /** Titania = Lovers + Star, combined 28+. Pixie brings Trickster. */
  function titaniaSetup() {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'pixie', active: true, level: 10 },
      { cardId: 'anzu', level: 22 },
      { cardId: 'silky' },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    return state;
  }

  it('offers each parent its skills OR its passive', () => {
    const state = titaniaSetup();
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-titania');
    expect(fuse.inheritOptions[0]).toContain('passive:trickster');
    expect(fuse.inheritOptions[1].every((o) => !o.startsWith('passive:'))).toBe(true); // Anzu has none
    expect(fuse.inherit.every((o) => !o.startsWith('passive:'))).toBe(true); // default is skills
  });

  it('carries the passive onto the result when chosen', () => {
    let state = titaniaSetup();
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-titania');
    state = applyAction(state, { ...fuse, inherit: ['passive:trickster', fuse.inherit[1]] });

    const result = state.players[0].field.find((p) => p.cardId === 'titania');
    expect(passiveOf(result)).toBe('trickster');
    // It took the passive INSTEAD of a skill, so only one skill came across.
    expect(result.inheritedSkills).toHaveLength(1);
    expect(state.log.some((l) => l.text.includes('Trickster passive'))).toBe(true);
  });

  it('refuses to take two passives', () => {
    let state = setupMatch();
    // Black Frost = Magician + Priestess, 32+. Nekomata and Apsaras both have one.
    setField(state, 0, [
      { cardId: 'jack-o-lantern', active: true, level: 20 },
      { cardId: 'apsaras', level: 15 },
      { cardId: 'silky' },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-black-frost');

    expect(() =>
      applyAction(state, {
        ...fuse,
        inherit: ['passive:sacrificial-lamb', 'passive:soul-battery'],
        replacePassive: true,
      })
    ).toThrow(/at most one passive/);
  });

  it('will not overwrite a native passive without a confirmation', () => {
    let state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-o-lantern', active: true, level: 20 },
      { cardId: 'apsaras', level: 15 },
      { cardId: 'silky' },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-black-frost');
    expect(fuse.resultPassive).toBe('trickster'); // Black Frost prints its own

    const swap = { ...fuse, inherit: ['passive:sacrificial-lamb', fuse.inherit[1]] };
    expect(() => applyAction(state, swap)).toThrow(/confirm the replacement/);

    const confirmed = applyAction(state, { ...swap, replacePassive: true });
    const result = confirmed.players[0].field.find((p) => p.cardId === 'black-frost');
    expect(passiveOf(result)).toBe('sacrificial-lamb');
  });

  it('keeps the native passive when nothing is inherited over it', () => {
    let state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-o-lantern', active: true, level: 20 },
      { cardId: 'apsaras', level: 15 },
      { cardId: 'silky' },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true }]);
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-black-frost');
    state = applyAction(state, fuse); // default: two skills

    const result = state.players[0].field.find((p) => p.cardId === 'black-frost');
    expect(passiveOf(result)).toBe('trickster');
  });

  it('rejects a passive the parent does not have', () => {
    const state = titaniaSetup();
    const fuse = getLegalActions(state, 0).find((a) => a.recipeId === 'fuse-titania');
    expect(() => applyAction(state, { ...fuse, inherit: ['passive:stalwart', fuse.inherit[1]] })).toThrow(
      /passive is trickster/
    );
    expect(() => applyAction(state, { ...fuse, inherit: [fuse.inherit[0], 'passive:stalwart'] })).toThrow(
      /no passive to pass on/
    );
  });
});

describe('passives are never a choice', () => {
  it('puts nothing passive-shaped in the legal action list', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }, { cardId: 'ara-mitama' }]);
    setHand(state, 0, ['medicine']);
    for (const action of getLegalActions(state, 0)) {
      expect(action.type).not.toMatch(/PASSIVE/i);
      expect(action.passive).toBeUndefined();
    }
  });
});
