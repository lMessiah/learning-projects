/**
 * Draw-manipulation Specials.
 *
 * All three are deterministic and seeded, all three override the Momentum Draw
 * weighting and the draw-level floor for the draw they claim, and none of them
 * leaks anything a redacted view is not allowed to carry.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  drawCards,
  redactStateFor,
  findLeaks,
  revealType,
  CONFIG,
} from '../src/engine/index.js';
import { getCard } from '../src/data/cards.js';
import { setupMatch, setField, setHand, handUidOf, activeOf } from './helpers.js';

function duel({ theirs = 'jack-frost' } = {}) {
  const state = setupMatch({ seed: 1919 });
  setField(state, 0, [{ cardId: 'ippon-datara', level: 18, active: true }]);
  setField(state, 1, [{ cardId: theirs, level: 10, active: true }]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

const play = (state, cardId, extra = {}) =>
  applyAction(state, { type: 'PLAY_SPECIAL', player: 0, handUid: handUidOf(state, 0, cardId), ...extra });

/* ------------------------------------------------------------------ *
 * Whims of Fate
 * ------------------------------------------------------------------ */

describe('Whims of Fate', () => {
  // Jack Frost is weak to fire. Hua Po throws Agi at its printed level; Silky
  // does not have a fire skill at all.
  const FIRE_ANSWER = 'hua-po';
  const NO_ANSWER = 'silky';

  it('matches only REVEALED weaknesses while you are level or ahead', () => {
    let state = duel();
    state.players[0].deck = [NO_ANSWER, NO_ANSWER, FIRE_ANSWER];
    setHand(state, 0, ['whims-of-fate']);

    // Nothing uncovered yet: the card is not even offered.
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'whims-of-fate')).toHaveLength(0);

    revealType(state, activeOf(state, 1), 'fire');
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'whims-of-fate')).toHaveLength(1);

    state = play(state, 'whims-of-fate');
    drawCards(state, 0, 1);
    expect(state.players[0].hand.at(-1).cardId).toBe(FIRE_ANSWER);
  });

  it('matches EVERY weakness once you are far enough behind, revealed or not', () => {
    let state = duel();
    state.players[0].deck = [NO_ANSWER, NO_ANSWER, FIRE_ANSWER];
    setHand(state, 0, ['whims-of-fate']);
    state.players[0].koCount = CONFIG.WHIMS_DEFICIT; // behind by exactly the threshold

    // Still nothing uncovered, and now it does not matter.
    expect(activeOf(state, 1).revealedTypes).toEqual([]);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'whims-of-fate')).toHaveLength(1);

    state = play(state, 'whims-of-fate');
    drawCards(state, 0, 1);
    expect(state.players[0].hand.at(-1).cardId).toBe(FIRE_ANSWER);
  });

  it('does not reveal the weakness it read', () => {
    let state = duel();
    state.players[0].deck = [FIRE_ANSWER];
    setHand(state, 0, ['whims-of-fate']);
    state.players[0].koCount = CONFIG.WHIMS_DEFICIT;

    state = play(state, 'whims-of-fate');
    expect(state.players[1].field[0].revealedTypes).toEqual([]);
  });

  it('whiffs gracefully when the deck holds no answer', () => {
    let state = duel();
    state.players[0].deck = [NO_ANSWER, 'medicine', NO_ANSWER];
    setHand(state, 0, ['whims-of-fate']);
    // Level on knockouts, so the fall-through is the plain top-of-deck draw
    // rather than the Momentum weighting.
    revealType(state, activeOf(state, 1), 'fire');

    state = play(state, 'whims-of-fate');
    drawCards(state, 0, 1);

    expect(state.players[0].hand.at(-1).cardId).toBe(NO_ANSWER); // the plain top card
    expect(state.players[0].pendingDraw).toBe(null); // spent regardless
    expect(state.log.some((e) => e.text.includes('Fate finds nothing'))).toBe(true);
  });

  it('is not offered against a Persona with no weaknesses at all', () => {
    // Izanagi-no-Okami prints an empty weakness list.
    const state = duel({ theirs: 'izanagi-no-okami' });
    setHand(state, 0, ['whims-of-fate']);
    state.players[0].koCount = CONFIG.WHIMS_DEFICIT;
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'whims-of-fate')).toHaveLength(0);
  });

  it('keeps its reading out of every redacted view', () => {
    let state = duel();
    state.players[0].deck = ['hua-po'];
    setHand(state, 0, ['whims-of-fate']);
    state.players[0].koCount = CONFIG.WHIMS_DEFICIT;
    state = play(state, 'whims-of-fate');

    expect(state.players[0].pendingDraw.types).toEqual(['fire']); // authoritative
    for (const viewer of [0, 1]) {
      const view = redactStateFor(state, viewer);
      expect(findLeaks(view, viewer)).toEqual([]);
      expect(view.players[0].pendingDraw.types).toBeUndefined();
      expect(view.players[0].pendingDraw.fate).toBe(true);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Arcana Reading
 * ------------------------------------------------------------------ */

describe('Arcana Reading', () => {
  it('takes the HIGHEST-level Persona of the named Arcana, not the first', () => {
    let state = duel();
    // Three Priestesses, deliberately in ascending order so "first" and "best"
    // cannot be the same card.
    state.players[0].deck = ['apsaras', 'medicine', 'silky', 'sarasvati'];
    setHand(state, 0, ['arcana-reading']);

    state = play(state, 'arcana-reading', { arcana: 'Priestess' });
    expect(state.players[0].pendingDraw).toEqual({ arcana: 'Priestess', best: true });

    drawCards(state, 0, 1);
    expect(state.players[0].hand.at(-1).cardId).toBe('sarasvati'); // level 19, the best of them
  });

  it('offers exactly the Arcana still left in your deck', () => {
    const state = duel();
    state.players[0].deck = ['anzu', 'medicine', 'pixie'];
    setHand(state, 0, ['arcana-reading']);
    const options = getLegalActions(state, 0).filter((a) => a.cardId === 'arcana-reading');
    expect(options.map((a) => a.arcana).sort()).toEqual(['Lovers', 'Star']);
  });

  it('leaves Fortune\'s Draw taking the first match, not the best', () => {
    let state = duel();
    state.players[0].deck = ['apsaras', 'sarasvati'];
    setHand(state, 0, ['fortunes-draw']);
    state = play(state, 'fortunes-draw', { arcana: 'Priestess' });
    drawCards(state, 0, 1);
    expect(state.players[0].hand.at(-1).cardId).toBe('apsaras');
  });
});

/* ------------------------------------------------------------------ *
 * Providence
 * ------------------------------------------------------------------ */

describe('Providence', () => {
  const TOP = ['pixie', 'medicine', 'anzu', 'silky', 'bead', 'nekomata'];

  it('bins what you picked and keeps the rest on top, in order', () => {
    let state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);

    state = play(state, 'providence', { discardIndexes: [0, 3] });

    expect(state.players[0].discard).toContain('pixie');
    expect(state.players[0].discard).toContain('silky');
    // The survivors of the top 5, in their original order, then the untouched rest.
    expect(state.players[0].deck).toEqual(['medicine', 'anzu', 'bead', 'nekomata']);
  });

  it('can keep everything, which changes nothing at all', () => {
    let state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);

    state = play(state, 'providence', { discardIndexes: [] });
    expect(state.players[0].deck).toEqual(TOP);
    expect(state.players[0].discard).toEqual(['providence']); // only the card itself
  });

  it('can bin the lot', () => {
    let state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);

    state = play(state, 'providence', { discardIndexes: [0, 1, 2, 3, 4] });
    expect(state.players[0].deck).toEqual(['nekomata']);
  });

  it('refuses an index it never showed you', () => {
    const state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);
    expect(() => play(state, 'providence', { discardIndexes: [5] })).toThrow(/pick from the top 5/);
  });

  it('reads only as deep as the deck actually goes', () => {
    let state = duel();
    state.players[0].deck = ['pixie', 'medicine'];
    setHand(state, 0, ['providence']);
    state = play(state, 'providence', { discardIndexes: [1] });
    expect(state.players[0].deck).toEqual(['pixie']);
  });

  it('offers a discard ladder for the bot, cheapest cards first', () => {
    const state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);

    const options = getLegalActions(state, 0).filter((a) => a.cardId === 'providence');
    expect(options).toHaveLength(CONFIG.PROVIDENCE_LOOK + 1); // discard 0..5 of them
    expect(options[0].discardIndexes).toEqual([]);
    expect(options.at(-1).discardIndexes).toEqual([0, 1, 2, 3, 4]);
    for (const option of options) expect(option.providenceTop).toEqual(TOP.slice(0, 5));
    // Each rung adds exactly one more card.
    for (const [i, option] of options.entries()) expect(option.discardIndexes).toHaveLength(i);
  });

  it('lets the holder read their own deck top, and nobody else', () => {
    const state = duel();
    state.players[0].deck = [...TOP];
    setHand(state, 0, ['providence']);

    const mine = redactStateFor(state, 0);
    expect(mine.players[0].deckTop).toEqual(TOP.slice(0, CONFIG.PROVIDENCE_LOOK));
    expect(findLeaks(mine, 0)).toEqual([]);

    const theirs = redactStateFor(state, 1);
    expect(theirs.players[0].deckTop).toBeUndefined();
    expect(findLeaks(theirs, 1)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * Shared rules
 * ------------------------------------------------------------------ */

describe('draw manipulation as a whole', () => {
  it('overrides both the Momentum weighting and the draw-level floor', () => {
    let state = duel();
    state.turn = 40; // floor at the cap
    state.players[0].koCount = 5; // and deep enough behind for Momentum Draw
    state.players[0].deck = ['anzu', 'anzu', 'pixie', 'anzu'];
    setHand(state, 0, ['fortunes-draw']);

    state = play(state, 'fortunes-draw', { arcana: 'Lovers' });
    drawCards(state, 0, 1);
    // Pixie is level 3 and the worst card there — and she is what you asked for.
    expect(state.players[0].hand.at(-1).cardId).toBe('pixie');
  });

  it('is deterministic: the same board resolves the same way every time', () => {
    const run = () => {
      let state = duel();
      state.players[0].deck = ['silky', 'hua-po', 'medicine', 'nekomata'];
      setHand(state, 0, ['whims-of-fate']);
      state.players[0].koCount = CONFIG.WHIMS_DEFICIT;
      state = play(state, 'whims-of-fate');
      drawCards(state, 0, 1);
      return state.players[0].hand.at(-1).cardId;
    };
    expect(run()).toBe(run());
  });

  it('costs no action, like every other free Special', () => {
    for (const id of ['whims-of-fate', 'arcana-reading', 'providence']) {
      expect(getCard(id).usesAction).toBe(false);
      expect(getCard(id).description).not.toMatch(/uses up your action/i);
    }
  });
});
