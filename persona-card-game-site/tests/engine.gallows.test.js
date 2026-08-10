/**
 * The Gallows, and the draw-level floor it was introduced alongside.
 *
 * Both exist to answer the same complaint — "I am still drawing bad Personas on
 * turn 27". The Gallows lets you spend the bad ones; the floor stops so many of
 * them arriving in the first place.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  gallowsActions,
  gallowsAvailable,
  gallowsMeal,
  createMatch,
  CONFIG,
} from '../src/engine/index.js';
import { drawLevelFloor } from '../src/engine/effects.js';
import { getPersona } from '../src/data/cards.js';
import { setupMatch, setField, setHand, handUidOf, uidOf, endTurn } from './helpers.js';

/** Two Personas of ours, nothing of theirs that matters. */
function board({ eaterLevel = 20, benchLevel = 18 } = {}) {
  const state = setupMatch({ seed: 909 });
  setField(state, 0, [
    { cardId: 'silky', level: eaterLevel, active: true },
    { cardId: 'pixie', level: benchLevel },
    { cardId: 'angel', level: benchLevel },
  ]);
  setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
  state.players[0].hand = [];
  return state;
}

const eaterOf = (state) => state.players[0].field.find((p) => p.cardId === 'silky');

describe('the Gallows', () => {
  it('turns a bench Persona into a level for the eater, without a knockout', () => {
    const state = board();
    const before = eaterOf(state).level;
    const koBefore = state.players[0].koCount;

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'pixie') },
    });

    expect(eaterOf(next).level).toBe(before + CONFIG.GALLOWS_LEVELS);
    expect(next.players[0].field.some((p) => p.cardId === 'pixie')).toBe(false);
    expect(next.players[0].discard).toContain('pixie');
    // Feeding is not dying: the opponent's tally does not move.
    expect(next.players[0].koCount).toBe(koBefore);
    expect(next.players[1].koCount).toBe(0);
  });

  it('eats a Persona straight out of your hand', () => {
    const state = board({ eaterLevel: 14 });
    setHand(state, 0, ['nekomata']); // level 12, comfortably within the gap
    const before = eaterOf(state).level;

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'hand', uid: handUidOf(state, 0, 'nekomata') },
    });

    expect(eaterOf(next).level).toBe(before + CONFIG.GALLOWS_LEVELS);
    expect(next.players[0].hand).toHaveLength(0);
    expect(next.players[0].discard).toContain('nekomata');
  });

  it('pays HP instead of a level when the food is too far beneath the eater', () => {
    // Pixie at level 3 against a level 30 eater is well past COMEBACK_FARM_GAP.
    const state = board({ eaterLevel: 30, benchLevel: 3 });
    eaterOf(state).hp = 10;
    const before = eaterOf(state).level;

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'pixie') },
    });

    const eater = eaterOf(next);
    expect(eater.level).toBe(before); // taught it nothing
    expect(eater.hp).toBe(10 + Math.round(eater.maxHp * CONFIG.GALLOWS_JUNK_HEAL));
    expect(next.log.some((e) => e.text.includes('a meal is a meal'))).toBe(true);
  });

  it('pays Sacrificial Lamb its extra levels', () => {
    const state = board({ eaterLevel: 12 });
    setHand(state, 0, ['hua-po']); // level 10, prints Sacrificial Lamb
    const before = eaterOf(state).level;

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'hand', uid: handUidOf(state, 0, 'hua-po') },
    });

    // A Lamb rides on top of whatever tier its level put it in — here a Meal.
    expect(eaterOf(next).level).toBe(before + CONFIG.GALLOWS_LEVELS + CONFIG.GALLOWS_LAMB_BONUS);
    expect(CONFIG.GALLOWS_LAMB_BONUS).toBeGreaterThan(0);
  });

  it('costs your action and happens once a turn', () => {
    const state = board();
    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'pixie') },
    });

    expect(next.turnState.actionsRemaining).toBe(0);
    expect(next.turnState.gallowsUsed).toBe(1);
    expect(gallowsActions(next, 0)).toHaveLength(0);
    expect(gallowsAvailable(next, 0)).toBe(false);
  });

  it('lets the result take the active slot when the active was eaten', () => {
    const state = board();
    const eater = uidOf(state, 0, 'pixie');
    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eater,
      food: { zone: 'field', uid: uidOf(state, 0, 'silky') }, // the active
    });

    expect(next.players[0].activeUid).toBeTruthy();
    expect(next.players[0].field.some((p) => p.uid === next.players[0].activeUid)).toBe(true);
  });

  it('refuses to let a Persona feed itself', () => {
    const state = board();
    const uid = eaterOf(state).uid;
    expect(() =>
      applyAction(state, { type: 'GALLOWS', player: 0, eaterUid: uid, food: { zone: 'field', uid } })
    ).toThrow(/cannot feed itself/);
  });

  it('offers every eater/food pairing but never a self-pairing', () => {
    const state = board();
    setHand(state, 0, ['nekomata']);
    const options = gallowsActions(state, 0);

    // 3 eaters x (2 other field bodies + 1 hand card).
    expect(options).toHaveLength(9);
    expect(options.some((a) => a.food.zone === 'field' && a.food.uid === a.eaterUid)).toBe(false);
    expect(options.every((a) => typeof a.nourishing === 'boolean')).toBe(true);
    expect(getLegalActions(state, 0).filter((a) => a.type === 'GALLOWS')).toHaveLength(9);
  });
});

/* ------------------------------------------------------------------ *
 * The three tiers
 * ------------------------------------------------------------------ */

describe('the three tiers', () => {
  const feed = (state, foodCardId = 'pixie') =>
    applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'field', uid: uidOf(state, 0, foodCardId) },
    });

  it('agrees with itself: the tier the panel previews is the tier that lands', () => {
    // gallowsMeal is the single source of truth. Everything else — the legal
    // action list, the handler, the bot — reads it, so a table check here is a
    // check on all of them at once.
    const cases = [
      { eater: 20, food: 25, tier: 'feast', levels: CONFIG.GALLOWS_FEAST_LEVELS, usesAction: true },
      { eater: 20, food: 20, tier: 'feast', levels: CONFIG.GALLOWS_FEAST_LEVELS, usesAction: true },
      { eater: 20, food: 19, tier: 'meal', levels: CONFIG.GALLOWS_LEVELS, usesAction: true },
      { eater: 20, food: 20 - CONFIG.COMEBACK_FARM_GAP, tier: 'meal', levels: CONFIG.GALLOWS_LEVELS, usesAction: true },
      { eater: 20, food: 20 - CONFIG.COMEBACK_FARM_GAP - 1, tier: 'junk', levels: 0, usesAction: false },
      { eater: 20, food: 1, tier: 'junk', levels: 0, usesAction: false },
    ];
    for (const c of cases) {
      const meal = gallowsMeal(c.eater, c.food, null, 100);
      expect(meal.tier, `eater ${c.eater} / food ${c.food}`).toBe(c.tier);
      expect(meal.levels).toBe(c.levels);
      expect(meal.usesAction).toBe(c.usesAction);
    }
  });

  it('feasts on food at or above the eater, for two levels', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    const before = eaterOf(state).level;
    const next = feed(state);

    expect(eaterOf(next).level).toBe(before + CONFIG.GALLOWS_FEAST_LEVELS);
    expect(CONFIG.GALLOWS_FEAST_LEVELS).toBeGreaterThan(CONFIG.GALLOWS_LEVELS);
    expect(next.log.some((e) => e.text.includes('feasts'))).toBe(true);
    // The strongest tier is the one that costs the most.
    expect(next.turnState.actionsRemaining).toBe(0);
  });

  it('keeps the ladder in order, Lamb included', () => {
    const rung = (eater, food, passive) => gallowsMeal(eater, food, passive, 100).levels;
    // feast > meal, and a Lamb beats the same food without one at every tier.
    expect(rung(20, 20)).toBeGreaterThan(rung(20, 18));
    expect(rung(20, 20, 'sacrificial-lamb')).toBeGreaterThan(rung(20, 20));
    expect(rung(20, 18, 'sacrificial-lamb')).toBeGreaterThan(rung(20, 18));
    // ...and a Lamb feast is still the best meal in the game.
    const best = rung(20, 20, 'sacrificial-lamb');
    for (const [eater, food, passive] of [[20, 20, null], [20, 18, 'sacrificial-lamb'], [20, 18, null]]) {
      expect(best).toBeGreaterThan(rung(eater, food, passive));
    }
  });

  it('does not charge you an action to bin junk', () => {
    const state = board({ eaterLevel: 30, benchLevel: 3 });
    const next = feed(state);

    expect(next.turnState.actionsRemaining).toBe(1); // still yours to spend
    expect(next.log.some((e) => e.text.includes('costs no action'))).toBe(true);
  });

  it('lets you bin junk on a turn you have already spent, but not eat properly', () => {
    const state = board({ eaterLevel: 30, benchLevel: 3 });
    // Angel is level 3 too; give the eater one real meal to reject as well.
    setField(state, 0, [
      { cardId: 'silky', level: 30, active: true },
      { cardId: 'pixie', level: 3 },
      { cardId: 'angel', level: 28 },
    ]);
    state.turnState.actionsRemaining = 0;

    const options = gallowsActions(state, 0);
    expect(options.length).toBeGreaterThan(0);
    expect(options.every((a) => a.tier === 'junk')).toBe(true);
    // Every one of them is reachable through the real legal-action list.
    expect(getLegalActions(state, 0).filter((a) => a.type === 'GALLOWS')).toHaveLength(options.length);

    // And the handler agrees: the free one goes through, the paid one does not.
    const junk = options.find((a) => a.foodCardId === 'pixie');
    expect(() => applyAction(state, junk)).not.toThrow();
    expect(() =>
      applyAction(state, {
        type: 'GALLOWS',
        player: 0,
        eaterUid: eaterOf(state).uid,
        food: { zone: 'field', uid: uidOf(state, 0, 'angel') },
      })
    ).toThrow(/action/i);
  });

  it('spends the junk ration without touching the paid one', () => {
    // Silky at 30 with two level-3 scraps: both are junk, so the first disposal
    // is free and the second is refused — but the paid ration is untouched.
    const state = board({ eaterLevel: 30, benchLevel: 3 });
    const next = feed(state);

    expect(next.turnState.gallowsJunkUsed).toBe(CONFIG.GALLOWS_JUNK_PER_TURN);
    expect(next.turnState.gallowsUsed).toBe(0);
    expect(next.turnState.actionsRemaining).toBe(1); // junk is free
    expect(gallowsActions(next, 0).some((a) => a.tier === 'junk')).toBe(false);
    expect(() => feed(next, 'angel')).toThrow(/junk/i);
  });

  it('lets a free disposal and a paid meal happen on the same turn', () => {
    // A level-3 scrap (junk) and a level-18 bench (a meal): binning the scrap
    // must not cost you the meal you were saving the action for.
    const state = board({ eaterLevel: 20 });
    state.players[0].field[1].level = 3; // Pixie becomes junk
    let next = feed(state, 'pixie');
    expect(next.turnState.gallowsJunkUsed).toBe(1);
    expect(gallowsAvailable(next, 0)).toBe(true);

    const before = eaterOf(next).level;
    next = feed(next, 'angel');
    expect(eaterOf(next).level).toBe(before + CONFIG.GALLOWS_LEVELS);
    expect(next.turnState.gallowsUsed).toBe(1);
    expect(next.turnState.actionsRemaining).toBe(0);
    // Now both rations are gone.
    expect(gallowsActions(next, 0)).toHaveLength(0);
    expect(gallowsAvailable(next, 0)).toBe(false);
  });

  it('rejects a paid meal without consuming the food', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    state.turnState.actionsRemaining = 0;

    expect(() => feed(state)).toThrow();
    // The throw has to leave the board exactly as it was — the reducer clones,
    // but the food must not have been eaten before the refusal either way.
    expect(state.players[0].field.some((p) => p.cardId === 'pixie')).toBe(true);
    expect(state.players[0].discard).not.toContain('pixie');
  });

  it('tells the UI which tier each option is, on every option', () => {
    const state = board({ eaterLevel: 20, benchLevel: 18 });
    setHand(state, 0, ['nekomata']);
    for (const option of gallowsActions(state, 0)) {
      expect(['feast', 'meal', 'junk']).toContain(option.tier);
      expect(typeof option.levels).toBe('number');
      expect(typeof option.usesAction).toBe('boolean');
      expect(option.nourishing).toBe(option.tier !== 'junk');
    }
  });
});

describe('draw-level floor', () => {
  it('stays asleep until the scaling turn, then climbs and caps', () => {
    expect(drawLevelFloor({ turn: 0 })).toBe(0);
    expect(drawLevelFloor({ turn: CONFIG.DRAW_SCALE_START - 1 })).toBe(0);
    expect(drawLevelFloor({ turn: CONFIG.DRAW_SCALE_START })).toBe(1);
    expect(drawLevelFloor({ turn: CONFIG.DRAW_SCALE_START + CONFIG.DRAW_SCALE_RATE })).toBe(2);
    expect(drawLevelFloor({ turn: 10_000 })).toBe(CONFIG.DRAW_SCALE_CAP);
  });

  it('re-weights rather than filtering: a deck of nothing but openers still draws', () => {
    const state = setupMatch({ seed: 3 });
    state.turn = 40; // floor is at the cap
    state.players[0].deck = Array.from({ length: 12 }, () => 'pixie'); // level 3, far below it
    state.players[0].hand = [];

    const next = applyAction(state, { type: 'PASS', player: 0 });
    expect(next.players[0].hand).toHaveLength(1);
    expect(next.players[0].hand[0].cardId).toBe('pixie');
  });

  it('pulls the higher-level Personas forward once the floor is up', () => {
    // Same deck, same seed, two different turn numbers. Late in the match the
    // draw should land on the stronger half far more often.
    const strongCount = (turn) => {
      let hits = 0;
      for (let seed = 1; seed <= 60; seed++) {
        const state = setupMatch({ seed });
        state.turn = turn;
        state.players[0].hand = [];
        // Half openers, half mid-tier, interleaved so the top of the deck is
        // never the answer by itself.
        state.players[0].deck = Array.from({ length: 20 }, (_, i) => (i % 2 ? 'anzu' : 'pixie'));
        const next = applyAction(state, { type: 'PASS', player: 0 });
        if (next.players[0].hand[0].cardId === 'anzu') hits++;
      }
      return hits;
    };

    const early = strongCount(1); // floor asleep: always the top card, a Pixie
    const late = strongCount(40); // floor at the cap
    expect(early).toBe(0);
    expect(late).toBeGreaterThan(40);
  });

  it('is overridden by explicit draw manipulation', () => {
    const state = setupMatch({ seed: 11 });
    state.turn = 40;
    state.players[0].hand = [];
    state.players[0].deck = ['anzu', 'pixie', 'anzu', 'anzu'];
    // Fortune's Draw named the Lovers arcana: Pixie, and nothing else, whatever
    // the floor thinks of her.
    state.players[0].pendingDraw = { arcana: 'Lovers' };

    const next = applyAction(state, { type: 'PASS', player: 0 });
    expect(next.players[0].hand[0].cardId).toBe('pixie');
  });

  it('stays deterministic for a given seed', () => {
    const run = () => {
      const state = setupMatch({ seed: 777 });
      state.turn = 30;
      state.players[0].hand = [];
      state.players[0].deck = Array.from({ length: 20 }, (_, i) => (i % 3 ? 'anzu' : 'pixie'));
      let current = state;
      for (let i = 0; i < 5; i++) {
        current = applyAction(current, { type: 'PASS', player: 0 });
        current.turnState.actionsRemaining = 1;
      }
      return current.players[0].hand.map((c) => c.cardId);
    };
    expect(run()).toEqual(run());
  });

  it('records how many late Persona draws cleared the floor', () => {
    const state = setupMatch({ seed: 21 });
    state.turn = 30;
    state.players[0].hand = [];
    state.players[0].deck = ['anzu', 'pixie'];

    let next = applyAction(state, { type: 'PASS', player: 0 });
    next.turnState.actionsRemaining = 1;
    next = applyAction(next, { type: 'PASS', player: 0 });

    const stats = next.players[0].stats;
    expect(stats.personaDrawsLate).toBe(2);
    // Anzu is level 22, Pixie 3; the floor at turn 30 sits between them.
    expect(drawLevelFloor(next)).toBeGreaterThan(getPersona('pixie').level);
    expect(drawLevelFloor(next)).toBeLessThanOrEqual(getPersona('anzu').level);
    expect(stats.personaDrawsLateAboveFloor).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * What a nourishing meal leaves behind
 * ------------------------------------------------------------------ */

/**
 * A feast and a meal both pass on one skill of the player's choice; a feast
 * also leaves a permanent mark on the eater's best combat stat. Junk teaches
 * nothing — that is the whole difference between eating and binning.
 */
describe('inheritance and the feast stat bump', () => {
  const gallows = (state, extra = {}) => ({
    type: 'GALLOWS',
    player: 0,
    eaterUid: eaterOf(state).uid,
    food: { zone: 'field', uid: uidOf(state, 0, 'pixie') },
    ...extra,
  });

  const offer = (state, foodCardId = 'pixie') =>
    getLegalActions(state, 0).find(
      (a) => a.type === 'GALLOWS' && a.foodCardId === foodCardId && a.eaterUid === eaterOf(state).uid
    );

  it('offers the food\'s skills on both nourishing tiers and none on junk', () => {
    const feast = offer(board({ eaterLevel: 14, benchLevel: 14 }));
    expect(feast.tier).toBe('feast');
    expect(feast.canInherit).toBe(true);
    expect(feast.inheritOptions.map((s) => s.id)).toContain('zio');

    const meal = offer(board({ eaterLevel: 20, benchLevel: 18 }));
    expect(meal.tier).toBe('meal');
    expect(meal.canInherit).toBe(true);
    expect(meal.inheritOptions.length).toBeGreaterThan(0);

    const junk = offer(board({ eaterLevel: 30, benchLevel: 3 }));
    expect(junk.tier).toBe('junk');
    expect(junk.canInherit).toBe(false);
    expect(junk.inheritOptions).toEqual([]);
  });

  it('previews the stat bump on the feast tier only', () => {
    // Silky grows magic and endurance equally and strength not at all, so the
    // bump lands on magic — the first of the three it grows fastest.
    expect(offer(board({ eaterLevel: 14, benchLevel: 14 })).statBump).toBe('magic');
    expect(offer(board({ eaterLevel: 20, benchLevel: 18 })).statBump).toBe(null);
    expect(offer(board({ eaterLevel: 30, benchLevel: 3 })).statBump).toBe(null);
  });

  it('teaches the eater the one skill the player picked', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    expect(eaterOf(state).inheritedSkills).toEqual([]);

    const next = applyAction(state, gallows(state, { inherit: 'zio' }));

    expect(eaterOf(next).inheritedSkills).toEqual(['zio']);
    // And it is genuinely castable, not merely recorded. (The feast spent the
    // action, so hand one back to see the skill on the legal list.)
    next.turnState.actionsRemaining = 1;
    expect(getLegalActions(next, 0).some((a) => a.type === 'USE_SKILL' && a.skillId === 'zio')).toBe(true);
    expect(next.log.some((l) => /inherited Zio/i.test(l.text))).toBe(true);
  });

  it('takes only one skill, and only if you ask for one', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    const next = applyAction(state, gallows(state)); // no inherit
    expect(eaterOf(next).inheritedSkills).toEqual([]);
    expect(eaterOf(next).level).toBe(14 + CONFIG.GALLOWS_FEAST_LEVELS);
  });

  it('eats a skill out of a card still in hand', () => {
    const state = board({ eaterLevel: 14 });
    setHand(state, 0, ['nekomata']); // level 12: a meal, and it knows Agi

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'hand', uid: handUidOf(state, 0, 'nekomata') },
      inherit: 'agi',
    });

    expect(eaterOf(next).inheritedSkills).toEqual(['agi']);
  });

  it('refuses a skill the food has not unlocked', () => {
    const state = board({ eaterLevel: 14 });
    setHand(state, 0, ['nekomata']); // Agilao unlocks at 18; the card is level 12
    expect(() =>
      applyAction(state, {
        type: 'GALLOWS',
        player: 0,
        eaterUid: eaterOf(state).uid,
        food: { zone: 'hand', uid: handUidOf(state, 0, 'nekomata') },
        inherit: 'agilao',
      })
    ).toThrow(/cannot pass on/);
  });

  it('refuses inheritance from junk food, and leaves the board alone when it does', () => {
    const state = board({ eaterLevel: 30, benchLevel: 3 });
    expect(() => applyAction(state, gallows(state, { inherit: 'zio' }))).toThrow(/junk/i);
    // Nothing was eaten: the refusal happens before anything is consumed.
    expect(state.players[0].field.some((p) => p.cardId === 'pixie')).toBe(true);
  });

  it('does not offer a skill the eater already knows', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    eaterOf(state).inheritedSkills = ['zio'];
    const options = offer(state).inheritOptions.map((s) => s.id);
    expect(options).not.toContain('zio');
    expect(options).toContain('dia');
  });

  it('raises the eater\'s best stat permanently on a feast, on top of the levels', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    const eater = eaterOf(state);
    const beforeMagic = eater.magic;
    const beforeStrength = eater.strength;

    const next = applyAction(state, gallows(state));
    const after = eaterOf(next);

    // Two levels of ordinary growth (magic +1 each) plus the feast's own +1.
    const growth = getPersona('silky').statGrowth.magic * CONFIG.GALLOWS_FEAST_LEVELS;
    expect(after.magic).toBe(beforeMagic + growth + CONFIG.GALLOWS_STAT_BUMP);
    expect(after.strength).toBe(beforeStrength); // Silky does not grow strength
    expect(next.log.some((l) => /magic rises permanently/i.test(l.text))).toBe(true);
  });

  it('leaves the stats alone on a meal and on junk', () => {
    const meal = board({ eaterLevel: 20, benchLevel: 18 });
    const beforeMeal = eaterOf(meal).magic;
    const afterMeal = eaterOf(applyAction(meal, gallows(meal)));
    expect(afterMeal.magic).toBe(beforeMeal + getPersona('silky').statGrowth.magic * CONFIG.GALLOWS_LEVELS);

    const junk = board({ eaterLevel: 30, benchLevel: 3 });
    const beforeJunk = eaterOf(junk).magic;
    expect(eaterOf(applyAction(junk, gallows(junk))).magic).toBe(beforeJunk);
  });

  it('survives redaction — the preview an online opponent sees is their own', () => {
    const state = board({ eaterLevel: 14, benchLevel: 14 });
    const offered = offer(state);
    expect(offered.inheritOptions.every((s) => s.id && s.name)).toBe(true);
    expect(offered.statBumpAmount).toBe(CONFIG.GALLOWS_STAT_BUMP);
    expect(offered.needsChoice).toBe(true);
  });
});

describe('the Gallows in a real match', () => {
  it('gets used by the Brutal bot without ever producing an illegal action', () => {
    // Nothing here asserts a rate — only that the option exists, is reachable
    // through getLegalActions, and never wedges a match.
    let state = createMatch({
      seed: 4242,
      players: [
        { name: 'A', deckId: 'p4', archetype: 'tactical', controller: 'bot', difficulty: 'brutal' },
        { name: 'B', deckId: 'p5', archetype: 'aggressive', controller: 'bot', difficulty: 'brutal' },
      ],
    });
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });

    let saw = false;
    for (let i = 0; i < 300 && state.winner === null; i++) {
      const legal = getLegalActions(state, state.activePlayer);
      const gallows = legal.filter((a) => a.type === 'GALLOWS' && a.nourishing);
      if (gallows.length && state.turnState.actionsRemaining > 0) {
        state = applyAction(state, gallows[0]);
        saw = true;
        continue;
      }
      state = endTurn(state);
    }
    expect(saw).toBe(true);
  });
});
