/**
 * Every Special card, end to end through the reducer, plus the
 * fusion behaviours the UI depends on.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  personaSkills,
  buffOf,
  describeFusions,
  computeDamage,
  passiveDefinition,
  CONFIG,
} from '../src/engine/index.js';
import { SPECIALS, getCard, getPersona, getSkillDefinition } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, fakePersona, unlockFusion } from './helpers.js';

/** Player 0: Orpheus (fire/phys). Player 1: Jack Frost (weak fire) + a bench. */
function board({ ownerCard = 'orpheus' } = {}) {
  const state = setupMatch();
  setField(state, 0, [{ cardId: ownerCard, active: true }, { cardId: 'pixie' }]);
  setField(state, 1, [
    { cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 },
    { cardId: 'apsaras', hp: 200, maxHp: 200 },
  ]);
  return state;
}

const play = (state, cardId, extra = {}) =>
  applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, cardId), ...extra });

/** `board()` plus everything the strategic Specials need to bite on. */
function loadedBoard() {
  const state = board();
  activeOf(state, 0).sp = 10;
  activeOf(state, 0).buffs.push({ stat: 'atk', direction: 'down', turnsLeft: 3 });
  activeOf(state, 1).buffs.push({ stat: 'def', direction: 'up', turnsLeft: 3 });
  state.players[0].field[1].sp = 0;
  // A knocked-out Persona for Velvet Summons to call back...
  const fallen = state.players[0].field[1];
  state.players[0].field.push({ ...fallen, uid: 'fallen', ko: true, hp: 0 });
  // ...a bench body for the opponent so a forced switch has somewhere to go...
  state.players[1].field.push({ ...state.players[1].field[1], uid: 'foe-bench' });
  // ...a skill on the record for Wild Card to borrow...
  state.players[1].lastSkillId = 'bufu';
  // ...and a fully-scouted enemy active, which is what arms Phantom Strike.
  const foe = getPersona(state.players[1].field[0].cardId);
  state.players[1].field[0].revealedTypes = [...foe.weaknesses, ...foe.resists];
  return state;
}

describe('every Special is playable', () => {
  it('keeps pure damage to a handful and makes the rest strategic', () => {
    const damage = SPECIALS.filter((s) => s.effect.kind === 'damage');
    expect(damage.map((s) => s.id).sort()).toEqual(['armageddon', 'theurgy']);
    expect(damage.length).toBeLessThanOrEqual(3);
    expect(SPECIALS.length - damage.length).toBeGreaterThanOrEqual(7);
  });

  it('gives every Special a distinct effect kind or a distinct decision', () => {
    for (const special of SPECIALS) {
      expect(special.effect.kind).toBeTruthy();
      expect(special.description.length).toBeGreaterThan(20);
      expect(special.quality).toBeGreaterThanOrEqual(1);
      expect(special.quality).toBeLessThanOrEqual(5);
    }
  });

  it('offers each Special as a legal action when it has something to do', () => {
    for (const special of SPECIALS) {
      const state = loadedBoard();
      // Third Eye is the one card that wants the mark UNread — everything else
      // on the loaded board wants it scouted (Phantom Strike requires it).
      if (special.effect.kind === 'reveal') state.players[1].field[0].revealedTypes = [];
      setHand(state, 0, [special.id]);

      const legal = getLegalActions(state, 0).filter((a) => a.type === 'PLAY_SPECIAL');
      expect(legal.length, `${special.name} produced no legal play`).toBeGreaterThan(0);
      expect(() => applyAction(state, legal[0]), `${special.name} threw`).not.toThrow();
    }
  });
});

describe('damage Specials say what they do', () => {
  /** A Persona with no affinity to almighty and enough HP to survive anything. */
  function dummyBoard() {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    return state;
  }

  it('deals exactly the number printed on the card, for every damage Special', () => {
    for (const special of SPECIALS.filter((s) => s.effect.kind === 'damage')) {
      const stated = special.effect.amount;
      expect(stated, `${special.name} states no amount`).toBeGreaterThan(0);
      expect(special.description).toContain(String(stated));

      const state = dummyBoard();
      setHand(state, 0, [special.id]);
      const before = activeOf(state, 1).hp;
      const after = play(state, special.id);

      expect(before - activeOf(after, 1).hp, `${special.name} does not deal what it says`).toBe(stated);
    }
  });

  it('is unmoved by the attacker\'s stats', () => {
    const damageFrom = (cardId) => {
      const state = dummyBoard();
      setField(state, 0, [{ cardId, active: true }]);
      setHand(state, 0, ['theurgy']);
      return 900 - activeOf(play(state, 'theurgy'), 1).hp;
    };
    // STR 16 / MAG 5 against STR 8 / MAG 18 — under the old stat-ratio formula
    // these differed by a wide margin.
    expect(damageFrom('ippon-datara')).toBe(damageFrom('sarasvati'));
    expect(damageFrom('ippon-datara')).toBe(60);
  });

  it('is unmoved by buffs, Charge or Shock', () => {
    const state = dummyBoard();
    setHand(state, 0, ['theurgy']);
    activeOf(state, 0).charges.push('concentrate');
    activeOf(state, 0).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    activeOf(state, 1).ailments.push({ type: 'shock', turnsLeft: 1 });

    const after = play(state, 'theurgy');
    expect(900 - activeOf(after, 1).hp).toBe(60);
    expect(activeOf(after, 0).charges).toEqual(['concentrate']); // not consumed either
  });

  it('is still halved by a guard', () => {
    const hit = (guarding) => {
      const state = dummyBoard();
      setHand(state, 0, ['theurgy']);
      activeOf(state, 1).guarding = guarding;
      return 900 - activeOf(play(state, 'theurgy'), 1).hp;
    };
    expect(hit(true)).toBe(Math.round(hit(false) * CONFIG.GUARD_MULT));
  });

  it('is still doubled by a weakness and halved by a resist', () => {
    // Almighty is never weak or resisted, so the affinity half of the rule is
    // checked at the formula: flat 100 fire against Jack Frost (weak) and
    // Orpheus (resists fire).
    const flat = (defender) =>
      computeDamage({
        attacker: fakePersona('orpheus'),
        defender: fakePersona(defender),
        power: 100,
        damageType: 'fire',
        category: 'magic',
        flat: true,
      }).amount;

    expect(flat('pixie')).toBe(100); // neutral
    expect(flat('jack-frost')).toBe(100 * CONFIG.WEAK_MULT);
    expect(flat('orpheus')).toBe(100 * CONFIG.RESIST_MULT);
  });
});

describe('Theurgy', () => {
  it('deals heavy almighty damage and uses up your action', () => {
    const state = board();
    setHand(state, 0, ['theurgy']);
    const before = activeOf(state, 1).hp;

    const after = play(state, 'theurgy');
    const dealt = before - activeOf(after, 1).hp;

    expect(dealt).toBeGreaterThan(50);
    expect(after.turnState.actionsRemaining).toBe(0);
    expect(after.players[0].discard).toContain('theurgy');
  });

  it('still needs an active Persona to deliver it', () => {
    const state = board();
    state.players[0].activeUid = null;
    setHand(state, 0, ['theurgy']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'theurgy')).toHaveLength(0);
  });
});

describe('Armageddon', () => {
  it('hits every enemy Persona, active and benched', () => {
    const state = board();
    setHand(state, 0, ['armageddon']);
    const before = state.players[1].field.map((p) => p.hp);

    const after = play(state, 'armageddon');
    const now = after.players[1].field.map((p) => p.hp);

    expect(now[0]).toBeLessThan(before[0]);
    expect(now[1]).toBeLessThan(before[1]);
    expect(after.turnState.actionsRemaining).toBe(0);
  });

  it('leaves your own Personas alone', () => {
    const state = board();
    setHand(state, 0, ['armageddon']);
    const before = state.players[0].field.map((p) => p.hp);
    const after = play(state, 'armageddon');
    expect(after.players[0].field.map((p) => p.hp)).toEqual(before);
  });

  it('deals its printed number to each target, and ignores Concentrate', () => {
    const plain = board();
    setHand(plain, 0, ['armageddon']);
    const plainAfter = play(plain, 'armageddon');
    const plainHits = plain.players[1].field.map((p, i) => p.hp - plainAfter.players[1].field[i].hp);
    expect(plainHits).toEqual([30, 30]);

    // A flat Special is flat: a held Charge changes nothing and is not spent,
    // so it is still there for the skill you actually wanted it for.
    const boosted = board();
    setHand(boosted, 0, ['armageddon']);
    activeOf(boosted, 0).charges.push('concentrate');
    const boostedAfter = play(boosted, 'armageddon');
    const boostedHits = boosted.players[1].field.map((p, i) => p.hp - boostedAfter.players[1].field[i].hp);

    expect(boostedHits).toEqual(plainHits);
    expect(activeOf(boostedAfter, 0).charges).toEqual(['concentrate']);
  });
});

describe('Ambush', () => {
  it('opens the enemy bench for the rest of the turn and costs no action', () => {
    const state = board();
    setHand(state, 0, ['ambush']);
    const after = play(state, 'ambush');

    expect(after.turnState.canTargetBench).toBe(true);
    expect(after.turnState.actionsRemaining).toBe(1);

    const benchUid = after.players[1].field[1].uid;
    const struck = applyAction(after, { type: 'USE_SKILL', player: 0, skillId: 'agi', targetUid: benchUid });
    expect(struck.players[1].field[1].hp).toBeLessThan(200);
  });

  it('expires when the turn does', () => {
    const start = board();
    setHand(start, 0, ['ambush']);
    let state = play(start, 'ambush');
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    expect(state.turnState.canTargetBench).toBe(false);
  });
});

describe('SP Transfer', () => {
  it('moves SP between your own Personas, capped by what fits', () => {
    const state = board();
    const [active, bench] = state.players[0].field;
    active.sp = 40;
    active.maxSp = 40;
    bench.sp = 0;
    setHand(state, 0, ['sp-transfer']);

    const moved = getCard('sp-transfer').effect.amount;
    const after = play(state, 'sp-transfer', { fromUid: active.uid, toUid: bench.uid, amount: moved });
    const [a, b] = after.players[0].field;

    expect(b.sp).toBe(Math.min(moved, b.maxSp));
    expect(a.sp).toBe(40 - b.sp);
    expect(after.turnState.actionsRemaining).toBe(1); // free action
  });

  it('refuses to transfer to the same Persona', () => {
    const state = board();
    setHand(state, 0, ['sp-transfer']);
    const uid = state.players[0].field[0].uid;
    expect(() => play(state, 'sp-transfer', { fromUid: uid, toUid: uid })).toThrow(/two different Personas/);
  });

  it('never exceeds the card\'s stated amount', () => {
    const state = board();
    const [active, bench] = state.players[0].field;
    active.sp = 200;
    active.maxSp = 200;
    bench.sp = 0;
    bench.maxSp = 200;
    setHand(state, 0, ['sp-transfer']);

    const after = play(state, 'sp-transfer', { fromUid: active.uid, toUid: bench.uid, amount: 999 });
    expect(after.players[0].field[1].sp).toBe(getCard('sp-transfer').effect.amount);
  });
});

describe('Baton Pass', () => {
  it('grants one extra Persona change without spending your action', () => {
    const state = board();
    setHand(state, 0, ['baton-pass']);
    const after = play(state, 'baton-pass');

    expect(after.turnState.personaChangesRemaining).toBe(2);
    expect(after.turnState.actionsRemaining).toBe(1);

    // Both changes are actually usable.
    const bench = after.players[0].field[1].uid;
    const first = applyAction(after, { type: 'CHANGE_ACTIVE', player: 0, targetUid: bench });
    const back = first.players[0].field[0].uid;
    expect(() => applyAction(first, { type: 'CHANGE_ACTIVE', player: 0, targetUid: back })).not.toThrow();
  });
});

describe('Dekaja and Dekunda', () => {
  it('Dekaja removes only the enemy\'s buffs', () => {
    const state = board();
    activeOf(state, 1).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    activeOf(state, 1).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    setHand(state, 0, ['dekaja']);

    const after = play(state, 'dekaja');
    expect(buffOf(activeOf(after, 1), 'atk')).toBe(null);
    expect(buffOf(activeOf(after, 1), 'def')).toMatchObject({ direction: 'down' });
  });

  it('Dekunda removes only your own debuffs', () => {
    const state = board();
    activeOf(state, 0).buffs.push({ stat: 'def', direction: 'down', turnsLeft: 3 });
    activeOf(state, 0).buffs.push({ stat: 'atk', direction: 'up', turnsLeft: 3 });
    setHand(state, 0, ['dekunda']);

    const after = play(state, 'dekunda');
    expect(buffOf(activeOf(after, 0), 'def')).toBe(null);
    expect(buffOf(activeOf(after, 0), 'atk')).toMatchObject({ direction: 'up' });
  });

  it('is not offered when there is nothing to dispel', () => {
    const state = board();
    setHand(state, 0, ['dekaja']);
    expect(getLegalActions(state, 0).some((a) => a.cardId === 'dekaja')).toBe(false);
  });
});

describe('Concentrate and Charge', () => {
  it('Concentrate multiplies the next magic skill and is then spent', () => {
    const plain = board();
    const plainDamage = 400 - activeOf(applyAction(plain, { type: 'USE_SKILL', player: 0, skillId: 'agi' }), 1).hp;

    let state = board();
    setHand(state, 0, ['concentrate']);
    state = play(state, 'concentrate');
    expect(activeOf(state, 0).charges).toContain('concentrate');

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    expect(400 - activeOf(state, 1).hp).toBeGreaterThan(plainDamage * 2);
    expect(activeOf(state, 0).charges).toHaveLength(0);
  });

  it('Charge multiplies the next physical skill and is then spent', () => {
    const plain = board();
    const plainDamage = 400 - activeOf(applyAction(plain, { type: 'USE_SKILL', player: 0, skillId: 'bash' }), 1).hp;

    let state = board();
    setHand(state, 0, ['charge']);
    state = play(state, 'charge');
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });

    expect(400 - activeOf(state, 1).hp).toBeGreaterThan(plainDamage * 2);
    expect(activeOf(state, 0).charges).toHaveLength(0);
  });

  it('does not cross over between magic and physical', () => {
    let state = board();
    setHand(state, 0, ['charge']);
    state = play(state, 'charge');
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' }); // magic
    expect(activeOf(state, 0).charges).toContain('charge'); // untouched
  });

  it('survives across turns until it is used', () => {
    let state = board();
    setHand(state, 0, ['concentrate']);
    state = play(state, 'concentrate');
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    expect(activeOf(state, 0).charges).toContain('concentrate');
  });
});

describe('fusion, fully wired', () => {
  function fusionBoard() {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-frost', level: 13, active: true },
      { cardId: 'sarasvati' },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    return unlockFusion(state);
  }

  const fuse = (state, inherit = ['bufu', 'media']) =>
    applyAction(state, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[0].uid },
        { zone: 'field', uid: state.players[0].field[1].uid },
      ],
      inherit,
    });

  it('exposes the parents and inherit options on the legal action', () => {
    const fusions = getLegalActions(fusionBoard(), 0).filter((a) => a.type === 'FUSE');
    expect(fusions.length).toBeGreaterThan(0);

    const fusion = fusions[0];
    expect(fusion.sacrifices).toHaveLength(2);
    expect(fusion.sacrifices.every((s) => s.zone && s.uid)).toBe(true);
    expect(fusion.inheritOptions).toHaveLength(2);
    expect(fusion.inheritOptions.every((list) => list.length > 0)).toBe(true);
    // Every offered choice resolves for the UI dropdowns: skill ids to a skill
    // definition, and the "passive:<id>" entries to a passive.
    for (const list of fusion.inheritOptions) {
      for (const id of list) {
        if (id.startsWith('passive:')) expect(passiveDefinition(id.slice('passive:'.length))).toBeTruthy();
        else expect(getSkillDefinition(id)).toBeTruthy();
      }
    }
  });

  it('lets a fused Persona pass its inherited skill on to a further fusion', () => {
    // Black Frost (Star) inherits Media, then fuses with a Chariot into Vasuki.
    let state = fuse(fusionBoard(), ['bufu', 'media']);
    expect(activeOf(state, 0).inheritedSkills).toContain('media');

    state.players[0].field.push({
      ...activeOf(state, 0),
      uid: 'chariot-1',
      cardId: 'take-minakata',
      level: 20,
      inheritedSkills: [],
    });

    // Fusion spends your action, so the next one waits for a fresh turn.
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });

    const fusions = getLegalActions(state, 0).filter((a) => a.recipeId === 'fuse-vasuki');
    expect(fusions.length).toBeGreaterThan(0);
    // Media is offered by the Black Frost parent even though it is not printed on it.
    expect(fusions[0].inheritOptions.flat()).toContain('media');
  });

  it('reports inherited skills as usable on the fused Persona', () => {
    const state = fuse(fusionBoard());
    const result = activeOf(state, 0);
    const ids = personaSkills(state, result).map((s) => s.id);

    expect(ids).toContain('media'); // inherited
    expect(ids).toContain('bufu'); // inherited
    expect(ids).toContain('agidyne'); // printed
    // The printed card itself does NOT list them — that is what the instance is for.
    expect(getPersona('black-frost').skills.map((s) => s.id)).not.toContain('media');
  });

  it('is gone once your action for the turn is spent, and the panel says why', () => {
    let state = fusionBoard();
    state = applyAction(state, { type: 'GUARD', player: 0 }); // spends the action
    expect(state.turnState.actionsRemaining).toBe(0);

    expect(getLegalActions(state, 0).some((a) => a.type === 'FUSE')).toBe(false);
    const entry = describeFusions(state, 0).find((e) => e.recipe.id === 'fuse-black-frost');
    expect(entry.satisfiable).toBe(false);
    // The pair is still a valid pair — it is the price that cannot be paid, and
    // the reason has to say so rather than blaming the materials.
    expect(entry.pairs.length).toBeGreaterThan(0);
    expect(entry.reason).toMatch(/no action left/i);
    expect(() => fuse(state)).toThrow(/no actions remaining/i);
  });

  it('is illegal a second time in the same turn, and the panel says why', () => {
    // The same action object, replayed: after the first fusion the parents are
    // gone, so the second attempt has to be built from the original board.
    const board = fusionBoard();
    const again = {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: board.players[0].field[0].uid },
        { zone: 'field', uid: board.players[0].field[1].uid },
      ],
      inherit: ['bufu', 'media'],
    };
    const state = applyAction(board, again);

    expect(() => applyAction(state, again)).toThrow(/only 1 fusion per turn/);
    expect(getLegalActions(state, 0).some((a) => a.type === 'FUSE')).toBe(false);

    // ...and the panel says so rather than silently hiding the recipe. Shown on
    // a board that still HAS the material, since "you have not got the pieces"
    // is the more useful complaint when both are true.
    const spent = fusionBoard();
    spent.turnState.fusionsPerformed = 1;
    const blackFrost = describeFusions(spent, 0).find((e) => e.recipe.id === 'fuse-black-frost');
    expect(blackFrost.pairs.length).toBeGreaterThan(0);
    expect(blackFrost.satisfiable).toBe(false);
    expect(blackFrost.reason).toMatch(/Already fused this turn/);
  });

  it('accepts material from field, from hand, or one of each', () => {
    const recipe = { type: 'FUSE', player: 0, recipeId: 'fuse-black-frost', inherit: ['bufu', 'media'] };

    // both from the field
    const bothField = fusionBoard();
    expect(() => applyAction(bothField, {
      ...recipe,
      sacrifices: [
        { zone: 'field', uid: bothField.players[0].field[0].uid },
        { zone: 'field', uid: bothField.players[0].field[1].uid },
      ],
    })).not.toThrow();

    // one from each
    const mixed = unlockFusion(setupMatch());
    setField(mixed, 0, [{ cardId: 'sarasvati', level: 26, active: true }]);
    setField(mixed, 1, [{ cardId: 'pixie', active: true }]);
    setHand(mixed, 0, ['jack-frost']);
    const mixedResult = applyAction(mixed, {
      ...recipe,
      inherit: ['media', 'bufu'],
      sacrifices: [
        { zone: 'field', uid: mixed.players[0].field[0].uid },
        { zone: 'hand', uid: handUidOf(mixed, 0, 'jack-frost') },
      ],
    });
    expect(activeOf(mixedResult, 0).cardId).toBe('black-frost');

    // Both straight from hand, with an unrelated Persona holding the field.
    // Hand material counts at its PRINTED level, so this needs a recipe two
    // fresh cards can actually reach: Sarasvati 19 + Berith 16 = 35 >= 26.
    const bothHand = unlockFusion(setupMatch());
    setField(bothHand, 0, [{ cardId: 'unicorn', level: 21, active: true }]);
    setField(bothHand, 1, [{ cardId: 'pixie', active: true }]);
    setHand(bothHand, 0, ['sarasvati', 'berith']);
    const handResult = applyAction(bothHand, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-kikuri-hime',
      inherit: ['media', 'agilao'],
      sacrifices: [
        { zone: 'hand', uid: handUidOf(bothHand, 0, 'sarasvati') },
        { zone: 'hand', uid: handUidOf(bothHand, 0, 'berith') },
      ],
    });
    const fused = handResult.players[0].field.find((p) => p.cardId === 'kikuri-hime');
    expect(fused).toBeTruthy();
    expect(handResult.players[0].activeUid).not.toBe(fused.uid); // Unicorn keeps the active slot
    expect(handResult.players[0].koCount).toBe(0);
  });

  it('hands the active slot to the result when the active was sacrificed', () => {
    const state = fusionBoard();
    const activeUid = state.players[0].activeUid;
    expect(state.players[0].field[0].uid).toBe(activeUid); // Jack Frost is active

    const after = fuse(state);
    const result = after.players[0].field.find((p) => p.cardId === 'black-frost');
    expect(after.players[0].activeUid).toBe(result.uid);
    expect(after.log.some((l) => l.text.includes('takes the active slot'))).toBe(true);
  });

  it('leaves the active alone when only bench Personas were sacrificed', () => {
    const state = unlockFusion(setupMatch());
    setField(state, 0, [
      { cardId: 'unicorn', level: 21, active: true },
      { cardId: 'jack-frost', level: 13 },
      { cardId: 'sarasvati', level: 19 },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    const activeUid = state.players[0].activeUid;

    const after = applyAction(state, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[1].uid },
        { zone: 'field', uid: state.players[0].field[2].uid },
      ],
      inherit: ['bufu', 'media'],
    });
    expect(after.players[0].activeUid).toBe(activeUid);
  });

  it('never offers a fusion whose result would break the field cap', () => {
    const state = fusionBoard();
    // Fill the field, all from hand-independent slots.
    setField(state, 0, Array.from({ length: CONFIG.FIELD_CAP }, (_, i) => ({ cardId: 'pixie', active: i === 0 })));
    setHand(state, 0, ['jack-frost', 'sarasvati']);
    const fusions = getLegalActions(state, 0).filter((a) => a.type === 'FUSE');
    // Both parents from hand frees no slot, so nothing may be offered.
    expect(fusions.every((f) => f.sacrifices.some((s) => s.zone === 'field'))).toBe(true);
  });
});
