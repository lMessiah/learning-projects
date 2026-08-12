/**
 * What costs your action, and whether the game says so.
 *
 * There are two ways to get this wrong and they look identical from the player's
 * chair. The engine can charge inconsistently, or the engine can be consistent
 * while the UI promises a different price. The second is what actually happened:
 * the fusion confirm button read "Fuse — uses your action" long after fusion
 * stopped costing one, so whether fusing "took your turn" looked like a coin
 * flip. These tests pin both halves — the charge, and the claim about it.
 *
 * The rule the whole file rests on: `usesAction` is the ONE source of truth. On
 * an Item or Special it is printed on the card; on a Gallows meal the engine
 * puts it on the legal action; a fusion has no such flag because it is never an
 * action. Nothing in the UI may re-derive any of that for itself.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, CONFIG } from '../src/engine/index.js';
import { ITEMS, SPECIALS, getCard } from '../src/data/cards.js';
import { setupMatch, setField, setHand, handUidOf, uidOf, unlockFusion } from './helpers.js';

/**
 * What an action actually charged, in actions. A One More refunds the action in
 * the same breath as spending it, so the raw budget delta lies about attacks
 * that scored a knockdown; adding the grants back gives the price on the tin.
 */
function actionCostOf(before, action) {
  const after = applyAction(before, action);
  const granted = (after.turnState?.oneMoresGranted ?? 0) - (before.turnState?.oneMoresGranted ?? 0);
  return {
    cost: before.turnState.actionsRemaining - after.turnState.actionsRemaining + granted,
    after,
  };
}

/* ------------------------------------------------------------------ *
 * Fusion
 * ------------------------------------------------------------------ */

/** Jack Frost (Magician) + Apsaras (Priestess) at level 20 each -> Black Frost. */
function fusableBoard() {
  const state = setupMatch();
  setField(state, 0, [
    { cardId: 'jack-frost', active: true, level: 20 },
    { cardId: 'apsaras', level: 20 },
  ]);
  setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
  return unlockFusion(state);
}

const firstFusion = (state) => getLegalActions(state, 0).find((a) => a.type === 'FUSE');

describe('fusion charges the action, and every time', () => {
  it('charges exactly one action at a full budget', () => {
    const state = fusableBoard();
    const fuse = firstFusion(state);
    expect(fuse).toBeTruthy();
    expect(state.turnState.actionsRemaining).toBe(CONFIG.ACTIONS_PER_TURN);

    const { cost, after } = actionCostOf(state, fuse);

    expect(cost).toBe(1);
    expect(after.turnState.actionsRemaining).toBe(CONFIG.ACTIONS_PER_TURN - 1);
  });

  it('advertises that price on the legal action itself', () => {
    // The UI reads this rather than re-deriving the rule, which is what stops a
    // button from promising a price the engine does not charge.
    expect(firstFusion(fusableBoard()).usesAction).toBe(CONFIG.FUSION_USES_ACTION);
  });

  it('is not offered at all once the action is already spent', () => {
    let state = fusableBoard();
    state = applyAction(state, { type: 'GUARD', player: 0 });
    expect(state.turnState.actionsRemaining).toBe(0);

    expect(firstFusion(state)).toBeUndefined();
  });

  it('leaves you unable to attack afterwards', () => {
    let state = fusableBoard();
    state = applyAction(state, firstFusion(state));

    expect(state.turnState.actionsRemaining).toBe(0);
    expect(getLegalActions(state, 0).filter((a) => a.type === 'ATTACK')).toHaveLength(0);
  });

  it('is rationed per turn on top of the action, not merely by it', () => {
    let state = fusableBoard();
    // Enough material for a second fusion, and the action handed back, so the
    // ration is the only thing left that can stop it.
    setHand(state, 0, ['nekomata', 'sarasvati']);
    state = applyAction(state, firstFusion(state));
    state = { ...state, turnState: { ...state.turnState, actionsRemaining: 1 } };

    expect(state.turnState.fusionsPerformed).toBe(CONFIG.FUSIONS_PER_TURN);
    expect(getLegalActions(state, 0).some((a) => a.type === 'ATTACK')).toBe(true);
    expect(getLegalActions(state, 0).some((a) => a.type === 'FUSE')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Items and Specials
 * ------------------------------------------------------------------ */

/**
 * Every Item and Special prints `usesAction`. Card by card, the flag has to be
 * exactly what the engine charges — not "usually", and not "for the ones anyone
 * remembered to check".
 */
describe('a card charges exactly what it prints', () => {
  const playables = [...ITEMS, ...SPECIALS];

  it('covers both answers, so neither branch is untested by accident', () => {
    expect(playables.some((c) => c.usesAction)).toBe(true);
    expect(playables.some((c) => !c.usesAction)).toBe(true);
  });

  for (const card of playables) {
    it(`${card.name}: ${card.usesAction ? 'costs the action' : 'is free'}`, () => {
      // A generous board on both sides, so nearly every effect finds something
      // to do and the card is actually reachable as a legal action.
      const state = setupMatch();
      setField(state, 0, [
        { cardId: 'pixie', active: true, level: 20, hp: 40, sp: 10 },
        { cardId: 'jack-frost', level: 20, hp: 40, sp: 10 },
      ]);
      setField(state, 1, [
        { cardId: 'orpheus', active: true, hp: 900, maxHp: 900 },
        { cardId: 'apsaras', hp: 900, maxHp: 900 },
      ]);
      state.players[0].field[1].ko = true; // gives revive/recall something to reach
      setHand(state, 0, [card.id]);
      state.players[0].lastSkillId = 'zio'; // Wild Card needs something to copy

      const type = card.type === 'item' ? 'PLAY_ITEM' : 'PLAY_SPECIAL';
      const play = getLegalActions(state, 0).find((a) => a.type === type && a.cardId === card.id);
      if (!play) return; // this card has nothing to do on this board; not what is under test

      const { cost } = actionCostOf(state, play);
      expect(cost).toBe(card.usesAction ? 1 : 0);
    });
  }

  it('hides an action-costing card once the action is gone, and keeps the free ones', () => {
    let state = setupMatch();
    // Hurt, so Medicine has something to do and stays on the legal list.
    setField(state, 0, [{ cardId: 'pixie', active: true, level: 20, hp: 10, maxHp: 200 }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    setHand(state, 0, ['traesto', 'medicine']);

    const before = getLegalActions(state, 0);
    expect(before.some((a) => a.cardId === 'traesto')).toBe(true);
    expect(before.some((a) => a.cardId === 'medicine')).toBe(true);

    state = applyAction(state, { type: 'GUARD', player: 0 });

    const after = getLegalActions(state, 0);
    expect(after.some((a) => a.cardId === 'traesto')).toBe(false); // usesAction: true
    expect(after.some((a) => a.cardId === 'medicine')).toBe(true); // free
  });
});

/* ------------------------------------------------------------------ *
 * The Gallows
 * ------------------------------------------------------------------ */

/**
 * The Gallows is the one play whose price depends on what you feed it, which
 * makes it the easiest place to end up with a label that quietly disagrees with
 * the engine. The legal action carries `usesAction`; that flag is the contract.
 */
describe('the Gallows charges what its legal action says it charges', () => {
  /** A big eater and a chosen food level, so the tier is picked deliberately. */
  const board = (eaterLevel, foodLevel) => {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'pixie', active: true, level: eaterLevel },
      { cardId: 'jack-frost', level: foodLevel },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    return state;
  };

  const mealFor = (state, tier) =>
    getLegalActions(state, 0).find(
      (a) => a.type === 'GALLOWS' && a.tier === tier && a.food.uid === uidOf(state, 0, 'jack-frost')
    );

  for (const [tier, eaterLevel, foodLevel] of [
    ['feast', 20, 20],
    ['meal', 20, 17],
    ['junk', 30, 3],
  ]) {
    it(`${tier}: the charge matches usesAction`, () => {
      const state = board(eaterLevel, foodLevel);
      const action = mealFor(state, tier);
      expect(action).toBeTruthy();

      const { cost } = actionCostOf(state, action);
      expect(cost).toBe(action.usesAction ? 1 : 0);
    });
  }

  it('keeps the free junk tier available after the action is spent', () => {
    let state = board(30, 3);
    state = applyAction(state, { type: 'GUARD', player: 0 });
    expect(state.turnState.actionsRemaining).toBe(0);

    const junk = mealFor(state, 'junk');
    expect(junk).toBeTruthy();
    expect(junk.usesAction).toBe(false);
    expect(actionCostOf(state, junk).cost).toBe(0);
  });

  it('withdraws the paid tiers once the action is spent', () => {
    let state = board(20, 20);
    state = applyAction(state, { type: 'GUARD', player: 0 });

    const paid = getLegalActions(state, 0).filter((a) => a.type === 'GALLOWS' && a.usesAction);
    expect(paid).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ *
 * The rule, swept
 * ------------------------------------------------------------------ */

describe('no legal action charges an action it did not advertise', () => {
  /**
   * Which action types spend the turn's action, unconditionally. Everything not
   * listed either never charges (a free play) or carries its own `usesAction`.
   */
  const ALWAYS_CHARGE = new Set(['ATTACK', 'USE_SKILL', 'GUARD', 'PASS']);
  const NEVER_CHARGE = new Set(['PLAY_PERSONA', 'CHANGE_ACTIVE']);

  it('sweeps every legal action on a busy board', () => {
    const state = setupMatch();
    setField(state, 0, [
      { cardId: 'pixie', active: true, level: 20, hp: 40, sp: 10 },
      { cardId: 'jack-frost', level: 20, hp: 40 },
    ]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]);
    setHand(state, 0, ['pixie', 'jack-frost', 'medicine', 'traesto']);

    const legal = getLegalActions(state, 0).filter((a) => a.type !== 'RESIGN' && a.type !== 'END_TURN');
    expect(legal.length).toBeGreaterThan(5);

    for (const action of legal) {
      const { cost } = actionCostOf(state, action);

      let expected;
      if (ALWAYS_CHARGE.has(action.type)) expected = 1;
      else if (NEVER_CHARGE.has(action.type)) expected = 0;
      // FUSE and GALLOWS both carry their own price, for the same reason.
      else if (action.type === 'FUSE' || action.type === 'GALLOWS') expected = action.usesAction ? 1 : 0;
      else expected = getCard(action.cardId).usesAction ? 1 : 0;

      expect({ type: action.type, cardId: action.cardId ?? null, cost }).toEqual({
        type: action.type,
        cardId: action.cardId ?? null,
        cost: expected,
      });
    }
  });
});

// What the player is TOLD any of this costs is pinned separately, in
// tests/board.actionCost.test.js — that half needs a DOM.
