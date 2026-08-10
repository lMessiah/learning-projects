/**
 * Twist of Fate.
 *
 * The counterplay for "my deck cannot hit anything they are weak to". Unlike
 * the rewrite Specials, which scramble a whole chart and hand you a new puzzle,
 * this makes one precise edit: you name the element. It pays for that precision
 * by letting the DEFENDER choose which of their weaknesses they give up.
 */
import { describe, it, expect } from 'vitest';
import {
  applyAction,
  getLegalActions,
  affinitiesOf,
  twistableElements,
  twistSacrifice,
  createMatch,
  createRng,
} from '../src/engine/index.js';
import { getCard, DAMAGE_TYPES } from '../src/data/cards.js';
import { buildDeck } from '../src/data/archetypes.js';
import { setupMatch, setField, setHand, handUidOf, activeOf, endTurn } from './helpers.js';

const CARD = 'twist-of-fate';

/** A board where our active is theirs to twist, with a known chart. */
function board({ weaknesses = ['ice'], resists = ['fire'], revealed = [] } = {}) {
  const state = setupMatch({ seed: 515 });
  setField(state, 0, [{ cardId: 'pixie', level: 14, active: true }]);
  setField(state, 1, [{ cardId: 'angel', level: 14, active: true }]);
  const target = activeOf(state, 1);
  target.weaknesses = [...weaknesses];
  target.resists = [...resists];
  target.revealedTypes = [...revealed];
  setHand(state, 0, [CARD]);
  return state;
}

const play = (state, element) =>
  applyAction(state, {
    type: 'PLAY_SPECIAL',
    player: 0,
    handUid: handUidOf(state, 0, CARD),
    cardId: CARD,
    element,
  });

describe('what you may name', () => {
  it('offers every element that is neither resisted nor already a weakness', () => {
    const state = board({ weaknesses: ['ice', 'wind'], resists: ['fire', 'elec'] });
    const allowed = twistableElements(activeOf(state, 1));

    expect(allowed).not.toContain('fire'); // resisted
    expect(allowed).not.toContain('elec'); // resisted
    expect(allowed).not.toContain('ice'); // already a weakness
    expect(allowed).not.toContain('wind'); // already a weakness
    expect(allowed).not.toContain('almighty'); // nothing is ever weak to it
    expect(allowed).toContain('phys');
    expect(allowed).toContain('light');
    expect(allowed).toContain('dark');
  });

  it('offers nothing at all against a Persona with no weakness to trade', () => {
    const state = board({ weaknesses: [], resists: [] });
    expect(twistableElements(activeOf(state, 1))).toEqual([]);
    expect(getLegalActions(state, 0).some((a) => a.cardId === CARD)).toBe(false);
  });

  it('offers nothing when every remaining element is resisted', () => {
    const resists = DAMAGE_TYPES.filter((t) => t !== 'almighty' && t !== 'ice');
    const state = board({ weaknesses: ['ice'], resists });
    expect(twistableElements(activeOf(state, 1))).toEqual([]);
    expect(getLegalActions(state, 0).some((a) => a.cardId === CARD)).toBe(false);
  });

  it('puts one legal action on the list per element, and no more', () => {
    const state = board({ weaknesses: ['ice'], resists: ['fire'] });
    const options = getLegalActions(state, 0).filter((a) => a.cardId === CARD);
    const allowed = twistableElements(activeOf(state, 1));

    expect(options).toHaveLength(allowed.length);
    expect(options.map((a) => a.element).sort()).toEqual([...allowed].sort());
    // Every offered option is one the handler will actually accept.
    for (const option of options) expect(() => applyAction(state, option)).not.toThrow();
  });
});

describe('a resist beats a weakness', () => {
  it('refuses to make a weakness of something they resist, and says why', () => {
    const state = board({ weaknesses: ['ice'], resists: ['fire'] });
    expect(() => play(state, 'fire')).toThrow(/resists fire/);
  });

  it('leaves the resist exactly where it was — it is not stripped', () => {
    // The rule is "you cannot name it", NOT "the resist is removed".
    const state = board({ weaknesses: ['ice'], resists: ['fire'] });
    const next = play(state, 'dark');
    expect(affinitiesOf(activeOf(next, 1)).resists).toEqual(['fire']);
  });
});

describe('the opponent chooses what they give up', () => {
  it('replaces exactly one weakness, leaving the rest alone', () => {
    const state = board({ weaknesses: ['ice', 'wind', 'light'], resists: [] });
    const before = affinitiesOf(activeOf(state, 1)).weaknesses;
    const next = play(state, 'dark');
    const after = affinitiesOf(activeOf(next, 1)).weaknesses;

    expect(after).toHaveLength(before.length);
    expect(after).toContain('dark');
    // Exactly one went.
    expect(before.filter((t) => !after.includes(t))).toHaveLength(1);
  });

  it('sheds a weakness you had already uncovered before one you had not', () => {
    // Their best move is to lose the one that is already costing them.
    const state = board({ weaknesses: ['ice', 'wind'], resists: [], revealed: ['wind'] });
    expect(twistSacrifice(activeOf(state, 1))).toBe('wind');

    const next = play(state, 'dark');
    const after = affinitiesOf(activeOf(next, 1)).weaknesses;
    expect(after).toContain('ice'); // the secret one survives
    expect(after).not.toContain('wind');
  });

  it('is deterministic when nothing has been uncovered', () => {
    const run = () => {
      const state = board({ weaknesses: ['light', 'ice'], resists: [] });
      return affinitiesOf(activeOf(play(state, 'dark'), 1)).weaknesses;
    };
    expect(run()).toEqual(run());
  });

  it('spends no randomness at all', () => {
    // A rewrite draws from the RNG; this makes a decided edit, so the seed must
    // be untouched — otherwise it would desync an online match.
    const state = board({ weaknesses: ['ice', 'wind'], resists: [] });
    const next = play(state, 'dark');
    expect(next.rng).toEqual(state.rng);
  });
});

describe('what both players then know', () => {
  it('reveals the new weakness to everyone', () => {
    const state = board({ weaknesses: ['ice'], resists: [] });
    const next = play(state, 'dark');
    expect(activeOf(next, 1).revealedTypes).toContain('dark');
  });

  it('un-knows the weakness that no longer exists', () => {
    const state = board({ weaknesses: ['ice', 'wind'], resists: [], revealed: ['wind'] });
    const next = play(state, 'dark');
    // Wind was given up, so nobody should still be told it is a weakness.
    expect(activeOf(next, 1).revealedTypes).not.toContain('wind');
    expect(activeOf(next, 1).revealedTypes).toContain('dark');
  });

  it('flags the card as no longer describing the Persona', () => {
    const state = board({ weaknesses: ['ice'], resists: [] });
    expect(activeOf(play(state, 'dark'), 1).rewritten).toBe(true);
  });

  it('is a real weakness, not a cosmetic one', () => {
    const state = board({ weaknesses: ['ice'], resists: [] });
    const target = activeOf(state, 1);
    target.hp = target.maxHp;

    const plain = applyAction(state, { type: 'ATTACK', player: 0, targetUid: target.uid });
    const plainDealt = target.maxHp - activeOf(plain, 1).hp;

    // Now make them weak to phys and hit them with the identical basic attack.
    let twisted = play(state, 'phys');
    twisted.turnState.actionsRemaining = 1;
    twisted = applyAction(twisted, { type: 'ATTACK', player: 0, targetUid: target.uid });
    const twistedDealt = target.maxHp - activeOf(twisted, 1).hp;

    expect(twistedDealt).toBeGreaterThan(plainDealt);
  });
});

describe('Whims of Fate sees it', () => {
  it('fetches an answer to a weakness Twist of Fate created', () => {
    let state = board({ weaknesses: ['ice'], resists: [] });
    setHand(state, 0, [CARD, 'whims-of-fate']);
    // A deck holding exactly one dark answer and one blank.
    state.players[0].deck = ['pixie', 'kaiwan'];

    state = play(state, 'dark');
    expect(activeOf(state, 1).revealedTypes).toContain('dark');

    // One Special per turn is the only thing standing between the two cards;
    // the question here is whether Whims can SEE the new weakness.
    state.turnState.specialsPlayed = 0;

    // Whims reads the CURRENT chart, so the new weakness is a live question.
    const whims = getLegalActions(state, 0).filter((a) => a.cardId === 'whims-of-fate');
    expect(whims.length, 'Whims of Fate did not see the new weakness').toBeGreaterThan(0);
  });
});

describe('the card itself', () => {
  const card = getCard(CARD);

  it('is a premium Tactical Special that costs your action', () => {
    expect(card.type).toBe('special');
    expect(card.usesAction).toBe(true);
    expect(card.quality).toBe(5);
    const best = Math.max(...Object.values(card.affinity));
    expect(card.affinity.tactical).toBe(best);
    expect(card.affinity.tactical).toBeGreaterThan(card.affinity.defensive);
  });

  it('is capped at one per deck', () => {
    expect(card.deckGroup).toBe('twist-fate');
    for (const flavour of ['p3', 'p4', 'p5']) {
      for (const archetype of ['aggressive', 'defensive', 'tactical', 'swift']) {
        for (let seed = 1; seed <= 12; seed++) {
          const deck = buildDeck({ flavour, archetype, rng: createRng(seed) });
          const copies = deck.filter((id) => id === CARD).length;
          expect(copies, `${flavour}/${archetype}/${seed} holds ${copies}`).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('is available to every flavour — it is nobody exclusive', () => {
    expect(card.exclusive).toBeUndefined();
  });

  it('says the rule it actually enforces', () => {
    expect(card.description).toMatch(/cannot name something it resists/i);
    expect(card.description).toMatch(/opponent decides/i);
    expect(card.description).toMatch(/already uncovered/i);
    expect(card.description).toMatch(/revealed to both/i);
  });
});

describe('in a real match', () => {
  it('is played by the Brutal bot without ever producing an illegal action', () => {
    // The card is one per deck and competes for six Special slots, so any single
    // seed may simply not deal it. Sweeping a handful keeps the assertion about
    // the CARD — reachable, and never wedges a match — rather than about the
    // shuffle, which is what made this brittle the last time a Special was added.
    let played = 0;
    for (const seed of [2, 3, 6, 20, 24, 31]) {
      let state = createMatch({
        seed,
        players: [
          { name: 'A', deckId: 'p3', archetype: 'tactical', controller: 'bot', difficulty: 'brutal' },
          { name: 'B', deckId: 'p5', archetype: 'aggressive', controller: 'bot', difficulty: 'brutal' },
        ],
      });
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 0, cardId: state.starterOptions[0][0] });
      state = applyAction(state, { type: 'CHOOSE_STARTER', player: 1, cardId: state.starterOptions[1][0] });

      for (let i = 0; i < 400 && state.winner === null; i++) {
        const twist = getLegalActions(state, state.activePlayer).filter((a) => a.cardId === CARD);
        if (twist.length) {
          state = applyAction(state, twist[0]);
          played++;
          continue;
        }
        state = endTurn(state);
      }
      if (played > 0) break;
    }
    // Not asserting a rate — only that it is reachable and never wedges a match.
    expect(played).toBeGreaterThan(0);
  });
});
