/**
 * Building a story battle.
 *
 * A campaign fight has to be the same fight every time, or the lesson it is
 * built around is a coincidence. "The Exposed" teaches weakness by fielding an
 * opponent with one glaring weakness and no answer to it — which is only true
 * if the opponent is *authored* rather than dealt.
 *
 * ── Why this writes to the state directly ─────────────────────────────────
 *
 * The same argument as ui/tutorial/scenario.js, and the same constraints. There
 * is no legal sequence of moves producing "turn 1, and the opponent happens to
 * be holding a level 22 Unicorn"; the alternative would be engine actions that
 * exist only so the campaign can cheat, which is a worse thing to put in the
 * rules than a fixture builder is to put in the UI.
 *
 *   1. It runs ONCE, before the board is mounted and before any action is
 *      applied. From the first click onward the battle is an ordinary match.
 *   2. It builds on a real `createMatch` and real `CHOOSE_STARTER` actions, so
 *      the phase transition, the decks, the turn state and the opening draw are
 *      all the engine's work.
 *   3. It writes only `deck`, `field`, `activeUid`, `hand` and `config.KO_TARGET`
 *      — never turn budgets, never the RNG, never the log.
 *
 * ── What a battle may specify ─────────────────────────────────────────────
 *
 * Everything below is optional; a battle that specifies none of it is exactly
 * the seeded random match the campaign shipped with before.
 *
 *   koTarget       knockouts needed to win THIS match, both ways
 *   playerStarter  the Persona the player begins on
 *   playerHand     an authored opening hand, for a fight whose lesson needs a
 *                  specific card to be reachable (fusion material, mainly)
 *   playerField    an authored opening board, for a fight the player cannot be
 *                  expected to survive while assembling one
 *   opponent.field [{ cardId, level?, hp?, maxHp?, sp?, active? }]
 *   opponent.deck  an explicit card list, so a boss draws what it was built to
 *   opponent.starter / opponent.hand — as above, for the other side
 */
import { createMatch, applyAction, createPersonaInstance, levelUp, CONFIG } from '../../engine/index.js';
import { getCard } from '../../data/cards.js';
import { deckCardsFor, resolvePlayerDeck } from './decks.js';

const HUMAN = 0;
const BOT = 1;

/**
 * @param battle  a campaign entry (campaign.js)
 * @param player  the resolved player deck ({ deckId, archetype }) — see decks.js
 * @param name    the player's display name
 */
export function buildStoryBattle(battle, player, name) {
  const setup = battle.setup ?? {};

  let state = createMatch({
    seed: battle.seed,
    players: [
      { name, deckId: player.deckId, archetype: player.archetype, controller: 'human' },
      {
        name: battle.opponent,
        deckId: battle.deckId,
        archetype: battle.archetype,
        controller: 'bot',
        difficulty: battle.difficulty,
      },
    ],
  });

  // How long this battle runs. Written before anything can be knocked out, so
  // the very first evaluation already reads the battle's own number.
  if (setup.koTarget) state.config = { ...state.config, KO_TARGET: setup.koTarget };

  // An authored deck replaces the generated one wholesale. It is used in the
  // order given — a boss that opens on the same threat every time is a boss the
  // player can learn, which is the entire point of the campaign.
  const playerCards = deckCardsFor(player.loadout);
  if (playerCards) state.players[HUMAN].deck = [...playerCards];
  if (setup.opponent?.deck) state.players[BOT].deck = [...setup.opponent.deck];

  // Starters go through the engine, so it does the phase transition, the
  // opening draw and the first turn's setup. The offer is narrowed to the card
  // the battle wants, which CHOOSE_STARTER then validates as normal.
  const starters = [setup.playerStarter ?? null, setup.opponent?.starter ?? null];
  for (let i = 0; i < 2; i++) {
    const wanted = starters[i];
    // The player keeps a real choice unless the battle insists: narrowing the
    // offer to one card turns a decision into a formality, and only the fights
    // whose lesson depends on the opening Persona are allowed to do that.
    if (wanted) state.starterOptions[i] = [wanted];
    const chosen = wanted ?? state.starterOptions[i][0];
    state = applyAction(state, { type: 'CHOOSE_STARTER', player: i, cardId: chosen });
  }

  // From here the board is painted. Everything above was the engine's.
  if (setup.playerField) setField(state, HUMAN, setup.playerField);
  if (setup.opponent?.field) setField(state, BOT, setup.opponent.field);
  if (setup.playerHand) setHand(state, HUMAN, setup.playerHand);
  if (setup.opponent?.hand) setHand(state, BOT, setup.opponent.hand);

  return state;
}

/**
 * Paint a field, with Personas that are genuinely the level they claim.
 *
 * `createPersonaInstance`'s `level` option sets the NUMBER and nothing else —
 * stats stay printed. That is fine for a unit test asserting a formula and
 * quietly wrong for a boss: a "level 22" Unicorn carrying level-4 Endurance is
 * a wall made of tissue paper, and every damage figure the fight was tuned
 * around would be off.
 *
 * So levels are applied through `levelUp`, the same path a knockout uses. The
 * log lines it emits are trimmed afterwards — this is board construction, not
 * something that happened in the match.
 */
function setField(state, playerId, specs) {
  const player = state.players[playerId];
  player.field = [];
  player.activeUid = null;
  const logMark = state.log.length;

  for (const spec of specs) {
    const persona = createPersonaInstance(state, spec.cardId, playerId, {
      inheritedSkills: spec.inheritedSkills,
      passive: spec.passive,
    });
    const target = spec.level ?? persona.level;
    if (target > persona.level) levelUp(state, persona, target - persona.level);

    // Stat overrides come last, so a battle can dial a boss in without fighting
    // the growth just applied to it.
    //
    // These are the tuning knobs. A boss is a printed card plus a level plus
    // whatever this block says, and that is deliberately the whole vocabulary:
    // Titania at magic 26 kills a starting board before fusion is even legal,
    // and at magic 14 she is a wall you have time to answer. Nothing else about
    // the fight had to change to find that out.
    for (const stat of ['strength', 'magic', 'endurance']) {
      if (spec[stat] != null) persona[stat] = spec[stat];
    }
    if (spec.maxHp != null) persona.maxHp = spec.maxHp;
    if (spec.hp != null) persona.hp = spec.hp;
    else persona.hp = Math.min(persona.hp, persona.maxHp);
    if (spec.maxSp != null) persona.maxSp = spec.maxSp;
    if (spec.sp != null) persona.sp = spec.sp;

    player.field.push(persona);
    if (spec.active) player.activeUid = persona.uid;
  }

  state.log.length = logMark;
  if (!player.activeUid && player.field.length) player.activeUid = player.field[0].uid;
}

function setHand(state, playerId, cardIds) {
  state.players[playerId].hand = cardIds.map((cardId) => ({ uid: `s${state.nextUid++}`, cardId }));
}

/**
 * Validate an authored deck against the rules a generated one already obeys.
 *
 * Used by the tests rather than at runtime: a malformed teaching deck should
 * fail the build, not surprise a player thirty turns into a campaign.
 */
export function checkDeck(cards) {
  const errors = [];
  if (!Array.isArray(cards)) return ['not an array'];

  const counts = new Map();
  const byType = { persona: 0, item: 0, special: 0 };
  for (const id of cards) {
    const card = getCard(id);
    if (!card) {
      errors.push(`unknown card "${id}"`);
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
    byType[card.type] = (byType[card.type] ?? 0) + 1;
    if (card.type === 'persona' && card.level > CONFIG.DECK_MAX_PERSONA_LEVEL) {
      errors.push(`${id} is level ${card.level}, above the deck cap of ${CONFIG.DECK_MAX_PERSONA_LEVEL}`);
    }
  }
  for (const [id, n] of counts) {
    if (n > 2) errors.push(`${n} copies of ${id} (max 2)`);
  }
  return errors.concat(shapeErrors(byType, cards.length));
}

function shapeErrors(byType, total) {
  const errors = [];
  if (total !== 30) errors.push(`${total} cards, expected 30`);
  for (const [type, want] of [['persona', 16], ['item', 8], ['special', 6]]) {
    if (byType[type] !== want) errors.push(`${byType[type] ?? 0} ${type} cards, expected ${want}`);
  }
  return errors;
}

export { resolvePlayerDeck };
