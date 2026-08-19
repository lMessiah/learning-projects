/**
 * Bot playstyles — the second axis under difficulty.
 *
 * Difficulty says how *well* the bot plays. A playstyle says what it is
 * TRYING to do, and it is a separate question: a Brutal Defensive bot and a
 * Brutal Combo bot are both playing at full strength toward opposite plans.
 *
 * Three of them are built around a signature Persona and its flavour, so the
 * player can practise against a known plan:
 *
 *   Defensive   P5 · Ara Mitama   retreats, rebuilds, and refuses to trade
 *   All-Rounder P4 · Slime        rotates constantly into the right matchup
 *   Combo       P3 · Pixie        banks turns on the Gallows, then cashes them
 *
 * Measured over 160 seeded matches per style against the same Brutal control,
 * each on its own shipped deck — win rate, match length, and the behaviour that
 * is its fingerprint:
 *
 *   Normal       54.4%   40.5 turns    7.8 rotations,  5.1 Gallows
 *   Defensive    45.6%   46.5 turns   10.2 rotations,  22.5 attacks
 *   All-Rounder  75.0%   34.7 turns   23.5 rotations,  the shortest matches
 *   Combo        54.4%   43.4 turns    9.1 Gallows,    the fewest attacks
 *
 * All four are playable and all four look different from across the table,
 * which is the bar. All-Rounder being the strongest is not a thumb on the
 * scale: rotation is free, and the base bot simply under-uses it.
 *
 * ...plus Normal (the original behaviour, no forced deck) and Random, which
 * picks one of the others and does not say which.
 *
 * ── How the bias works ────────────────────────────────────────────────────
 *
 * A playstyle is NOT a second scorer. It is a multiplier and a bonus laid over
 * the scores `bot.js` already produced, and it obeys one rule:
 *
 *   **A playstyle can amplify an action the scorer already rates positively.
 *   It can never resurrect one the scorer rejected.**
 *
 * That rule is what keeps a playstyle from being a way to play badly. The
 * scorer still refuses to attack into a resist, still sees a lethal blow, and
 * still treats an empty field as an emergency worth 1000 points — no bias here
 * is anywhere near large enough to outbid that, which is deliberate: a
 * Defensive bot that stalled its way into losing on the empty-field clock would
 * be a bug, not a playstyle.
 *
 * Pure and deterministic like the rest of the engine: no DOM, no Math.random().
 */
import { getCard, getSkillDefinition } from '../data/cards.js';
import { nextInt } from './rng.js';

/** No opinion — score passes through untouched. */
const NEUTRAL = Object.freeze({ mult: 1, bonus: 0 });

export const PLAYSTYLES = Object.freeze([
  {
    id: 'normal',
    label: 'Normal',
    icon: '🎲',
    blurb: 'No plan beyond winning. Takes a deck you did not pick, at random.',
    deckId: null,
    starter: null,
  },
  {
    id: 'defensive',
    label: 'Defensive',
    icon: '🛡️',
    blurb: 'Ara Mitama, a wide board, and constant retreats. Drags matches out and refuses to trade.',
    deckId: 'p5',
    starter: 'ara-mitama',
  },
  {
    id: 'allrounder',
    label: 'All-Rounder',
    icon: '⚖️',
    blurb: 'Slime, and relentless rotation — always standing behind whatever answers you.',
    deckId: 'p4',
    starter: 'slime',
  },
  {
    id: 'combo',
    label: 'Combo',
    icon: '🎇',
    blurb: 'Feeds the Gallows twice as often as anyone, fattening a Pixie — then spends it all at once.',
    deckId: 'p3',
    starter: 'pixie',
  },
  {
    id: 'random',
    label: 'Random',
    icon: '❓',
    blurb: 'One of the other four. You are not told which, and the deck is hidden too.',
    deckId: null,
    starter: null,
    // Never a resolved playstyle in its own right — see resolvePlaystyle.
    meta: true,
  },
]);

export const PLAYSTYLE_IDS = Object.freeze(PLAYSTYLES.map((p) => p.id));

/** The ones Random may actually land on. */
export const CONCRETE_PLAYSTYLES = Object.freeze(PLAYSTYLES.filter((p) => !p.meta));

export function getPlaystyle(id) {
  return PLAYSTYLES.find((p) => p.id === id) ?? PLAYSTYLES[0];
}

/**
 * Turn a chosen playstyle into the one the bot will actually run.
 *
 * Only 'random' does anything here, and it consumes RNG — so the resolution has
 * to happen once, at match setup, and be stored. Resolving per action would
 * give the bot a new personality every turn.
 *
 * @returns {[string, object]} the resolved id and the advanced RNG
 */
export function resolvePlaystyle(id, rng) {
  if (id !== 'random') return [getPlaystyle(id).id, rng];
  const [index, next] = nextInt(rng, CONCRETE_PLAYSTYLES.length);
  return [CONCRETE_PLAYSTYLES[index].id, next];
}

/* ------------------------------------------------------------------ *
 * Action classification
 * ------------------------------------------------------------------ */

/**
 * What an action is *for*, as far as a playstyle cares.
 *
 * Deliberately coarse. A playstyle is a lean, not a rulebook, and a fine-
 * grained taxonomy here would just be a second copy of the scorer that could
 * disagree with the first.
 */
function effectOf(action) {
  if (action.type === 'USE_SKILL') return getSkillDefinition(action.skillId)?.effect ?? null;
  if (action.type === 'PLAY_ITEM' || action.type === 'PLAY_SPECIAL') {
    return getCard(action.cardId)?.effect ?? null;
  }
  return null;
}

const isDamage = (action) => {
  if (action.type === 'ATTACK') return true;
  const effect = effectOf(action);
  return effect ? effect.kind === 'damage' : false;
};

const isRestorative = (action) => {
  const effect = effectOf(action);
  return effect ? ['heal', 'fullRestore', 'cureAilments', 'restoreSp', 'revive'].includes(effect.kind) : false;
};

/** A buff that makes you harder to kill: your defence up, or their attack down. */
const isDefensiveBuff = (action) => {
  const effect = effectOf(action);
  if (!effect || effect.kind !== 'buff') return false;
  return (
    (effect.stat === 'def' && effect.direction === 'up') ||
    (effect.stat === 'atk' && effect.direction === 'down')
  );
};

/** A buff that makes a blow bigger: your attack up, or their defence down. */
const isOffensiveBuff = (action) => {
  const effect = effectOf(action);
  if (!effect || effect.kind !== 'buff') return false;
  return (
    (effect.stat === 'atk' && effect.direction === 'up') ||
    (effect.stat === 'def' && effect.direction === 'down')
  );
};

/** Charge / Concentrate — banked damage, the combo plan's other half. */
const isCharge = (action) => effectOf(action)?.kind === 'charge';

/**
 * Actions that cost nothing at all (SPEC §2.3): playing a Persona and changing
 * your active. They are the one place a playstyle may promote a move the
 * scorer rated at exactly zero.
 *
 * The reason is that "zero" means something different for a free action. For an
 * action that costs your turn, zero means *not worth the turn* and promoting it
 * would be playing badly. For a free one, zero only means "the scorer sees no
 * specific reason" — and a playstyle IS a reason. Without this carve-out
 * All-Rounder was measurably identical to Normal: 7.8 rotations a match against
 * 7.9, because the swap it wanted to make almost always scored exactly zero.
 */
const FREE_TYPES = new Set(['CHANGE_ACTIVE', 'PLAY_PERSONA']);

/** A Skill Card: permanent, and the reason a combo bot is worth fearing later. */
const isTeach = (action) => effectOf(action)?.kind === 'teachSkill';

/* ------------------------------------------------------------------ *
 * The playstyles themselves
 * ------------------------------------------------------------------ */

/**
 * Each entry maps an action to `{ mult, bonus }`.
 *
 * ── Prefer the multiplier. Use a bonus only where a multiplier cannot work. ──
 *
 * This is the rule that makes the difference between a playstyle and a
 * handicap, and it was learned the expensive way. The base scorer already
 * encodes *when* a move is good: Guard is worth 18 to a Persona under 30% HP
 * and 2 to a healthy one. A MULTIPLIER preserves that — ×3 turns those into 54
 * and 6, so the bot guards hard when hurt and barely when fine. A flat BONUS
 * destroys it — +26 turns them into 44 and 28, and the bot starts guarding at
 * full health, throwing away the turn.
 *
 * Measured on the P5 deck against a Brutal control, 80 seeds: the first draft
 * of Defensive used flat bonuses and a 0.45 offence penalty, and won 17.5% where
 * an unbiased bot won 56.3%. That is not a wall, it is a bot that has been told
 * to lose. Removing the offence penalty recovered 16pp; converting the bonuses
 * to multipliers recovered most of the rest.
 *
 * The one justified bonus is on a FREE action, where the base score is often
 * exactly 0 and any multiplier of 0 is still 0.
 */
const BIASES = {
  normal: () => NEUTRAL,

  /**
   * The wall. It guards, it heals, it keeps bodies down, and it treats its own
   * damage as an afterthought — Ara Mitama's Strength does not grow, so racing
   * was never the plan. Halving offence rather than zeroing it matters: a bot
   * that never attacks cannot close out a won position.
   */
  defensive: (action) => {
    // All multipliers: it guards when guarding is right, and hard. It does not
    // guard at full health, because the scorer knows that is a wasted turn.
    // The FREE half of defence, and the half that actually works. Rotating a
    // hurt Persona to the bench costs no action at all, so it is the one
    // defensive move that does not lose the race to make.
    //
    // Multiplier only, and NO bonus — that is what makes this REACTIVE. The
    // scorer rates a swap on its reason (retreating a dying active is 40, a
    // shocked one 35, an aimless one 0), so ×3 amplifies the reasons and leaves
    // the aimless swap at zero. All-Rounder is the one that rotates on
    // principle; this one rotates because something is about to die.
    if (action.type === 'CHANGE_ACTIVE') return { mult: 3, bonus: 0 };
    if (action.type === 'PLAY_PERSONA') return { mult: 1.4, bonus: 8 };

    // The half that costs the action, kept deliberately light. Every one of
    // these spends a turn the race does not give back.
    if (action.type === 'GUARD') return { mult: 3.5, bonus: 0 };
    if (isDefensiveBuff(action)) return { mult: 2, bonus: 0 };
    // Healing gets the lightest touch of all: it undoes roughly one turn of
    // damage at the cost of one turn — break-even at best in a race to 8
    // knockouts. The scorer already heals below 30% HP; this only sharpens it.
    if (isRestorative(action)) return { mult: 1.5, bonus: 0 };
    if (action.type === 'GALLOWS' || action.type === 'FUSE') return { mult: 1.15, bonus: 0 };
    // A light touch, not a refusal. A wall that cannot close out a won position
    // is not playing defensively, it is just losing slowly.
    if (isDamage(action)) return { mult: 0.95, bonus: 0 };
    return NEUTRAL;
  },

  /**
   * Wide and mobile. It wants bodies on the board and it wants to be standing
   * behind the right one, so the rotation bonus is the biggest thing here —
   * that is the behaviour that distinguishes it from Normal, which swaps only
   * when the scorer already sees a reason.
   */
  allrounder: (action) => {
    if (action.type === 'CHANGE_ACTIVE') return { mult: 2.2, bonus: 22 };
    if (action.type === 'PLAY_PERSONA') return { mult: 1.5, bonus: 0 };
    if (action.type === 'PLAY_ITEM') return { mult: 1.5, bonus: 10 };
    if (isRestorative(action)) return { mult: 1.3, bonus: 6 };
    if (isDamage(action)) return { mult: 1.1, bonus: 0 };
    if (action.type === 'GUARD') return { mult: 1.2, bonus: 4 };
    return NEUTRAL;
  },

  /**
   * The bank. The Gallows costs the action, so a big enough Gallows bonus IS
   * the stalling behaviour — every turn it spends feeding is a turn it does not
   * attack, and the Pixie it is feeding gets levels, stats and skills out of it.
   * When the fodder runs out it stops stalling on its own and cashes in, which
   * is why nothing here needs to model "the payoff turn" explicitly.
   */
  combo: (action) => {
    if (action.type === 'GALLOWS') return { mult: 3, bonus: 42 };
    if (isTeach(action)) return { mult: 2.5, bonus: 28 };
    if (isCharge(action)) return { mult: 2.5, bonus: 26 };
    if (action.type === 'FUSE') return { mult: 2, bonus: 20 };
    if (isOffensiveBuff(action)) return { mult: 2, bonus: 16 };
    // It has to live long enough to spend what it banked.
    if (action.type === 'GUARD') return { mult: 1.6, bonus: 10 };
    if (action.type === 'PLAY_PERSONA') return { mult: 1.3, bonus: 0 };
    return NEUTRAL;
  },
};

/**
 * Lay a playstyle over one already-computed score.
 *
 * @param score      what bot.js scored this action at
 * @param action     the legal action
 * @param playstyle  a resolved playstyle id ('random' is treated as Normal —
 *                   it should have been resolved at setup, and silently
 *                   behaving like Normal is a better failure than throwing
 *                   mid-match)
 */
export function applyPlaystyle(score, action, playstyle) {
  // The rule: amplify what the scorer likes, never rescue what it rejected.
  // The one carve-out is a free action sitting at exactly zero — see FREE_TYPES.
  const freeAndNeutral = score === 0 && FREE_TYPES.has(action.type);
  if (!(score > 0) && !freeAndNeutral) return score;
  const bias = (BIASES[playstyle] ?? BIASES.normal)(action);
  return score * bias.mult + bias.bonus;
}

/**
 * The starter a playstyle wants, if the offer includes it.
 *
 * The signature Persona is guaranteed to be *offered* to its flavour (see
 * STARTER_SIGNATURES in state.js); this is what makes the bot actually take it
 * rather than score the three cards on raw stats.
 */
export function preferredStarter(playstyle) {
  return getPlaystyle(playstyle).starter;
}
