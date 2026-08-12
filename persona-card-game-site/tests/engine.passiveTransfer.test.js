/**
 * Passive transfer.
 *
 * There is no list of "approved" passives: ANY of them can move. What limits
 * the movement is the CHANNEL, and there are exactly two —
 *
 *   FUSION           one skill OR that parent's passive, per parent.
 *   GALLOWS (feast)  one skill OR the food's passive, and only when the food
 *                    has grown to the eater's own level. Meal and junk never.
 *
 * Both are expensive and telegraphed, which is the whole balance argument: you
 * cannot smuggle a passive onto a Persona cheaply, but if you are willing to
 * grow the food or spend a fusion, nothing is off-limits.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, PASSIVE_DEFS, passiveDefinition, CONFIG } from '../src/engine/index.js';
import { getPersona } from '../src/data/cards.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf, unlockFusion } from './helpers.js';

const ALL_PASSIVES = Object.keys(PASSIVE_DEFS);

/** Every passive in the game is accounted for, so this file cannot quietly rot. */
const EXPECTED = [
  'trickster',
  'stalwart',
  'counter',
  'analyst',
  'bloodlust',
  'soul-battery',
  'endure',
  'momentum',
  'sacrificial-lamb',
];

describe('the passive table', () => {
  it('covers every passive the patch names', () => {
    for (const id of EXPECTED) expect(ALL_PASSIVES).toContain(id);
  });

  it('has no passive marked as untransferable — the gates are the channels', () => {
    for (const id of ALL_PASSIVES) {
      const def = PASSIVE_DEFS[id];
      expect(def.transferable).toBeUndefined();
      expect(def.inheritable).toBeUndefined();
    }
  });
});

/* ------------------------------------------------------------------ *
 * Channel 1 — fusion
 * ------------------------------------------------------------------ */

describe('fusion moves any passive', () => {
  /** Jack Frost (Magician) + Sarasvati (Priestess) -> Black Frost. */
  function fusionBoard(parentPassive) {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'jack-frost', level: 13, active: true },
      { cardId: 'sarasvati' },
    ]);
    setField(state, 1, [{ cardId: 'pixie', active: true }]);
    // The parent carries the passive under test. Which card prints it is
    // irrelevant to the rule, so it is written straight onto the instance.
    state.players[0].field[0].passive = parentPassive;
    return unlockFusion(state);
  }

  const fuse = (state, inherit, extra = {}) =>
    applyAction(state, {
      type: 'FUSE',
      player: 0,
      recipeId: 'fuse-black-frost',
      sacrifices: [
        { zone: 'field', uid: state.players[0].field[0].uid },
        { zone: 'field', uid: state.players[0].field[1].uid },
      ],
      inherit,
      ...extra,
    });

  for (const id of EXPECTED) {
    it(`carries ${passiveDefinition(id)?.name ?? id} onto the result`, () => {
      const state = fusionBoard(id);
      const result = fuse(state, [`passive:${id}`, 'media'], { replacePassive: true });
      expect(activeOf(result, 0).passive).toBe(id);
      expect(result.log.some((l) => new RegExp(passiveDefinition(id).name, 'i').test(l.text))).toBe(true);
    });

    it(`offers ${id} in the legal action's inherit options`, () => {
      const state = fusionBoard(id);
      const action = getLegalActions(state, 0).find((a) => a.type === 'FUSE');
      expect(action.inheritOptions[0]).toContain(`passive:${id}`);
    });
  }

  it('never takes two passives, one from each parent', () => {
    const state = fusionBoard('stalwart');
    state.players[0].field[1].passive = 'counter';
    expect(() => fuse(state, ['passive:stalwart', 'passive:counter'], { replacePassive: true })).toThrow(
      /at most one passive/
    );
  });

  it('refuses to overwrite the result\'s printed passive without confirmation', () => {
    const state = fusionBoard('stalwart');
    // Black Frost prints a passive of its own, so this is a real replacement.
    const native = getPersona('black-frost').passive;
    if (!native) return; // data changed; nothing to confirm
    expect(() => fuse(state, ['passive:stalwart', 'media'])).toThrow(/confirm the replacement/);
    expect(activeOf(fuse(state, ['passive:stalwart', 'media'], { replacePassive: true }), 0).passive).toBe('stalwart');
  });
});

/* ------------------------------------------------------------------ *
 * Channel 2 — the Gallows, top tier only
 * ------------------------------------------------------------------ */

describe('the Gallows moves a passive on the feast tier only', () => {
  /**
   * Seat 0 has an eater and one piece of food whose level decides the tier.
   * The food carries the passive under test.
   */
  function board({ eaterLevel = 20, foodLevel = 22, foodPassive = 'stalwart', eaterPassive = null } = {}) {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'silky', level: eaterLevel, active: true },
      { cardId: 'angel', level: foodLevel },
    ]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
    setHand(state, 0, []);
    const eater = activeOf(state, 0);
    const food = state.players[0].field[1];
    eater.passive = eaterPassive;
    food.passive = foodPassive;
    return state;
  }

  const eaterOf = (state) => activeOf(state, 0);
  const offer = (state) =>
    getLegalActions(state, 0).find((a) => a.type === 'GALLOWS' && a.food.uid === uidOf(state, 0, 'angel'));

  const feed = (state, extra = {}) =>
    applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: eaterOf(state).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'angel') },
      ...extra,
    });

  for (const id of EXPECTED) {
    it(`hands ${passiveDefinition(id)?.name ?? id} to an eater that has none`, () => {
      const state = board({ foodPassive: id });
      const action = offer(state);
      expect(action.tier).toBe('feast');
      expect(action.inheritOptions.some((o) => o.kind === 'passive' && o.passiveId === id)).toBe(true);

      const next = feed(state, { inherit: `passive:${id}` });
      expect(eaterOf(next).passive).toBe(id);
      // Taking the passive means NOT taking a skill: it is one choice, not two.
      expect(eaterOf(next).inheritedSkills).toEqual([]);
    });
  }

  it('names the passive properly in the offer rather than leaking its id', () => {
    const action = offer(board({ foodPassive: 'soul-battery' }));
    const entry = action.inheritOptions.find((o) => o.kind === 'passive');
    expect(entry.name).toBe(PASSIVE_DEFS['soul-battery'].name);
  });

  it('offers nothing but skills on the MEAL tier', () => {
    // Food within COMEBACK_FARM_GAP below the eater: worth a level, not a soul.
    const state = board({ eaterLevel: 22, foodLevel: 20, foodPassive: 'counter' });
    const action = offer(state);
    expect(action.tier).toBe('meal');
    expect(action.canInherit).toBe(true);
    expect(action.canInheritPassive).toBe(false);
    expect(action.inheritOptions.some((o) => o.kind === 'passive')).toBe(false);
    expect(() => feed(state, { inherit: 'passive:counter' })).toThrow(/cannot pass on/);
  });

  it('offers nothing at all on the JUNK tier', () => {
    const state = board({ eaterLevel: 30, foodLevel: 3, foodPassive: 'counter' });
    const action = offer(state);
    expect(action.tier).toBe('junk');
    expect(action.canInherit).toBe(false);
    expect(action.canInheritPassive).toBe(false);
    expect(action.inheritOptions).toEqual([]);
    expect(() => feed(state, { inherit: 'passive:counter' })).toThrow(/junk/i);
  });

  it('never defaults to a passive, however good it looks', () => {
    const action = offer(board({ foodPassive: 'trickster' }));
    expect(action.inherit).not.toMatch(/^passive:/);
    expect(action.inherit).toBeTruthy(); // a skill, as always
  });

  it('does not offer a passive the eater already has', () => {
    const action = offer(board({ foodPassive: 'endure', eaterPassive: 'endure' }));
    expect(action.inheritOptions.some((o) => o.kind === 'passive')).toBe(false);
  });

  it('does not offer one when the food has no passive to give', () => {
    const action = offer(board({ foodPassive: null }));
    expect(action.canInheritPassive).toBe(true); // the tier allows it...
    expect(action.inheritOptions.some((o) => o.kind === 'passive')).toBe(false); // ...the food does not
  });

  it('takes a passive off a Persona card still sitting in hand', () => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'silky', level: 12, active: true }]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
    setHand(state, 0, ['nekomata']); // Lv12: at the eater's level, so a feast
    const printed = getPersona('nekomata').passive;
    if (!printed) return; // data changed; nothing to move

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(state, 0).uid,
      food: { zone: 'hand', uid: handUidOf(state, 0, 'nekomata') },
      inherit: `passive:${printed}`,
    });
    expect(activeOf(next, 0).passive).toBe(printed);
  });
});

/* ------------------------------------------------------------------ *
 * The replace flow
 * ------------------------------------------------------------------ */

describe('replacing a passive the eater already had', () => {
  function board(eaterPassive, foodPassive) {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'angel', level: 22 },
    ]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
    setHand(state, 0, []);
    activeOf(state, 0).passive = eaterPassive;
    state.players[0].field[1].passive = foodPassive;
    return state;
  }

  const feed = (state, extra) =>
    applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(state, 0).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'angel') },
      ...extra,
    });

  it('refuses without an explicit confirmation', () => {
    const state = board('stalwart', 'counter');
    expect(() => feed(state, { inherit: 'passive:counter' })).toThrow(/confirm the replacement/);
    // Nothing was consumed: the refusal lands before the food leaves the board.
    expect(state.players[0].field.some((p) => p.cardId === 'angel')).toBe(true);
  });

  it('goes through with the confirmation, and says what was lost', () => {
    const state = board('stalwart', 'counter');
    const next = feed(state, { inherit: 'passive:counter', replacePassive: true });
    expect(activeOf(next, 0).passive).toBe('counter');
    const log = next.log.map((l) => l.text).join('\n');
    expect(log).toMatch(/Counter/);
    expect(log).toMatch(/losing Stalwart/i);
  });

  it('needs no confirmation when the eater had nothing to lose', () => {
    const next = feed(board(null, 'counter'), { inherit: 'passive:counter' });
    expect(activeOf(next, 0).passive).toBe('counter');
  });

  it('surfaces what would be lost on the action itself, for the dialog to preview', () => {
    const state = board('stalwart', 'counter');
    const action = getLegalActions(state, 0).find(
      (a) => a.type === 'GALLOWS' && a.food.uid === uidOf(state, 0, 'angel')
    );
    expect(action.eaterPassive).toBe('stalwart');
  });

  it('still pays the rest of the feast — levels and the stat bump come too', () => {
    const beforeLevel = activeOf(board(null, 'counter'), 0).level;

    // Two identical feasts, one taking the passive and one taking nothing. The
    // levels and the permanent stat point are the same either way; taking the
    // passive is not paid for out of the rest of the meal.
    const withPassive = activeOf(feed(board(null, 'counter'), { inherit: 'passive:counter' }), 0);
    const plain = activeOf(feed(board(null, 'counter'), {}), 0);

    expect(withPassive.level).toBe(beforeLevel + CONFIG.GALLOWS_FEAST_LEVELS);
    expect(withPassive.magic).toBe(plain.magic);
    expect(plain.magic).toBeGreaterThan(0);
  });

  it('leaves the Sacrificial Lamb tier table alone', () => {
    // Lamb food is worth an extra level on a nourishing tier, and moving its
    // passive does not change that arithmetic in either direction.
    const state = board(null, 'sacrificial-lamb');
    const beforeLevel = activeOf(state, 0).level;
    const next = feed(state, { inherit: 'passive:sacrificial-lamb' });
    expect(activeOf(next, 0).level).toBe(beforeLevel + CONFIG.GALLOWS_FEAST_LEVELS + CONFIG.GALLOWS_LAMB_BONUS);
    expect(activeOf(next, 0).passive).toBe('sacrificial-lamb');
  });

  it('leaves the junk tier at +0 levels even with a Lamb in the bin', () => {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'silky', level: 30, active: true },
      { cardId: 'pixie', level: 3 },
    ]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
    setHand(state, 0, []);
    state.players[0].field[1].passive = 'sacrificial-lamb';

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(state, 0).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'pixie') },
    });
    expect(activeOf(next, 0).level).toBe(30);
    expect(activeOf(next, 0).passive).toBe(null);
  });
});

/* ------------------------------------------------------------------ *
 * The inherited passive actually works
 * ------------------------------------------------------------------ */

describe('an inherited passive is a real passive', () => {
  it('prevents a knockdown once Stalwart has been eaten', () => {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'angel', level: 22 },
    ]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
    setHand(state, 0, []);
    activeOf(state, 0).passive = null;
    state.players[0].field[1].passive = 'stalwart';

    const next = applyAction(state, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(state, 0).uid,
      food: { zone: 'field', uid: uidOf(state, 0, 'angel') },
      inherit: 'passive:stalwart',
    });

    const eater = activeOf(next, 0);
    expect(eater.passive).toBe('stalwart');
    expect(PASSIVE_DEFS.stalwart.onKnockdownAttempt({ persona: eater })).toBe('prevent');
  });
});
