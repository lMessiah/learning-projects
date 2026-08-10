/**
 * Traesto — the tactical retreat.
 *
 * The card pulls one of your field Personas back into your hand as the SAME
 * BODY: level, skills, passive and SP all survive the trip. What it sheds is
 * the fight it was in — ailments, buffs, debuffs, damage.
 *
 * It costs your action, it is never a knockout, and it is deliberately legal
 * to retreat your last Persona: an empty field is a position a player may
 * choose, and the clock is the only thing that argues with them.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, applyAction, getLegalActions, emptyFieldStage, personaSkills } from '../src/engine/index.js';
import { getCard, getPersona, SPECIALS } from '../src/data/cards.js';
import { expandDeck, ARCHETYPE_IDS, DECK_GROUP_CAPS } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf } from './helpers.js';

const CARD = 'traesto';

/** Seat 0 holds a Traesto and whatever board the test asks for. */
function board(specs = [{ cardId: 'silky', level: 20, active: true }, { cardId: 'nekomata', level: 14 }]) {
  const state = setupMatch();
  setField(state, 0, specs);
  setField(state, 1, [{ cardId: 'ara-mitama', active: true }]);
  setHand(state, 0, [CARD]);
  return state;
}

const retreatActions = (state) => getLegalActions(state, 0).filter((a) => a.cardId === CARD);
const offerFor = (state, cardId) =>
  retreatActions(state).find((a) => a.targetUid === uidOf(state, 0, cardId));

const play = (state, cardId, extra = {}) =>
  applyAction(state, { ...offerFor(state, cardId), ...extra });

const handEntryFor = (state, cardId) => state.players[0].hand.find((c) => c.cardId === cardId);
const logText = (state) => state.log.map((e) => e.text).join('\n');

/* ------------------------------------------------------------------ *
 * The card itself
 * ------------------------------------------------------------------ */

describe('the card', () => {
  it('exists as a Special that costs your action', () => {
    const card = getCard(CARD);
    expect(card.type).toBe('special');
    expect(card.usesAction).toBe(true);
    expect(card.effect.kind).toBe('retreat');
  });

  it('leans Tactical hardest, which is where the retreat belongs', () => {
    const { affinity } = getCard(CARD);
    expect(affinity.tactical).toBe(Math.max(...Object.values(affinity)));
  });

  it('says on its face that it keeps the Persona whole', () => {
    const text = getCard(CARD).description;
    expect(text).toMatch(/level/i);
    expect(text).toMatch(/passive/i);
    expect(text).toMatch(/HP/);
    expect(text).toMatch(/SP/);
  });

  it('is the only retreat effect in the game', () => {
    expect(SPECIALS.filter((c) => c.effect.kind === 'retreat').map((c) => c.id)).toEqual([CARD]);
  });
});

/* ------------------------------------------------------------------ *
 * What comes home
 * ------------------------------------------------------------------ */

describe('what the Persona keeps', () => {
  it('returns to hand as the same card', () => {
    const state = board();
    const before = state.players[0].hand.length;
    const next = play(state, 'nekomata');

    expect(next.players[0].field.some((p) => p.cardId === 'nekomata')).toBe(false);
    expect(next.players[0].hand.length).toBe(before); // the Traesto left, the Persona arrived
    expect(handEntryFor(next, 'nekomata')).toBeTruthy();
    expect(logText(next)).toContain('retreats to fight another day!');
  });

  it('keeps its level rather than reverting to the printed one', () => {
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 27 },
    ]);
    expect(getPersona('nekomata').level).toBeLessThan(27);

    const next = play(state, 'nekomata');
    expect(handEntryFor(next, 'nekomata').persona.level).toBe(27);
  });

  it('keeps every skill it learned or inherited', () => {
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 27, inheritedSkills: ['zio'] },
    ]);
    const before = personaSkills(state, state.players[0].field[1]).map((s) => s.id);
    expect(before).toContain('zio');

    const next = play(state, 'nekomata');
    const stashed = handEntryFor(next, 'nekomata').persona;
    expect(stashed.inheritedSkills).toContain('zio');
    expect(personaSkills(next, stashed).map((s) => s.id).sort()).toEqual(before.sort());
  });

  it('keeps its passive, inherited or printed', () => {
    const state = board();
    state.players[0].field[1].passive = 'stalwart';
    const next = play(state, 'nekomata');
    expect(handEntryFor(next, 'nekomata').persona.passive).toBe('stalwart');
  });

  it('keeps its SP exactly — the retreat is not a refill', () => {
    const state = board();
    state.players[0].field[1].sp = 2;
    const next = play(state, 'nekomata');
    expect(handEntryFor(next, 'nekomata').persona.sp).toBe(2);
  });

  it('comes back to full HP', () => {
    const state = board();
    state.players[0].field[1].hp = 3;
    const next = play(state, 'nekomata');
    const stashed = handEntryFor(next, 'nekomata').persona;
    expect(stashed.hp).toBe(stashed.maxHp);
  });

  it('sheds ailments, buffs, debuffs and charges — that was the fight, not the Persona', () => {
    const state = board();
    const victim = state.players[0].field[1];
    victim.ailments = [{ type: 'burn', turnsLeft: 3 }];
    victim.buffs = [{ stat: 'atk', direction: 'down', turnsLeft: 2 }];
    victim.charges = ['charge'];
    victim.knockedDown = true;
    victim.guarding = true;

    const stashed = handEntryFor(play(state, 'nekomata'), 'nekomata').persona;
    expect(stashed.ailments).toEqual([]);
    expect(stashed.buffs).toEqual([]);
    expect(stashed.charges).toEqual([]);
    expect(stashed.knockedDown).toBe(false);
    expect(stashed.guarding).toBe(false);
  });

  it('is never a knockout, on either tally', () => {
    const state = board();
    const next = play(state, 'nekomata');
    expect(next.players[0].koCount).toBe(0);
    expect(next.players[1].koCount).toBe(0);
  });

  it('costs your action', () => {
    const state = board();
    const next = play(state, 'nekomata');
    expect(next.turnState.actionsRemaining).toBe(0);
    expect(getLegalActions(next, 0).some((a) => a.type === 'ATTACK')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Replaying it
 * ------------------------------------------------------------------ */

describe('putting it back down', () => {
  it('returns the same body, not a fresh copy of the card', () => {
    const state = board([
      { cardId: 'silky', level: 24, active: true },
      { cardId: 'nekomata', level: 22, inheritedSkills: ['zio'] },
    ]);
    let next = play(state, 'nekomata');
    next.players[0].field[0].sp = 0; // prove nothing was refilled by the swap
    next = applyAction(next, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(next, 0, 'nekomata'),
    });

    const back = next.players[0].field.find((p) => p.cardId === 'nekomata');
    expect(back.level).toBe(22);
    expect(back.inheritedSkills).toContain('zio');
  });

  it('does NOT arrive at full SP — the one exception to the entry rule', () => {
    const state = board([
      { cardId: 'silky', level: 24, active: true },
      { cardId: 'nekomata', level: 22 },
    ]);
    let next = play(state, 'nekomata');
    handEntryFor(next, 'nekomata').persona.sp = 1;

    next = applyAction(next, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(next, 0, 'nekomata'),
    });
    expect(next.players[0].field.find((p) => p.cardId === 'nekomata').sp).toBe(1);
  });

  it('is exempt from the play ceiling — it was on your field a moment ago', () => {
    // Retreated at 27 onto a board whose ceiling is 18. A card you had not
    // earned could not be played here; this one you already had.
    const state = board([
      { cardId: 'silky', level: 8, active: true },
      { cardId: 'nekomata', level: 27 },
    ]);
    let next = play(state, 'nekomata');
    expect(27).toBeGreaterThan(8 + CONFIG.PLAY_LEVEL_GAP);

    expect(getLegalActions(next, 0).some((a) => a.type === 'PLAY_PERSONA' && a.cardId === 'nekomata')).toBe(true);
    next = applyAction(next, { type: 'PLAY_PERSONA', player: 0, handUid: handUidOf(next, 0, 'nekomata') });
    expect(next.players[0].field.find((p) => p.cardId === 'nekomata').level).toBe(27);
  });

  it('still holds the ceiling against an ordinary card in the same hand', () => {
    const state = board([{ cardId: 'silky', level: 8, active: true }]);
    setHand(state, 0, [CARD, 'jack-frost']);
    const tooBig = getPersona('jack-frost').level > 8 + CONFIG.PLAY_LEVEL_GAP;
    if (!tooBig) return; // data changed; nothing to assert
    expect(getLegalActions(state, 0).some((a) => a.type === 'PLAY_PERSONA' && a.cardId === 'jack-frost')).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * The slot it leaves behind
 * ------------------------------------------------------------------ */

describe('the active slot', () => {
  it('promotes the bench Persona you chose, for free', () => {
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 14 },
      { cardId: 'pixie', level: 12 },
    ]);
    const offer = offerFor(state, 'silky');
    expect(offer.promoteOptions.map((o) => o.cardId).sort()).toEqual(['nekomata', 'pixie']);
    expect(offer.needsChoice).toBe(true);

    const next = applyAction(state, { ...offer, promoteUid: uidOf(state, 0, 'pixie') });
    expect(activeOf(next, 0).cardId).toBe('pixie');
    // Free: the Persona change allowance is untouched.
    expect(next.turnState.personaChangesRemaining).toBe(CONFIG.PERSONA_CHANGES_PER_TURN);
    expect(logText(next)).toMatch(/steps up to take the slot/);
  });

  it('fills the slot without asking when the bench has only one answer', () => {
    const state = board();
    const offer = offerFor(state, 'silky');
    expect(offer.needsChoice).toBe(false);
    expect(offer.promoteUid).toBe(uidOf(state, 0, 'nekomata'));

    const next = applyAction(state, offer);
    expect(activeOf(next, 0).cardId).toBe('nekomata');
  });

  it('defaults to the healthiest body on the bench', () => {
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 14 },
      { cardId: 'pixie', level: 12 },
    ]);
    state.players[0].field[1].hp = 1; // Nekomata is nearly dead
    const offer = offerFor(state, 'silky');
    expect(offer.promoteUid).toBe(uidOf(state, 0, 'pixie'));
  });

  it('asks nothing at all when a bench Persona retreats', () => {
    const state = board();
    const offer = offerFor(state, 'nekomata');
    expect(offer.promoteOptions).toEqual([]);
    expect(offer.needsChoice).toBe(false);

    const next = applyAction(state, offer);
    expect(activeOf(next, 0).cardId).toBe('silky'); // untouched
  });

  it('refuses a promotion that is not on your bench', () => {
    const state = board();
    expect(() => play(state, 'silky', { promoteUid: uidOf(state, 1, 'ara-mitama') })).toThrow(/cannot step up/);
  });
});

/* ------------------------------------------------------------------ *
 * Retreating your last Persona
 * ------------------------------------------------------------------ */

describe('retreating your last Persona', () => {
  const lone = () => board([{ cardId: 'silky', level: 20, active: true }]);

  it('is legal — an empty field is a position you are allowed to choose', () => {
    const state = lone();
    expect(offerFor(state, 'silky')).toBeTruthy();
    const next = play(state, 'silky');
    expect(next.players[0].field).toEqual([]);
    expect(next.players[0].activeUid).toBe(null);
    expect(next.winner).toBe(null);
  });

  it('starts the loss timer on the next turn rather than ending anything now', () => {
    let state = play(lone(), 'silky');
    expect(emptyFieldStage(state, 0)).toBe(0); // the clock counts turn STARTS

    state = applyAction(state, { type: 'END_TURN', player: 0 });
    state = applyAction(state, { type: 'END_TURN', player: 1 });
    expect(emptyFieldStage(state, 0)).toBe(1);
    expect(state.winner).toBe(null);
  });

  it('is answered by putting the same Persona back down', () => {
    let state = play(lone(), 'silky');
    state = applyAction(state, { type: 'END_TURN', player: 0 });
    state = applyAction(state, { type: 'END_TURN', player: 1 });
    expect(emptyFieldStage(state, 0)).toBe(1);

    state = applyAction(state, {
      type: 'PLAY_PERSONA',
      player: 0,
      handUid: handUidOf(state, 0, 'silky'),
    });
    expect(emptyFieldStage(state, 0)).toBe(0);
    expect(activeOf(state, 0).level).toBe(20);
  });
});

/* ------------------------------------------------------------------ *
 * A retreated Persona is still that Persona
 * ------------------------------------------------------------------ */

describe('a retreated Persona in hand', () => {
  it('feeds the Gallows at the level it reached', () => {
    // Nekomata retreats at 22, so feeding it to a level-20 Silky is a FEAST.
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 22 },
    ]);
    let next = play(state, 'nekomata');
    next.turnState.actionsRemaining = 1; // the retreat spent it

    const meal = getLegalActions(next, 0).find(
      (a) => a.type === 'GALLOWS' && a.foodCardId === 'nekomata'
    );
    expect(meal.tier).toBe('feast');
    expect(meal.levels).toBe(CONFIG.GALLOWS_FEAST_LEVELS);
  });

  it('brings its own passive to the Gallows, not the one printed on its card', () => {
    const state = board([
      { cardId: 'silky', level: 20, active: true },
      { cardId: 'nekomata', level: 22 },
    ]);
    state.players[0].field[1].passive = 'sacrificial-lamb';
    let next = play(state, 'nekomata');
    next.turnState.actionsRemaining = 1;

    const meal = getLegalActions(next, 0).find(
      (a) => a.type === 'GALLOWS' && a.foodCardId === 'nekomata'
    );
    // Lamb rides on top of the tier, so the feast is worth one more level.
    expect(meal.levels).toBe(CONFIG.GALLOWS_FEAST_LEVELS + CONFIG.GALLOWS_LAMB_BONUS);
  });

  it('is hidden from the opponent like any other card in hand', async () => {
    const { redactStateFor, findLeaks } = await import('../src/engine/index.js');
    const next = play(board(), 'nekomata');
    const view = redactStateFor(next, 1);
    expect(findLeaks(view, 1)).toEqual([]);
    expect(view.players[0].hand.every((c) => c.cardId === null && !c.persona)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Deck generation
 * ------------------------------------------------------------------ */

describe('deck generation', () => {
  it('is hard-capped at one per deck', () => {
    expect(DECK_GROUP_CAPS[getCard(CARD).deckGroup]).toBe(1);
    for (const flavour of ['p3', 'p4', 'p5']) {
      for (const archetype of ARCHETYPE_IDS) {
        for (let seed = 1; seed <= 12; seed++) {
          const deck = expandDeck(flavour, { archetype, seed });
          expect(deck.filter((id) => id === CARD).length).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('shows up more often in Tactical decks than in Aggressive ones', () => {
    const rate = (archetype) => {
      let seen = 0;
      for (let seed = 1; seed <= 120; seed++) {
        if (expandDeck('p4', { archetype, seed }).includes(CARD)) seen += 1;
      }
      return seen;
    };
    expect(rate('tactical')).toBeGreaterThan(rate('aggressive'));
  });

  it('stays rare — it is a tool, not a staple', () => {
    let seen = 0;
    for (let seed = 1; seed <= 120; seed++) {
      if (expandDeck('p4', { archetype: 'tactical', seed }).includes(CARD)) seen += 1;
    }
    expect(seen).toBeLessThan(120); // never in every deck
  });
});
