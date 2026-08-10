import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, CONFIG } from '../src/engine/index.js';
import { getCard, getSkillDefinition, SKILLS } from '../src/data/cards.js';
import { ARCHETYPE_IDS, expandDeck } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

function board() {
  const state = setupMatch();
  setField(state, 0, [{ cardId: 'orpheus', active: true }, { cardId: 'pixie' }]);
  setField(state, 1, [{ cardId: 'jack-frost', active: true, hp: 400, maxHp: 400 }]);
  return state;
}

describe('SP economy', () => {
  it('deducts SP when a magic skill is used', () => {
    const state = board();
    const before = activeOf(state, 0).sp;
    const cost = getSkillDefinition('agi').spCost;
    const after = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    expect(activeOf(after, 0).sp).toBe(before - cost);
  });

  it('refuses a skill the Persona cannot afford, and hides it from the legal moves', () => {
    const state = board();
    activeOf(state, 0).sp = 2;
    expect(() => applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' })).toThrow(/enough SP/);
    expect(getLegalActions(state, 0).some((a) => a.skillId === 'agi')).toBe(false);
  });

  it('pays for physical skills with HP instead of SP', () => {
    const state = board();
    const before = { hp: activeOf(state, 0).hp, sp: activeOf(state, 0).sp };
    const after = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' });
    expect(activeOf(after, 0).hp).toBe(before.hp - 6); // Bash costs 6 HP
    expect(activeOf(after, 0).sp).toBe(before.sp);
  });

  it('never lets an HP-cost skill kill its own user', () => {
    const state = board();
    activeOf(state, 0).hp = 6; // exactly the cost of Bash
    expect(() => applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'bash' })).toThrow(/enough HP/);
    expect(getLegalActions(state, 0).some((a) => a.skillId === 'bash')).toBe(false);
  });

  it('regenerates SP in the active slot only', () => {
    let state = board();
    for (const persona of state.players[0].field) persona.sp = 0;
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    const [active, ...bench] = [activeOf(state, 0), ...state.players[0].field.filter((p) => p.uid !== state.players[0].activeUid)];
    expect(active.sp).toBe(CONFIG.SP_REGEN_PER_TURN);
    // The bench neither gains nor loses: rotating a spent Persona out is a real
    // cost, not a free refill.
    for (const persona of bench) expect(persona.sp).toBe(0);
  });

  it('carries a benched Persona\'s SP untouched until it comes back in', () => {
    let state = board();
    const [first, second] = state.players[0].field;
    first.sp = 20;
    second.sp = 5;

    state = endTurn(state, 0);
    state = endTurn(state, 1); // one full round for player 0
    expect(state.players[0].field[1].sp).toBe(5);

    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: second.uid });
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(activeOf(state, 0).sp).toBe(5 + CONFIG.SP_REGEN_PER_TURN);
  });

  it('never regenerates SP past the maximum', () => {
    let state = board();
    activeOf(state, 0).sp = activeOf(state, 0).maxSp;
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(activeOf(state, 0).sp).toBe(activeOf(state, 0).maxSp);
  });

  it('restores SP with Snuff Soul, clamped to the Persona\'s maximum', () => {
    let state = board();
    // Sarasvati has a 40 SP pool, so the full restore lands.
    setField(state, 0, [{ cardId: 'sarasvati', active: true, sp: 0 }]);
    setHand(state, 0, ['snuff-soul']);
    state = applyAction(state, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(state, 0, 'snuff-soul'),
      targetUid: activeOf(state, 0).uid,
    });
    expect(activeOf(state, 0).sp).toBe(getCard('snuff-soul').effect.amount);

    // A Persona with almost no pool left clamps to its maximum instead.
    let small = board();
    activeOf(small, 0).sp = 0;
    activeOf(small, 0).maxSp = 10;
    setHand(small, 0, ['snuff-soul']);
    small = applyAction(small, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(small, 0, 'snuff-soul'),
      targetUid: activeOf(small, 0).uid,
    });
    expect(activeOf(small, 0).sp).toBe(activeOf(small, 0).maxSp);
  });

  it('brings a Persona played from hand in at FULL SP', () => {
    let state = board();
    setHand(state, 0, ['silky']);
    state = applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(state, 0, 'silky') });

    const played = state.players[0].field.find((p) => p.cardId === 'silky');
    expect(played.maxSp).toBe(getCard('silky').sp);
    expect(played.sp).toBe(played.maxSp);
    expect(played.hp).toBe(played.maxHp);
  });

  it('gives a revived Persona its SP back in full, whatever the HP percentage', () => {
    let state = board();
    const target = state.players[0].field.find((p) => p.uid !== state.players[0].activeUid);
    target.ko = true;
    target.hp = 0;
    target.sp = 0;
    setHand(state, 0, ['revival-bead']);
    state = applyAction(state, {
      type: 'PLAY_ITEM',
      player: 0,
      handUid: handUidOf(state, 0, 'revival-bead'),
      targetUid: target.uid,
    });

    const revived = state.players[0].field.find((p) => p.uid === target.uid);
    expect(revived.ko).toBe(false);
    expect(revived.sp).toBe(revived.maxSp);
    expect(revived.hp).toBe(Math.round(revived.maxHp * 0.5)); // HP still per the item
  });

  it('starts every Persona on the field at full SP, however it got there', () => {
    // The starter, and anything the opening hand puts down, alike.
    const state = board();
    for (const persona of state.players[0].field) {
      expect(persona.sp, `${persona.cardId} did not enter at full SP`).toBe(persona.maxSp);
    }
  });

  it('keeps every damaging skill above the regen tap, so casting is a decision', () => {
    // The economy only bites if the skills a Persona reaches for cost more than
    // one turn of regen. Spirit Drain is deliberately exempt: it deals no damage
    // and its whole job is to be SP-positive, which is why it costs an action.
    for (const skill of Object.values(SKILLS)) {
      if (skill.spCost == null || skill.spCost === 0) continue;
      if (skill.effect.kind !== 'damage') continue;
      expect(skill.spCost, `${skill.name} is cheaper than one turn of regen`).toBeGreaterThan(
        CONFIG.SP_REGEN_PER_TURN
      );
    }
  });

  it('lets Spirit Drain come out ahead — that is the whole card', () => {
    const drain = SKILLS['spirit-drain'];
    expect(drain.effect.kind).toBe('drainSp');
    expect(drain.effect.amount).toBeGreaterThan(drain.spCost);
  });

  it('caps SP-restore items at two per generated deck, between them', () => {
    for (const flavour of ['p3', 'p4', 'p5']) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        for (const seed of [1, 2, 3, 17, 99]) {
          const restores = expandDeck(flavour, { archetype, seed }).filter(
            (id) => getCard(id).deckGroup === 'sp-restore'
          );
          expect(restores.length, `${flavour}/${archetype}/${seed}`).toBeLessThanOrEqual(2);
        }
      }
    }
  });

  it('moves SP between your own Personas with SP Transfer, capped by the target\'s maximum', () => {
    let state = board();
    const [active, bench] = state.players[0].field;
    active.sp = 40;
    active.maxSp = 40;
    bench.sp = bench.maxSp - 5; // only room for 5

    setHand(state, 0, ['sp-transfer']);
    state = applyAction(state, {
      type: 'PLAY_SPECIAL',
      player: 0,
      handUid: handUidOf(state, 0, 'sp-transfer'),
      fromUid: active.uid,
      toUid: bench.uid,
      amount: 30,
    });

    const after = state.players[0].field;
    expect(after[1].sp).toBe(after[1].maxSp);
    expect(after[0].sp).toBe(35); // only the 5 that fit actually moved
  });
});

describe('one Item and one Special per turn', () => {
  it('allows exactly one Item card per turn', () => {
    let state = board();
    activeOf(state, 0).hp = 10;
    setHand(state, 0, ['medicine', 'medicine']);
    const [first, second] = state.players[0].hand;

    state = applyAction(state, { type: 'PLAY_ITEM', player: 0, handUid: first.uid, targetUid: activeOf(state, 0).uid });
    expect(state.turnState.itemsPlayed).toBe(1);

    expect(() =>
      applyAction(state, { type: 'PLAY_ITEM', player: 0, handUid: second.uid, targetUid: activeOf(state, 0).uid })
    ).toThrow(/1 Item card may be played per turn/);
    expect(getLegalActions(state, 0).some((a) => a.type === 'PLAY_ITEM')).toBe(false);
  });

  it('allows exactly one Special card per turn', () => {
    let state = board();
    setHand(state, 0, ['concentrate', 'baton-pass']);
    const [first, second] = state.players[0].hand;

    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: first.uid });
    expect(state.turnState.specialsPlayed).toBe(1);

    expect(() => applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: second.uid })).toThrow(
      /1 Special card may be played per turn/
    );
    expect(getLegalActions(state, 0).some((a) => a.type === 'PLAY_SPECIAL')).toBe(false);
  });

  it('counts Items and Specials separately — one of each is fine', () => {
    let state = board();
    activeOf(state, 0).hp = 10;
    setHand(state, 0, ['medicine', 'concentrate']);
    const [item, special] = state.players[0].hand;

    state = applyAction(state, { type: 'PLAY_ITEM', player: 0, handUid: item.uid, targetUid: activeOf(state, 0).uid });
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: special.uid });

    expect(state.turnState.itemsPlayed).toBe(1);
    expect(state.turnState.specialsPlayed).toBe(1);
  });

  it('resets both allowances at the start of the next turn', () => {
    let state = board();
    setHand(state, 0, ['concentrate', 'baton-pass']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: state.players[0].hand[0].uid });
    state = endTurn(state, 0);
    state = endTurn(state, 1);

    expect(state.turnState.specialsPlayed).toBe(0);
    expect(state.turnState.itemsPlayed).toBe(0);
    expect(getLegalActions(state, 0).some((a) => a.type === 'PLAY_SPECIAL')).toBe(true);
  });

  it('does not spend your action on an Item or a normal Special', () => {
    let state = board();
    activeOf(state, 0).hp = 10;
    setHand(state, 0, ['medicine', 'concentrate']);
    const [item, special] = state.players[0].hand;

    state = applyAction(state, { type: 'PLAY_ITEM', player: 0, handUid: item.uid, targetUid: activeOf(state, 0).uid });
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: special.uid });
    expect(state.turnState.actionsRemaining).toBe(1); // still free to attack
  });

  it('does spend your action on a Special flagged usesAction', () => {
    let state = board();
    setHand(state, 0, ['theurgy']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'theurgy') });
    expect(state.turnState.actionsRemaining).toBe(0);
  });
});

describe('hand and action allowances', () => {
  it('draws one card at the start of your turn', () => {
    let state = board();
    const before = state.players[1].hand.length;
    state = endTurn(state, 0);
    expect(state.players[1].hand.length).toBe(before + CONFIG.DRAW_PER_TURN);
  });

  it('draws an extra card when you pass', () => {
    const state = board();
    const before = state.players[0].hand.length;
    const after = applyAction(state, { type: 'PASS', player: 0 });
    expect(after.players[0].hand.length).toBe(before + CONFIG.PASS_DRAW);
    expect(after.turnState.actionsRemaining).toBe(0);
  });

  it('forces a discard down to the hand limit at end of turn', () => {
    const state = board();
    setHand(state, 0, Array(9).fill('medicine'));
    expect(() => applyAction(state, { type: 'END_TURN', player: 0, discard: [] })).toThrow(/discard exactly 2/);

    const after = endTurn(state, 0);
    expect(after.players[0].hand).toHaveLength(CONFIG.HAND_LIMIT);
    expect(after.players[0].discard.filter((c) => c === 'medicine')).toHaveLength(2);
  });

  it('allows only one Persona change per turn, and one more after a One More', () => {
    let state = board();
    const benchUid = state.players[0].field[1].uid;
    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: benchUid });
    expect(state.turnState.personaChangesRemaining).toBe(0);

    const originalUid = state.players[0].field[0].uid;
    expect(() => applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: originalUid })).toThrow(
      /already changed Persona/
    );
  });

  it('grants an extra Persona change from the Baton Pass special', () => {
    let state = board();
    setHand(state, 0, ['baton-pass']);
    state = applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, 'baton-pass') });
    expect(state.turnState.personaChangesRemaining).toBe(2);
  });

  it('caps the field at FIELD_CAP living Personas', () => {
    const state = board();
    setField(
      state,
      0,
      Array.from({ length: CONFIG.FIELD_CAP }, (_, i) => ({ cardId: 'pixie', active: i === 0 }))
    );
    setHand(state, 0, ['pixie']);
    expect(() => applyAction(state, { type: 'PLAY_PERSONA', player: 0, handUid: state.players[0].hand[0].uid })).toThrow(
      /field is full/
    );
    expect(getLegalActions(state, 0).some((a) => a.type === 'PLAY_PERSONA')).toBe(false);
  });
});
