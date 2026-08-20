/**
 * Story Mode — the trophy definitions.
 *
 * ── The shape ─────────────────────────────────────────────────────────────
 *
 * Each trophy is `{ id, name, description, trigger }`, where `trigger` is a
 * predicate over the context built at the end of every story battle. Add one by
 * adding an entry; nothing else needs touching. The order here is the order the
 * shelf displays them in.
 *
 * `trigger` receives:
 *
 *   battle        the campaign entry just played
 *   won           did the player win it
 *   match         what happened in that one match (see trophyWatch.js):
 *                   oneMores, fusions, gallows, technicals, weaknessHits
 *                   personasLost      knockouts suffered
 *                   longestOneMore    most One Mores in a single turn
 *                   biggestPhysHit    hardest single Phys action, in damage
 *                   lowestHpFraction  worst the player's field ever got, 0..1
 *   lossesBefore  losses on this battle before this attempt (0 = first try)
 *   progress      the story record, AFTER this result was written down
 *
 * ── Why the thresholds are constants ──────────────────────────────────────
 *
 * Wallbreaker and Comeback are the two that need a number rather than a fact,
 * and both numbers are guesses until the campaign is tuned. They are named and
 * exported so they can be moved without reading any of the logic below.
 */
import { BATTLE_COUNT, CHECKPOINT_AFTER_BATTLE, isBoss } from './campaign.js';

/** "A single large Phys hit" — damage in one action. */
export const WALLBREAKER_PHYS_DAMAGE = 120;

/** "Below 25% HP" — as a fraction of the player's total field HP. */
export const COMEBACK_HP_FRACTION = 0.25;

/** "A 3-hit One More chain" — One Mores granted within one turn. */
export const CHAIN_REACTION_LENGTH = 3;

/**
 * The battle that reveals the shelf.
 *
 * Named rather than inlined because two places care: the trophy that fires on
 * it, and the campaign map deciding whether to show a Trophy Shelf button.
 */
export const SHELF_TROPHY_ID = 'unlock-the-trophy-shelf';

export const TROPHIES = Object.freeze([
  {
    id: SHELF_TROPHY_ID,
    name: 'Unlock the Trophy Shelf',
    description: 'Clear the first battle of the night.',
    icon: '🗝️',
    trigger: ({ won, battle }) => won && battle.number === 1,
  },
  {
    id: 'half-moon',
    name: 'Half Moon',
    description: 'Reach the checkpoint.',
    icon: '🌗',
    trigger: ({ won, battle }) => won && battle.number === CHECKPOINT_AFTER_BATTLE,
  },
  {
    id: 'nightfall',
    name: 'Nightfall',
    description: 'Finish the deck-identity block — tempo, wall-breaking and attrition.',
    icon: '🌌',
    // The last battle before the finale, whatever number that ends up being.
    trigger: ({ won, battle }) => won && battle.number === BATTLE_COUNT - 1,
  },
  {
    id: 'dawn',
    name: 'Dawn',
    description: 'Defeat Nyx and end the night.',
    icon: '🌅',
    trigger: ({ won, battle }) => won && battle.number === BATTLE_COUNT,
  },
  {
    id: 'first-blood',
    name: 'First Blood',
    description: 'Land your first One More.',
    icon: '🩸',
    // Not gated on winning: you did the thing, whatever happened afterwards.
    trigger: ({ match }) => match.oneMores >= 1,
  },
  {
    id: 'chain-reaction',
    name: 'Chain Reaction',
    description: `Take ${CHAIN_REACTION_LENGTH} One Mores in a single turn.`,
    icon: '⛓️',
    trigger: ({ match }) => match.longestOneMore >= CHAIN_REACTION_LENGTH,
  },
  {
    id: 'alchemist',
    name: 'Alchemist',
    description: 'Perform your first fusion.',
    icon: '⚗️',
    trigger: ({ match }) => match.fusions >= 1,
  },
  {
    id: 'wallbreaker',
    name: 'Wallbreaker',
    description: `Beat the Silent Wall with a single Phys hit of ${WALLBREAKER_PHYS_DAMAGE} or more.`,
    icon: '🔨',
    // Keyed to the battle that hands out the Wallbreaker deck, so re-ordering
    // the campaign cannot leave this pointing at a fight with no Phys in it.
    trigger: ({ won, battle, match }) =>
      won && battle.playerDeck === 'WALLBREAKER_DECK' && match.biggestPhysHit >= WALLBREAKER_PHYS_DAMAGE,
  },
  {
    id: 'untouchable',
    name: 'Untouchable',
    description: 'Win a battle without losing a single Persona.',
    icon: '🛡️',
    trigger: ({ won, match }) => won && match.personasLost === 0,
  },
  {
    id: 'comeback',
    name: 'Comeback',
    description: `Win a battle after falling below ${Math.round(COMEBACK_HP_FRACTION * 100)}% HP.`,
    icon: '🔥',
    trigger: ({ won, match }) => won && match.lowestHpFraction <= COMEBACK_HP_FRACTION,
  },
  {
    id: 'flawless-night',
    name: 'Flawless Night',
    description: 'Clear a boss on your first attempt, with no retries spent.',
    icon: '✨',
    trigger: ({ won, battle, lossesBefore }) => won && isBoss(battle.number) && lossesBefore === 0,
  },
  {
    id: 'no-continues',
    name: 'No Continues',
    description: 'Clear the whole night without ever spending a retry.',
    icon: '👑',
    trigger: ({ won, battle, progress }) => won && battle.number === BATTLE_COUNT && progress.retriesUsed === 0,
  },
]);

export const TROPHY_IDS = Object.freeze(TROPHIES.map((t) => t.id));

/** One trophy by id, or null. */
export function getTrophy(id) {
  return TROPHIES.find((t) => t.id === id) ?? null;
}

/**
 * Every trophy whose trigger fires on this context and is not already held.
 *
 * A trigger that throws is treated as "did not fire" rather than being allowed
 * to take the result screen down with it: a broken achievement is a disappointment,
 * a broken result screen is a lost match.
 */
export function earnedBy(context, alreadyHeld = new Set()) {
  const earned = [];
  for (const trophy of TROPHIES) {
    if (alreadyHeld.has(trophy.id)) continue;
    try {
      if (trophy.trigger(context)) earned.push(trophy);
    } catch (error) {
      console.error(`Trophy "${trophy.id}" trigger threw`, error);
    }
  }
  return earned;
}
