/**
 * Story Mode — the decks the campaign hands the player.
 *
 * The campaign teaches deck identity by *assigning* one, fight by fight, rather
 * than letting the player bring the same comfortable pile to all seven battles.
 * Battle 6 wants you holding the Phys deck, because "beat the wall with one
 * enormous hit" is not a lesson you can learn from behind a healer.
 *
 * Every battle in campaign.js names one of these ids, or PLAYER_CHOICE.
 *
 * ── Placeholder contents ──────────────────────────────────────────────────
 *
 * A loadout is currently a *flavour plus an archetype*, which is the same pair
 * the deck builder already takes everywhere else in the app: it rolls 30 cards
 * from the match seed, weighted toward the archetype. That is deliberately
 * placeholder. `cards: null` is the seam — when the real contents are authored,
 * an explicit card list goes there and `resolvePlayerDeck` below is the single
 * place that has to learn to read it. Nothing else in the mode looks at a deck.
 *
 * The three flavours were not picked by vibe. From the shipped card database:
 *
 *   p4  avg STR 22.3, 14 Phys skills, top power 132   <- the Phys deck
 *   p3  avg STR 16.4,  5 Phys skills, steady healers  <- the forgiving one
 *   p5  avg STR 15.3, "probe for weaknesses, swap
 *                      into the counter, hit once"    <- the One More engine
 *
 * tests/story.test.js pins those claims against the database, so a balance pass
 * that moves them fails here rather than quietly making Battle 6 unteachable.
 */
import { DECKS } from '../../data/cards.js';
import { ARCHETYPES } from '../../data/archetypes.js';

/**
 * The battle hands the player nothing and opens the deck-select screen instead.
 *
 * A sentinel rather than `null`, so that a battle which simply forgot to name a
 * deck is a visible mistake the campaign test catches, not an accidental
 * free choice.
 */
export const PLAYER_CHOICE = 'PLAYER_CHOICE';

export const LOADOUTS = Object.freeze({
  STARTER_DECK: {
    id: 'STARTER_DECK',
    name: 'Velvet Starter',
    icon: '🃏',
    blurb: 'One Persona for every element, a healer, and the two halves of a fusion.',
    teaches: 'Weakness, One More, swapping and fusion — the things every deck does.',
    deckId: 'p3',
    archetype: 'tactical',
    /**
     * Built, not rolled — every fundamentals fight needs a specific tool.
     *
     *   Orpheus       the assigned starter: Agi (fire) and Bash (phys), and a
     *                 heal. Battle 2's weakness lesson is aimed at his Agi.
     *   Jack Frost /  ice, which is Battle 3's answer once fire stops working.
     *   Apsaras       Battle 3 is unwinnable in reasonable time without them.
     *   Pixie /       elec and healing, so the deck has a third element and a
     *   Izanagi       body that can take a turn off.
     *   Angel         the only light in the deck, and a second healer.
     *   Silky +       Priestess and Hierophant, combined level 24 — exactly the
     *   Omoikane      Kikuri-Hime recipe Battle 4 is built around. Two copies
     *                 each so the fusion is reliable, not a draw you pray for.
     *   Nekomata      a heavier body to grow into once knockouts start landing.
     *
     * tests/story.content.test.js checks all of that against the card database
     * rather than trusting this comment.
     */
    cards: [
      // 16 Personas
      'orpheus', 'orpheus',
      'jack-frost', 'jack-frost',
      'apsaras', 'apsaras',
      'pixie', 'pixie',
      'izanagi', 'izanagi',
      'silky', 'silky',
      'omoikane', 'omoikane',
      'angel',
      'nekomata',
      // 8 Items
      'medicine', 'medicine',
      'snuff-soul', 'snuff-soul',
      'bead',
      'revival-bead',
      'muscle-drink',
      'smoke-bomb',
      // 6 Specials
      'baton-pass', 'baton-pass',
      'charge',
      'concentrate',
      'third-eye',
      'fortunes-draw',
    ],
  },

  TEMPO_DECK: {
    id: 'TEMPO_DECK',
    name: 'Tempo',
    icon: '💨',
    blurb: 'Probe for a weakness, swap into the counter, and act twice for every once they do.',
    teaches: 'Chaining One Mores, and why acting more often beats hitting harder.',
    deckId: 'p5',
    archetype: 'swift',
    cards: null,
  },
  WALLBREAKER_DECK: {
    id: 'WALLBREAKER_DECK',
    name: 'Wallbreaker',
    icon: '🔨',
    blurb: 'The heaviest Strength in the game and the biggest Phys skills to spend it on.',
    teaches: 'Building one enormous Phys hit, and spending it on the turn it breaks something.',
    deckId: 'p4',
    archetype: 'aggressive',
    cards: null,
  },
  STALL_DECK: {
    id: 'STALL_DECK',
    name: 'Siege',
    icon: '🛡️',
    blurb: 'Endurance, heals, and a wall that cannot be knocked down while it is healthy.',
    teaches: 'Surviving an opening you cannot win, and winning the game that comes after it.',
    deckId: 'p5',
    archetype: 'defensive',
    cards: null,
  },
});

export const LOADOUT_IDS = Object.freeze(Object.keys(LOADOUTS));

/**
 * The explicit 30-card list for a loadout, or null to let the engine roll one.
 *
 * The one place `cards` is read. A loadout that has not been authored yet falls
 * through to the seeded builder exactly as before, so the teaching decks can be
 * written one at a time without the others breaking.
 */
export function deckCardsFor(loadout) {
  return loadout?.cards ?? null;
}

/** One loadout by id. Null for PLAYER_CHOICE or anything unknown. */
export function getLoadout(id) {
  return LOADOUTS[id] ?? null;
}

/** Is this a value a battle's `playerDeck` field is allowed to hold? */
export function isPlayerDeckValue(value) {
  return value === PLAYER_CHOICE || Object.hasOwn(LOADOUTS, value);
}

/**
 * What the player actually brings to a battle.
 *
 * `chosen` is the deck-select screen's answer, and is only consulted when the
 * battle asks for one. An assigned battle ignores it completely — that is the
 * whole point of assigning.
 *
 * @returns { deckId, archetype, loadout, chosen } — `loadout` is null when the
 *          player picked, `chosen` is true in the same case. Callers use those
 *          to caption the screen; the engine only ever sees the first two.
 */
export function resolvePlayerDeck(battle, chosen) {
  const loadout = getLoadout(battle?.playerDeck);
  if (loadout) {
    // When `cards` stops being null, it gets read here and nowhere else.
    return { deckId: loadout.deckId, archetype: loadout.archetype, loadout, chosen: false };
  }
  return {
    deckId: DECKS.some((d) => d.id === chosen?.deckId) ? chosen.deckId : DECKS[0].id,
    archetype: ARCHETYPES.some((a) => a.id === chosen?.archetype) ? chosen.archetype : ARCHETYPES[0].id,
    loadout: null,
    chosen: true,
  };
}
