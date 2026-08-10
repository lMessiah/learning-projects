/**
 * One More.
 *
 * The rule in one sentence: knocking a STANDING enemy Persona down with a
 * weakness hit buys you one extra action, one extra Persona change, and the
 * right to aim that action anywhere on the enemy field. Baseline is one per
 * turn; Trickster lets knockdowns scored during a One More keep the chain up.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, CONFIG, passiveOf } from '../src/engine/index.js';
import { setupMatch, setField, setHand, activeOf, handUidOf } from './helpers.js';

const zio = (player = 0, targetUid) => ({ type: 'USE_SKILL', player, skillId: 'zio', targetUid });
const agi = (player = 0, targetUid) => ({ type: 'USE_SKILL', player, skillId: 'agi', targetUid });

/**
 * Pixie (Trickster, knows Zio) against two Personas that are weak to elec and
 * far too healthy to actually die from it — so every hit is a clean knockdown
 * test rather than a KO test.
 */
function elecChain({ attacker = 'pixie', hp = 900 } = {}) {
  const state = setupMatch();
  setField(state, 0, [{ cardId: attacker, active: true }]);
  setField(state, 1, [
    { cardId: 'apsaras', active: true, hp, maxHp: hp }, // weak: elec
    { cardId: 'sarasvati', hp, maxHp: hp }, // weak: elec
  ]);
  return state;
}

const benchUid = (state) => state.players[1].field[1].uid;

describe('what grants a One More', () => {
  it('grants one when a weakness hit knocks a standing Persona down', () => {
    let state = elecChain();
    expect(state.turnState.actionsRemaining).toBe(1);

    state = applyAction(state, zio());

    expect(activeOf(state, 1).knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(1);
    expect(state.turnState.actionsRemaining).toBe(1); // spent one, gained one
  });

  it('grants none when the target is already down', () => {
    let state = elecChain();
    state = applyAction(state, zio()); // knocks Apsaras down, One More #1
    expect(state.turnState.oneMoresGranted).toBe(1);

    // Pixie has Trickster, so the cap is not what stops a second One More here
    // — hitting a Persona that is already on its back simply isn't a knockdown.
    state = applyAction(state, zio(0, state.players[1].activeUid));

    expect(state.turnState.oneMoresGranted).toBe(1);
    expect(state.turnState.actionsRemaining).toBe(0);
  });

  it('grants none when a guard keeps the target on its feet', () => {
    let state = elecChain();
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'GUARD', player: 1 });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });

    state = applyAction(state, zio());

    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });

  it('grants none for a neutral hit', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'pixie', active: true }]);
    setField(state, 1, [{ cardId: 'orpheus', active: true, hp: 900, maxHp: 900 }]); // neutral to elec
    state = applyAction(state, zio());
    expect(state.turnState.oneMoresGranted).toBe(0);
    expect(state.turnState.actionsRemaining).toBe(0);
  });

  it('grants none for a killing blow — the reward for that is the level-up', () => {
    let state = elecChain({ hp: 1 });
    state = applyAction(state, zio());

    expect(state.players[1].field[0].ko).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });
});

describe('what a One More buys you', () => {
  it('adds an action and an extra Persona change (Baton Pass)', () => {
    // Agi carries no Alacrity, so the only extra swap here is the Baton Pass.
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'hua-po', active: true }]);
    setField(state, 1, [{ cardId: 'jack-frost', active: true, hp: 900, maxHp: 900 }]);
    expect(state.turnState.personaChangesRemaining).toBe(CONFIG.PERSONA_CHANGES_PER_TURN);

    state = applyAction(state, agi());

    expect(state.turnState.oneMoresGranted).toBe(1);
    expect(state.turnState.personaChangesRemaining).toBe(CONFIG.PERSONA_CHANGES_PER_TURN + 1);
    expect(state.log.some((l) => l.kind === 'onemore')).toBe(true);
  });

  it('opens the whole enemy field to the One More action — and only to it', () => {
    let state = elecChain();
    const bench = benchUid(state);

    // Before the knockdown, the bench is off limits.
    expect(() => applyAction(state, zio(0, bench))).toThrow(/active Persona/);
    expect(getLegalActions(state, 0).filter((a) => a.type === 'ATTACK')).toHaveLength(1);

    state = applyAction(state, zio());
    expect(state.turnState.oneMoreActive).toBe(true);

    // During the One More, both enemy Personas are targets.
    expect(getLegalActions(state, 0).filter((a) => a.type === 'ATTACK')).toHaveLength(2);

    const before = state.players[1].field[1].hp;
    state = applyAction(state, zio(0, bench));
    expect(state.players[1].field[1].hp).toBeLessThan(before);
  });

  it('knocks a benched Persona down, and it stands up on its owner\'s turn', () => {
    let state = elecChain();
    state = applyAction(state, zio()); // One More
    state = applyAction(state, zio(0, benchUid(state))); // hit the bench

    expect(state.players[1].field[1].knockedDown).toBe(true);

    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    expect(state.players[1].field[1].knockedDown).toBe(false); // no permanent bench-lock
  });

  it('closes the bench again as soon as the extra action is spent on anything', () => {
    let state = elecChain();
    state = applyAction(state, zio());
    expect(state.turnState.oneMoreActive).toBe(true);

    state = applyAction(state, { type: 'GUARD', player: 0 });

    expect(state.turnState.oneMoreActive).toBe(false);
    expect(state.turnState.actionsRemaining).toBe(0);
  });

  it('does not open the bench for a Persona without a One More', () => {
    const state = elecChain({ attacker: 'orpheus' });
    expect(state.turnState.oneMoreActive).toBe(false);
    expect(() => applyAction(state, { type: 'ATTACK', player: 0, targetUid: benchUid(state) })).toThrow(
      /active Persona/
    );
  });
});

describe('chaining', () => {
  it('does not chain without Trickster', () => {
    // Omoikane knows Zio and prints no passive. The One More it earns opens the
    // bench, so it gets a second clean knockdown — which must not pay out again.
    let state = elecChain({ attacker: 'omoikane' });
    expect(passiveOf(activeOf(state, 0))).toBe(null);

    state = applyAction(state, zio()); // knockdown -> One More #1
    expect(state.turnState.oneMoresGranted).toBe(1);

    state = applyAction(state, zio(0, benchUid(state))); // a second fresh knockdown
    expect(state.players[1].field[1].knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(CONFIG.MAX_ONE_MORE_PER_TURN);
    expect(state.turnState.actionsRemaining).toBe(0); // the turn is over
  });

  it('chains with Trickster: every fresh knockdown grants another One More', () => {
    let state = elecChain();
    expect(passiveOf(activeOf(state, 0))).toBe('trickster');

    state = applyAction(state, zio()); // knock the active down
    expect(state.turnState.oneMoresGranted).toBe(1);

    state = applyAction(state, zio(0, benchUid(state))); // knock the bench down
    expect(state.turnState.oneMoresGranted).toBe(2);
    expect(state.turnState.actionsRemaining).toBe(1); // still holding an action
    // Two Baton Passes, plus two Alacrity refunds — Zio carries the keyword.
    expect(state.turnState.personaChangesRemaining).toBe(CONFIG.PERSONA_CHANGES_PER_TURN + 4);
  });

  it('runs the chain dry once every enemy Persona is down', () => {
    let state = elecChain();
    state = applyAction(state, zio());
    state = applyAction(state, zio(0, benchUid(state)));
    expect(state.turnState.oneMoresGranted).toBe(2);

    // Nothing left standing to knock down, so the chain ends here.
    state = applyAction(state, zio(0, state.players[1].activeUid));
    expect(state.turnState.oneMoresGranted).toBe(2);
    expect(state.turnState.actionsRemaining).toBe(0);
  });

  it('keeps Ambush independent: it opens the bench without granting a One More', () => {
    let state = elecChain({ attacker: 'omoikane' });
    setHand(state, 0, ['ambush']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'ambush') });

    expect(state.turnState.canTargetBench).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(0);
    // The bench is reachable straight away, before anything has been knocked down.
    expect(() => applyAction(state, zio(0, benchUid(state)))).not.toThrow();
  });
});

/* ------------------------------------------------------------------ *
 * Prevention
 * ------------------------------------------------------------------ */

/**
 * A weakness hit and a knockdown are not the same event, and the difference
 * only shows when something stops the knockdown. Every prevention below must
 * cost the attacker the One More as well — the grant keys off the knockdown,
 * never off the weakness.
 */
describe('a prevented knockdown pays out nothing', () => {
  /** Zio into Ara Mitama (Stalwart, weak to elec) at a chosen HP fraction. */
  const stalwart = (hpFraction) => {
    const state = setupMatch();
    setField(state, 0, [{ cardId: 'omoikane', active: true }]); // knows Zio, no passive
    setField(state, 1, [{ cardId: 'ara-mitama', active: true, maxHp: 900, hp: Math.round(900 * hpFraction) }]);
    return state;
  };

  it('Stalwart above half HP: no knockdown, and no One More either', () => {
    let state = stalwart(0.9);
    expect(passiveOf(activeOf(state, 1))).toBe('stalwart');

    state = applyAction(state, zio());

    // The hit still landed and still read as a weakness — only the knockdown died.
    expect(activeOf(state, 1).hp).toBeLessThan(810);
    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
    expect(state.turnState.actionsRemaining).toBe(0);
    expect(state.log.some((l) => /Stalwart/.test(l.text))).toBe(true);
  });

  it('the same hit below half HP grants both', () => {
    let state = stalwart(0.3);
    state = applyAction(state, zio());

    expect(activeOf(state, 1).knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(1);
    expect(state.turnState.actionsRemaining).toBe(1);
  });

  it('Guard: no knockdown, no One More', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'omoikane', active: true }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp: 900, maxHp: 900 }]);
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, { type: 'GUARD', player: 1 });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });

    state = applyAction(state, zio());

    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });

  it('Moonless Gown: nothing reached it, so nothing is owed', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'omoikane', active: true }]);
    setField(state, 1, [{ cardId: 'apsaras', active: true, hp: 900, maxHp: 900 }]);
    setHand(state, 1, ['moonless-gown']);
    state = applyAction(state, { type: 'END_TURN', player: 0, discard: [] });
    state = applyAction(state, {
      type: 'PLAY_SPECIAL',
      player: 1,
      handUid: handUidOf(state, 1, 'moonless-gown'),
    });
    state = applyAction(state, { type: 'END_TURN', player: 1, discard: [] });
    expect(activeOf(state, 1).warded).toBe(true);

    state = applyAction(state, zio());

    expect(activeOf(state, 1).hp).toBe(900);
    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });

  it('a Shock Technical is held to the same gate', () => {
    // Shock + a physical hit is a Technical knockdown, which is a separate
    // route into the same event — and Stalwart closes it just as firmly.
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'ara-mitama', active: true }]); // knows Bash (phys)
    setField(state, 1, [{ cardId: 'ara-mitama', active: true, maxHp: 900, hp: 810 }]);
    state.players[1].field[0].ailments = [{ type: 'shock', turnsLeft: 3 }];

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });

    expect(state.log.some((l) => l.kind === 'technical')).toBe(true);
    expect(activeOf(state, 1).knockedDown).toBe(false);
    expect(state.turnState.oneMoresGranted).toBe(0);
  });

  it('the same Technical below half HP does grant one', () => {
    let state = setupMatch();
    setField(state, 0, [{ cardId: 'ara-mitama', active: true }]);
    setField(state, 1, [{ cardId: 'ara-mitama', active: true, maxHp: 900, hp: 300 }]);
    state.players[1].field[0].ailments = [{ type: 'shock', turnsLeft: 3 }];

    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });

    expect(activeOf(state, 1).knockedDown).toBe(true);
    expect(state.turnState.oneMoresGranted).toBe(1);
  });

  it('scores no knockdown stat for a prevented one', () => {
    let state = stalwart(0.9);
    state = applyAction(state, zio());
    expect(state.players[0].stats.knockdowns).toBe(0);
  });
});
