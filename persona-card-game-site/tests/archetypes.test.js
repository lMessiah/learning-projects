/**
 * Deck archetypes.
 *
 * Twelve decks from three flavours and four play styles, with no twelve lists
 * to maintain: the flavour picks the pool, the archetype weights it, and the
 * match seed rolls the 30 cards.
 */
import { describe, it, expect } from 'vitest';
import {
  ARCHETYPES,
  ARCHETYPE_IDS,
  DECK_SHAPE,
  DECK_SIZE,
  MAX_COPIES,
  buildDeck,
  expandDeck,
  poolFor,
  getArchetype,
  validateDecks,
  validateAll,
  completableRecipes,
  MIN_COMPLETABLE_RECIPES,
} from '../src/data/archetypes.js';
import { DECKS, getCard, ARCHETYPE_TAGS } from '../src/data/cards.js';
import { createMatch, createRng, CONFIG } from '../src/engine/index.js';

const FLAVOURS = DECKS.map((d) => d.id);

/** Mean affinity of a built deck toward one archetype. */
function leaning(cards, archetype) {
  return cards.reduce((sum, id) => sum + (getCard(id).affinity?.[archetype] ?? 0), 0) / cards.length;
}

describe('the archetype table', () => {
  it('matches the tags every card is validated against', () => {
    expect([...ARCHETYPE_IDS].sort()).toEqual([...ARCHETYPE_TAGS].sort());
    expect(ARCHETYPES).toHaveLength(4);
  });

  it('gives each one a name, an icon and a one-line description for the setup row', () => {
    for (const archetype of ARCHETYPES) {
      expect(archetype.name).toBeTruthy();
      expect(archetype.icon).toBeTruthy();
      expect(archetype.blurb.length).toBeGreaterThan(20);
      expect(getArchetype(archetype.id)).toBe(archetype);
    }
    expect(getArchetype('nope')).toBe(null);
  });
});

describe('deck generation', () => {
  it('builds a legal deck for every flavour and play style', () => {
    expect(validateDecks()).toEqual([]);
    expect(validateAll()).toEqual([]);

    for (const flavour of FLAVOURS) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        const cards = expandDeck(flavour, { archetype });
        expect(cards).toHaveLength(DECK_SIZE);

        const counts = new Map();
        for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const [, count] of counts) expect(count).toBeLessThanOrEqual(MAX_COPIES);

        for (const [type, quota] of Object.entries(DECK_SHAPE)) {
          expect(cards.filter((id) => getCard(id).type === type)).toHaveLength(quota);
        }
      }
    }
  });

  it('draws only from the flavour pool, never another game\'s exclusives', () => {
    for (const flavour of FLAVOURS) {
      const allowed = new Set(Object.values(poolFor(flavour)).flat().map((c) => c.id));
      for (const archetype of ARCHETYPE_IDS) {
        for (const id of expandDeck(flavour, { archetype })) expect(allowed.has(id)).toBe(true);
      }
    }
  });

  it('never puts a fusion-only or over-cap Persona in a deck', () => {
    for (const flavour of FLAVOURS) {
      for (const archetype of ARCHETYPE_IDS) {
        for (const id of expandDeck(flavour, { archetype })) {
          const card = getCard(id);
          if (card.type !== 'persona') continue;
          expect(card.fusionOnly).toBe(false);
          expect(card.level).toBeLessThanOrEqual(CONFIG.DECK_MAX_PERSONA_LEVEL);
        }
      }
    }
  });

  it('is deterministic: same seed and archetype, same 30 cards', () => {
    const a = buildDeck({ flavour: 'p3', archetype: 'swift', rng: createRng(555) });
    const b = buildDeck({ flavour: 'p3', archetype: 'swift', rng: createRng(555) });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).toEqual(b[1]); // and the RNG advances identically
  });

  it('rolls a different deck from a different seed', () => {
    const a = expandDeck('p3', { archetype: 'swift', seed: 1 });
    const b = expandDeck('p3', { archetype: 'swift', seed: 2 });
    expect(a).not.toEqual(b);
  });

  it('rejects an archetype it does not know', () => {
    expect(() => buildDeck({ flavour: 'p3', archetype: 'chaotic-evil', rng: createRng(1) })).toThrow(/Unknown deck archetype/);
  });
});

describe('the weighting actually bites', () => {
  /** Average leaning across many seeds, so this is not a coin-flip assertion. */
  function averageLeaning(flavour, archetype, axis) {
    let total = 0;
    for (let seed = 1; seed <= 25; seed++) total += leaning(expandDeck(flavour, { archetype, seed }), axis);
    return total / 25;
  }

  it('leans each deck toward its own play style more than any other does', () => {
    for (const flavour of FLAVOURS) {
      for (const archetype of ARCHETYPE_IDS) {
        const own = averageLeaning(flavour, archetype, archetype);
        for (const other of ARCHETYPE_IDS) {
          if (other === archetype) continue;
          const rival = averageLeaning(flavour, other, archetype);
          expect(own, `${flavour}: ${archetype} deck vs ${other} deck on the ${archetype} axis`).toBeGreaterThan(rival);
        }
      }
    }
  });

  it('leans further than the unweighted pool draw', () => {
    for (const archetype of ARCHETYPE_IDS) {
      expect(averageLeaning('p5', archetype, archetype)).toBeGreaterThan(averageLeaning('p5', null, archetype));
    }
  });

  it('still leaves variety: no archetype produces one fixed list', () => {
    const a = expandDeck('p4', { archetype: 'aggressive', seed: 11 });
    const b = expandDeck('p4', { archetype: 'aggressive', seed: 12 });
    expect(new Set(a)).not.toEqual(new Set(b));
  });
});

describe('every deck can actually fuse', () => {
  it('guarantees at least two completable recipes in every generated deck', () => {
    for (const flavour of FLAVOURS) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        for (let seed = 1; seed <= 12; seed++) {
          const reachable = completableRecipes(expandDeck(flavour, { archetype, seed }));
          expect(reachable.length, `${flavour}/${archetype}/${seed}`).toBeGreaterThanOrEqual(
            MIN_COMPLETABLE_RECIPES
          );
        }
      }
    }
  });

  it('judges reachability on arcana AND a realistic mid-game level', () => {
    // Right arcana, nowhere near the level bar: Satanael wants Fool + Devil at
    // combined 46, and Orpheus (4) + Incubus (12) cannot get there.
    expect(completableRecipes(['orpheus', 'incubus']).map((r) => r.id)).not.toContain('fuse-satanael');
    // Arcana that no recipe pairs at all.
    expect(completableRecipes(['pixie', 'jack-frost'])).toHaveLength(0);
    // A single body is not a pair.
    expect(completableRecipes(['pixie'])).toHaveLength(0);
    // Lovers + Star, comfortably over the bar.
    expect(completableRecipes(['pixie', 'anzu']).map((r) => r.id)).toContain('fuse-titania');
  });

  it('repairs without breaking the deck shape or the copy limit', () => {
    for (const flavour of FLAVOURS) {
      for (const archetype of ARCHETYPE_IDS) {
        const cards = expandDeck(flavour, { archetype, seed: 5 });
        expect(cards).toHaveLength(DECK_SIZE);
        const counts = new Map();
        for (const id of cards) counts.set(id, (counts.get(id) ?? 0) + 1);
        for (const [, count] of counts) expect(count).toBeLessThanOrEqual(MAX_COPIES);
        for (const [type, quota] of Object.entries(DECK_SHAPE)) {
          expect(cards.filter((id) => getCard(id).type === type)).toHaveLength(quota);
        }
      }
    }
  });

  it('still leans toward its archetype after the repair', () => {
    // The repair swaps the most redundant slots, so it must not wash the
    // archetype out of the deck.
    const own = leaning(expandDeck('p5', { archetype: 'aggressive', seed: 3 }), 'aggressive');
    const rival = leaning(expandDeck('p5', { archetype: 'defensive', seed: 3 }), 'aggressive');
    expect(own).toBeGreaterThan(rival);
  });
});

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe('archetypes in a match', () => {
  const match = (archetypes) =>
    createMatch({
      seed: 4242,
      players: [
        { name: 'A', deckId: 'p3', archetype: archetypes[0] },
        { name: 'B', deckId: 'p4', archetype: archetypes[1] },
      ],
    });

  it('records each player\'s choice on the state', () => {
    const state = match(['aggressive', 'defensive']);
    expect(state.players[0].archetype).toBe('aggressive');
    expect(state.players[1].archetype).toBe('defensive');
  });

  it('deals decks that reflect the choice', () => {
    // Averaged over seeds rather than asserted on one: a deck is 30 weighted
    // draws plus a handful of guaranteed cards (fusion material, the flavour's
    // rewrite Special), and any single deal can be dragged either way by those.
    // The claim worth making is about the weighting, not about one shuffle.
    const across = (archetype, measured) =>
      mean(
        [4242, 7, 99, 1234, 31337].map((seed) =>
          leaning(
            createMatch({
              seed,
              players: [
                { name: 'A', deckId: 'p3', archetype },
                { name: 'B', deckId: 'p4', archetype },
              ],
            }).players[0].deck,
            measured
          )
        )
      );

    expect(across('aggressive', 'aggressive')).toBeGreaterThan(across('aggressive', 'defensive'));
    expect(across('defensive', 'defensive')).toBeGreaterThan(across('defensive', 'aggressive'));
  });

  it('reproduces the same match from the same seed and choices', () => {
    expect(match(['swift', 'tactical']).players.map((p) => p.deck)).toEqual(
      match(['swift', 'tactical']).players.map((p) => p.deck)
    );
  });

  it('still deals 30 cards with no archetype at all', () => {
    const state = match([null, null]);
    for (const player of state.players) expect(player.deck).toHaveLength(DECK_SIZE);
  });
});

describe('the counter to a memorised database is always dealt', () => {
  const SIGNATURE = { p3: 'turn-of-the-moon', p4: 'jesters-trickery', p5: 'change-of-heart' };

  it("puts every flavour's affinity-rewrite Special in every deck it builds", () => {
    // A counter you hold a third of the time is a lucky break, not a counter —
    // and this one is the answer both to memorising the card database and to
    // the Brutal bot reading it. So it is guaranteed rather than weighted.
    for (const [flavour, id] of Object.entries(SIGNATURE)) {
      for (const archetype of [null, ...ARCHETYPE_IDS]) {
        for (let seed = 1; seed <= 20; seed++) {
          expect(expandDeck(flavour, { archetype, seed }), `${flavour}/${archetype}/${seed}`).toContain(id);
        }
      }
    }
  });

  it('never takes more than one copy, or more than its share of Special slots', () => {
    for (const [flavour, id] of Object.entries(SIGNATURE)) {
      for (const archetype of ARCHETYPE_IDS) {
        for (let seed = 1; seed <= 20; seed++) {
          const cards = expandDeck(flavour, { archetype, seed });
          expect(cards.filter((c) => c === id).length).toBeLessThanOrEqual(MAX_COPIES);
          expect(cards.filter((c) => getCard(c).type === 'special')).toHaveLength(DECK_SHAPE.special);
        }
      }
    }
  });

  it('leaves the fusion guarantee intact', () => {
    for (const flavour of FLAVOURS) {
      for (const archetype of ARCHETYPE_IDS) {
        for (let seed = 1; seed <= 12; seed++) {
          expect(completableRecipes(expandDeck(flavour, { archetype, seed })).length).toBeGreaterThanOrEqual(
            MIN_COMPLETABLE_RECIPES
          );
        }
      }
    }
  });
});
