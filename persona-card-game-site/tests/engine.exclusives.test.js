/**
 * Flavour-exclusive cards.
 *
 * Each game gets three or four cards nobody else can run, embodying that
 * game's signature mechanic — plus a `flavourLean` that pushes the whole deck
 * toward the play style those cards want.
 */
import { describe, it, expect } from 'vitest';
import { applyAction, getLegalActions, redactStateFor, findLeaks, CONFIG } from '../src/engine/index.js';
import { ITEMS, SPECIALS, DECKS, getCard, getPersona } from '../src/data/cards.js';
import { ARCHETYPE_IDS, expandDeck, poolFor, exclusivesFor } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, activeOf, handUidOf, endTurn } from './helpers.js';

const FLAVOURS = DECKS.map((d) => d.id);
const play = (state, cardId, extra = {}) => {
  const card = getCard(cardId);
  return applyAction(state, {
    type: card.type === 'item' ? 'PLAY_ITEM' : 'PLAY_SPECIAL',
    player: 0,
    handUid: handUidOf(state, 0, cardId),
    ...extra,
  });
};

/** Scout the enemy active so Phantom Strike is armable. */
function scout(state) {
  const target = state.players[1].field[0];
  const card = getPersona(target.cardId);
  target.revealedTypes = [...card.weaknesses, ...card.resists];
  return state;
}

function duel({ own = ['orpheus'], foe = ['jack-frost'] } = {}) {
  const state = setupMatch();
  setField(state, 0, own.map((cardId, i) => ({ cardId, active: i === 0, hp: 400, maxHp: 400 })));
  setField(state, 1, foe.map((cardId, i) => ({ cardId, active: i === 0, hp: 400, maxHp: 400 })));
  return state;
}

describe('the exclusive lists', () => {
  it('gives every flavour four or five cards of its own', () => {
    for (const flavour of FLAVOURS) {
      const own = exclusivesFor(flavour);
      expect(own.length, flavour).toBeGreaterThanOrEqual(4);
      expect(own.length, flavour).toBeLessThanOrEqual(5);
    }
  });

  it('gives every flavour exactly one affinity-rewrite card', () => {
    // One per deck, deliberately: the counter to a memorised card database and
    // to the Brutal bot's card-reading has to be available whatever you play.
    for (const flavour of FLAVOURS) {
      const rewrites = exclusivesFor(flavour).filter((c) => c.effect.kind === 'rewriteAffinities');
      expect(rewrites.map((c) => c.id), flavour).toHaveLength(1);
    }
  });

  it('keeps them out of every other flavour\'s pool', () => {
    for (const flavour of FLAVOURS) {
      const pool = new Set(Object.values(poolFor(flavour)).flat().map((c) => c.id));
      for (const other of FLAVOURS) {
        for (const card of exclusivesFor(other)) {
          expect(pool.has(card.id), `${card.name} in ${flavour}'s pool`).toBe(other === flavour);
        }
      }
    }
  });

  it('actually deals them: an exclusive shows up in its own flavour\'s decks', () => {
    for (const flavour of FLAVOURS) {
      const seen = new Set();
      for (const archetype of ARCHETYPE_IDS) {
        for (let seed = 1; seed <= 12; seed++) {
          for (const id of expandDeck(flavour, { archetype, seed })) seen.add(id);
        }
      }
      for (const card of exclusivesFor(flavour)) {
        expect(seen.has(card.id), `${card.name} never appeared in a ${flavour} deck`).toBe(true);
      }
    }
  });

  it('states each flavour\'s play style in one line', () => {
    for (const deck of DECKS) {
      expect(deck.playstyle).toBeTruthy();
      expect(deck.playstyle.length).toBeLessThan(120);
      expect(ARCHETYPE_IDS).toContain(deck.flavourLean);
    }
  });

  it('leans each flavour toward its own axis, without overruling the player\'s choice', () => {
    const leaning = (cards, axis) =>
      cards.reduce((sum, id) => sum + (getCard(id).affinity?.[axis] ?? 0), 0) / cards.length;

    for (const deck of DECKS) {
      const lean = deck.flavourLean;
      let own = 0;
      let others = 0;
      for (let seed = 1; seed <= 20; seed++) {
        own += leaning(expandDeck(deck.id, { archetype: 'swift', seed }), lean);
        const rivals = DECKS.filter((d) => d.flavourLean !== lean);
        others += leaning(expandDeck(rivals[0].id, { archetype: 'swift', seed }), lean);
      }
      // Same archetype on both sides, so any gap is the flavour lean.
      expect(own, `${deck.id} leans ${lean}`).toBeGreaterThan(others);

      // ...but the archetype still wins: a Swift deck is swiftier than a
      // Defensive one of the same flavour.
      const swift = leaning(expandDeck(deck.id, { archetype: 'swift', seed: 4 }), 'swift');
      const defensive = leaning(expandDeck(deck.id, { archetype: 'defensive', seed: 4 }), 'swift');
      expect(swift).toBeGreaterThan(defensive);
    }
  });
});

describe('P5 — Phantom Strike', () => {
  it('refuses to arm against a Persona that has not been scouted', () => {
    const state = duel();
    setHand(state, 0, ['phantom-strike']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'phantom-strike')).toHaveLength(0);
    expect(() => play(state, 'phantom-strike')).toThrow(/not been fully scouted/);
  });

  it('boosts the next weakness hit and refunds its SP', () => {
    const baseline = scout(duel());
    setField(baseline, 0, [{ cardId: 'orpheus', active: true }]);
    const plainBefore = activeOf(baseline, 1).hp;
    const plainAfter = applyAction(baseline, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    const plain = plainBefore - activeOf(plainAfter, 1).hp;

    let state = scout(duel());
    setField(state, 0, [{ cardId: 'orpheus', active: true }]);
    setHand(state, 0, ['phantom-strike']);
    state = play(state, 'phantom-strike');
    const spBefore = activeOf(state, 0).sp;

    const before = activeOf(state, 1).hp;
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });

    expect(before - activeOf(state, 1).hp).toBe(Math.round(plain * CONFIG.PHANTOM_STRIKE_MULT));
    expect(activeOf(state, 0).sp).toBe(spBefore); // the shadows paid for it
    expect(state.turnState.phantomStrike).toBe(false); // spent
  });

  it('waits for a weakness — a neutral hit does not spend it', () => {
    let state = scout(duel({ foe: ['pixie'] })); // Pixie is neutral to fire
    setHand(state, 0, ['phantom-strike']);
    state = play(state, 'phantom-strike');
    state = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    expect(state.turnState.phantomStrike).toBe(true);
  });
});

describe('P5 — Smoke Bomb', () => {
  it('swaps for free: no action, no Persona change', () => {
    let state = duel({ own: ['orpheus', 'silky'] });
    setHand(state, 0, ['smoke-bomb']);
    const bench = state.players[0].field[1];
    const changes = state.turnState.personaChangesRemaining;

    state = play(state, 'smoke-bomb', { targetUid: bench.uid });

    expect(state.players[0].activeUid).toBe(bench.uid);
    expect(state.turnState.personaChangesRemaining).toBe(changes);
    expect(state.turnState.actionsRemaining).toBe(CONFIG.ACTIONS_PER_TURN);
  });

  it('still works after the ordinary Persona change is gone', () => {
    let state = duel({ own: ['orpheus', 'silky', 'anzu'] });
    setHand(state, 0, ['smoke-bomb']);
    state = applyAction(state, { type: 'CHANGE_ACTIVE', player: 0, targetUid: state.players[0].field[1].uid });
    expect(state.turnState.personaChangesRemaining).toBe(0);

    state = play(state, 'smoke-bomb', { targetUid: state.players[0].field[2].uid });
    expect(state.players[0].activeUid).toBe(state.players[0].field[2].uid);
  });
});

describe('P4 — Shuffle Time', () => {
  it('takes one of the top three and bottoms the rest, in order', () => {
    let state = duel();
    state.players[0].deck = ['anzu', 'silky', 'medicine', 'soma', 'pixie'];
    setHand(state, 0, ['shuffle-time']);

    const options = getLegalActions(state, 0).filter((a) => a.cardId === 'shuffle-time');
    expect(options.map((a) => a.keepCardId)).toEqual(['anzu', 'silky', 'medicine']);

    state = play(state, 'shuffle-time', { keepIndex: 1 });

    expect(state.players[0].hand.map((c) => c.cardId)).toContain('silky');
    expect(state.players[0].deck).toEqual(['soma', 'pixie', 'anzu', 'medicine']);
  });

  it('lets its holder read the top of their own deck, and nobody else', () => {
    const state = duel();
    state.players[0].deck = ['anzu', 'silky', 'medicine', 'soma'];
    state.players[1].deck = ['pixie', 'orpheus'];
    setHand(state, 0, ['shuffle-time']);

    const mine = redactStateFor(state, 0);
    expect(mine.players[0].deckTop).toEqual(['anzu', 'silky', 'medicine']);
    expect(mine.players[1].deckTop).toBeUndefined();
    expect(findLeaks(mine, 0)).toEqual([]);

    // Their view sees nothing of my deck at all.
    const theirs = redactStateFor(state, 1);
    expect(theirs.players[0].deckTop).toBeUndefined();
    expect(findLeaks(theirs, 1)).toEqual([]);
  });

  it('grants no peek without the card in hand', () => {
    const state = duel();
    state.players[0].deck = ['anzu', 'silky'];
    setHand(state, 0, ['medicine']);
    expect(redactStateFor(state, 0).players[0].deckTop).toBeUndefined();
  });
});

describe('P4 — Persona Evolution', () => {
  it('teaches the active Persona its next printed skill early', () => {
    let state = duel({ own: ['jack-frost'] }); // level 6: knows Bufu only
    setHand(state, 0, ['persona-evolution']);
    const before = activeOf(state, 0).inheritedSkills.length;

    state = play(state, 'persona-evolution');

    const after = activeOf(state, 0);
    expect(after.inheritedSkills.length).toBe(before + 1);
    expect(after.level).toBe(6); // it learns, it does not level
    expect(state.log.some((l) => l.text.includes('broke through'))).toBe(true);
  });

  it('is not offered to a Persona that already knows everything', () => {
    const state = duel({ own: ['jack-frost'] });
    setField(state, 0, [{ cardId: 'jack-frost', active: true, level: 99 }]);
    setHand(state, 0, ['persona-evolution']);
    expect(getLegalActions(state, 0).filter((a) => a.cardId === 'persona-evolution')).toHaveLength(0);
  });
});

describe('P3 — Dark Hour', () => {
  function damageWith(setup = () => {}) {
    const state = duel();
    setup(state);
    const before = activeOf(state, 1).hp;
    const after = applyAction(state, { type: 'USE_SKILL', player: 0, skillId: 'agi' });
    return before - activeOf(after, 1).hp;
  }

  it('raises damage for both sides, not just the caster', () => {
    const plain = damageWith();
    const dark = damageWith((state) => {
      state.darkHour = { turnsLeft: 2 };
    });
    expect(dark).toBe(Math.round(plain * CONFIG.DARK_HOUR_MULT));

    // ...and the same multiplier applies when the OPPONENT swings.
    let state = duel();
    state.darkHour = { turnsLeft: 2 };
    state = endTurn(state, 0);
    const before = activeOf(state, 0).hp;
    state = applyAction(state, { type: 'ATTACK', player: 1 });
    const boosted = before - activeOf(state, 0).hp;

    let control = duel();
    control = endTurn(control, 0);
    const controlBefore = activeOf(control, 0).hp;
    control = applyAction(control, { type: 'ATTACK', player: 1 });
    expect(boosted).toBeGreaterThan(controlBefore - activeOf(control, 0).hp);
  });

  it('leaves flat Special damage exactly where the card printed it', () => {
    let state = duel();
    state.darkHour = { turnsLeft: 2 };
    setHand(state, 0, ['theurgy']);
    const before = activeOf(state, 1).hp;
    state = play(state, 'theurgy');
    expect(before - activeOf(state, 1).hp).toBe(getCard('theurgy').effect.amount);
  });

  it('passes after one full round', () => {
    let state = duel();
    setHand(state, 0, ['dark-hour']);
    state = play(state, 'dark-hour');
    expect(state.darkHour.turnsLeft).toBe(CONFIG.DARK_HOUR_TURNS);

    state = endTurn(state, 0);
    expect(state.darkHour.turnsLeft).toBe(CONFIG.DARK_HOUR_TURNS - 1);
    state = endTurn(state, 1);
    expect(state.darkHour).toBe(null);
  });
});

describe('P3 — Moonless Gown', () => {
  it('makes the active untouchable and unable to act', () => {
    let state = duel();
    setHand(state, 0, ['moonless-gown']);
    state = play(state, 'moonless-gown');
    expect(activeOf(state, 0).warded).toBe(true);

    // It cannot act...
    expect(() => applyAction(state, { type: 'ATTACK', player: 0 })).toThrow(/moonless gown/);
    expect(getLegalActions(state, 0).some((a) => a.type === 'ATTACK')).toBe(false);
    expect(getLegalActions(state, 0).some((a) => a.type === 'PASS')).toBe(true);

    // ...and nothing gets through.
    state = endTurn(state, 0);
    const before = activeOf(state, 0).hp;
    state = applyAction(state, { type: 'ATTACK', player: 1 });
    expect(activeOf(state, 0).hp).toBe(before);
  });

  it('wears off at the start of its owner\'s next turn', () => {
    let state = duel();
    setHand(state, 0, ['moonless-gown']);
    state = play(state, 'moonless-gown');
    state = endTurn(state, 0);
    state = endTurn(state, 1);
    expect(activeOf(state, 0).warded).toBe(false);
    expect(getLegalActions(state, 0).some((a) => a.type === 'ATTACK')).toBe(true);
  });
});
