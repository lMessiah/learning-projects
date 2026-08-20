/**
 * Story Mode — the campaign data.
 *
 * Seven battles against AI opponents, played as one long night that ends at
 * dawn. This file is *only* data: the battle list, and the constants that tune
 * how the campaign behaves. No DOM, no storage, no engine calls — so it can be
 * read by the UI, by the progress store and by the tests without dragging any
 * of them into each other.
 *
 * ── Why the opponents are placeholders ────────────────────────────────────
 *
 * Each battle names a deck, an archetype, a difficulty and a bot playstyle,
 * which is exactly the same set of knobs the Against Bot screen exposes. That
 * is deliberately the whole of the tuning for now: a real teaching campaign
 * wants authored boards (the way ui/tutorial/scenario.js builds them), and
 * authoring seven of those before the flow around them works would be building
 * the expensive half first. The shape below is what the real tuning slots into.
 *
 * ── The player's deck is assigned, not chosen ─────────────────────────────
 *
 * Every battle names a `playerDeck`: one of the loadout ids in decks.js, or
 * PLAYER_CHOICE. The campaign teaches what each deck is *for* by putting it in
 * the player's hands against the opponent that makes the point — and then, at
 * Nyx, steps back and lets them bring whichever one they got on with.
 *
 * Reorder these battles, or point any of them at a different loadout, and the
 * mode follows. Nothing outside this array and decks.js knows the assignment.
 *
 * ── Why the seeds are fixed ───────────────────────────────────────────────
 *
 * A story battle is a fight you are expected to lose and come back to. Fixing
 * the seed means the second attempt is the *same* fight — the same opening, the
 * same Personas offered — so the thing the player learned on attempt one is
 * still true on attempt two. That is the entire point of a teaching campaign,
 * and it is why this is not `Date.now()` the way Against Bot is.
 */

/* ------------------------------------------------------------------ *
 * Tunables
 * ------------------------------------------------------------------ */

/**
 * The bot playstyle each battle is built around locks the bot to one deck (see
 * engine/playstyles.js). Where a battle names a playstyle with a deck of its
 * own, `deckId` below MATCHES it — otherwise the boss would be handed a plan it
 * has no cards for. `PLAYSTYLE_DECKS` is not used at runtime; the campaign test
 * asserts the two agree, so a future edit to one can't silently desync.
 */

import { PLAYER_CHOICE } from './decks.js';

/**
 * How many times a battle may be lost before the run falls back.
 *
 * The counter is shown to the player as "retries remaining" and starts here, so
 * with 3: lose (2 left), lose (1 left), lose (0 left) -> back to the checkpoint.
 * The battle is therefore played at most MAX_RETRIES times in a row.
 */
export const MAX_RETRIES = 3;

/**
 * The campaign's one checkpoint sits immediately after this battle.
 *
 * Failing out anywhere at or before it restarts the run at Battle 1; failing out
 * after it restarts at the battle just past it. With 3: battles 1-3 send you
 * back to 1, battles 4-7 send you back to 4.
 */
export const CHECKPOINT_AFTER_BATTLE = 3;

export const BATTLES = Object.freeze([
  /* ---------------------------------------------------------------- *
   * Battles 1-4 — the fundamentals, all played on STARTER_DECK.
   *
   * One concept each, and in each case the opponent is built so the concept is
   * the way through: not a hint, a requirement. The player is meant to work out
   * what the fight is asking rather than be told, which is why the loss tips
   * (tips.js) escalate instead of opening with the answer.
   * ---------------------------------------------------------------- */
  {
    number: 1,
    id: 'first-night',
    playerDeck: 'STARTER_DECK',
    icon: '🕯️',
    name: 'First Night',
    opponent: 'The Doorkeeper',
    tagline: 'Something has to be first.',
    blurb: 'A slow, frail opponent with no plan. Room to work out which end of a Persona to point at people.',
    lesson: 'The core loop: attack, spend SP, end your turn.',
    deckId: 'p4',
    archetype: 'tactical',
    difficulty: 'easy',
    playstyle: 'normal',
    seed: 30101,
    setup: {
      // Three knockouts, not eight. A first fight that runs sixty turns has
      // stopped being a first fight — see koTargetOf in engine/effects.js.
      koTarget: 3,
      playerStarter: 'orpheus',
      opponent: {
        starter: 'pixie',
        // Frail bodies, cut down further, and nothing on the field that answers
        // anything. Every attack the player throws does visible work.
        field: [
          { cardId: 'pixie', level: 3, maxHp: 24, hp: 24, sp: 8, active: true },
          { cardId: 'apsaras', level: 5, maxHp: 26, hp: 26, sp: 8 },
        ],
        // Nothing in the deck either. A frail opening backed by a real deck is
        // not a gentle fight — it is a gentle first thirty seconds followed by
        // an ordinary one, which is exactly what this battle must not be.
        deck: [
          'pixie', 'pixie', 'apsaras', 'apsaras', 'angel', 'angel',
          'jack-frost', 'jack-frost', 'orpheus', 'orpheus', 'izanagi', 'izanagi',
          'arsene', 'arsene', 'ara-mitama', 'ara-mitama',
          'medicine', 'medicine', 'snuff-soul', 'snuff-soul',
          'amrita-soda', 'amrita-soda', 'smoke-bomb', 'smoke-bomb',
          'third-eye', 'third-eye', 'baton-pass', 'baton-pass', 'dekunda', 'traesto',
        ],
      },
    },
  },
  {
    number: 2,
    id: 'the-exposed',
    playerDeck: 'STARTER_DECK',
    icon: '🔥',
    name: 'The Exposed',
    opponent: 'The Exposed',
    tagline: 'It has never had to hide anything before.',
    blurb: 'Everything it fields burns. Find the element it cannot take and the fight falls open.',
    lesson: 'Weakness, knockdown, and the One More it grants.',
    deckId: 'p3',
    archetype: 'tactical',
    difficulty: 'easy',
    playstyle: 'normal',
    seed: 30202,
    setup: {
      koTarget: 3,
      // Orpheus opens with Agi, so the fire answer is in the player's hand from
      // turn one and the lesson is "notice", not "go and find".
      playerStarter: 'orpheus',
      opponent: {
        starter: 'jack-frost',
        // Every body here is weak to fire and none of them resists it. Ignoring
        // that is playable but slow; using it knocks down, grants a One More,
        // and doubles the damage on the way through.
        field: [
          { cardId: 'jack-frost', level: 6, active: true },
          { cardId: 'koppa-tengu', level: 8 },
        ],
        // Only four deck-legal Personas are weak to fire, so eight of these are
        // the maximum two copies each. The rest are chosen for what they are
        // NOT: nothing here resists fire, so the answer never stops working
        // partway through the fight.
        deck: [
          'jack-frost', 'jack-frost', 'koppa-tengu', 'koppa-tengu', 'silky', 'silky',
          'mothman', 'mothman', 'apsaras', 'apsaras', 'pixie', 'pixie',
          'angel', 'angel', 'omoikane', 'omoikane',
          'medicine', 'medicine', 'snuff-soul', 'snuff-soul',
          'bead-chain', 'amrita-soda', 'muscle-drink', 'sapping-device',
          'third-eye', 'fortunes-draw', 'baton-pass', 'dekaja', 'dekunda', 'traesto',
        ],
      },
    },
  },
  {
    number: 3,
    id: 'two-faces',
    playerDeck: 'STARTER_DECK',
    boss: true,
    icon: '🌗',
    name: 'Two Faces',
    opponent: 'Two Faces',
    tagline: 'The trick that worked last night does not work tonight.',
    blurb: 'It shrugs off the fire that carried you here. Something else in your deck does not care.',
    lesson: 'Changing your active Persona to answer what is in front of you.',
    deckId: 'p5',
    archetype: 'defensive',
    difficulty: 'medium',
    playstyle: 'normal',
    seed: 30303,
    setup: {
      koTarget: 3,
      playerStarter: 'orpheus',
      opponent: {
        starter: 'jack-o-lantern',
        // Both resist fire and both are weak to ice. Orpheus, who has won the
        // last two fights, is now the wrong Persona — and Jack Frost, sitting
        // in the same deck, is the right one.
        field: [
          { cardId: 'jack-o-lantern', level: 9, active: true },
          { cardId: 'hua-po', level: 10 },
        ],
        // Every Persona here either resists fire or is weak to ice, and most are
        // both. Levels stay printed: the fight is meant to be answered with a
        // swap, not survived through a level gap.
        deck: [
          'jack-o-lantern', 'jack-o-lantern', 'hua-po', 'hua-po', 'orpheus', 'orpheus',
          'ara-mitama', 'ara-mitama', 'nekomata', 'nekomata', 'apsaras', 'apsaras',
          'pixie', 'pixie', 'angel', 'angel',
          'medicine', 'medicine', 'snuff-soul', 'snuff-soul',
          'amrita-soda', 'amrita-soda', 'smoke-bomb', 'muscle-drink',
          'third-eye', 'fortunes-draw', 'baton-pass', 'dekunda', 'dekaja', 'traesto',
        ],
      },
    },
  },
  {
    number: 4,
    id: 'the-hunger',
    playerDeck: 'STARTER_DECK',
    icon: '⚗️',
    name: 'The Hunger',
    opponent: 'The Hunger',
    tagline: 'It heals faster than you hit.',
    blurb: 'Two bodies far bigger than anything you own, and they mend themselves. You need something you do not have.',
    lesson: 'Fusion — making a Persona your deck does not contain.',
    deckId: 'p3',
    archetype: 'defensive',
    difficulty: 'medium',
    playstyle: 'defensive',
    seed: 30404,
    setup: {
      // Two knockouts, and both of them are the wall. A frail bench would let
      // the player farm cheap knockouts and win without ever solving the fight,
      // which is precisely the lesson going missing.
      koTarget: 3,
      playerStarter: 'orpheus',
      // The fusion material starts ON THE BOARD, not in hand.
      //
      // Fusion is not legal until turn 4, and a player who spends those turns
      // finding and playing two Personas has spent them being hit by a level 33
      // boss. Handing them the board means the fight asks one question — "do you
      // realise you can combine these?" — instead of three.
      playerField: [
        { cardId: 'orpheus', level: 4, active: true },
        { cardId: 'silky', level: 13 },
        { cardId: 'omoikane', level: 11 },
        // A fourth body, because fusion CONSUMES two. Without it the player who
        // does the right thing is left holding fewer Personas than the player
        // who does nothing, and the fight punishes the lesson it is teaching.
        { cardId: 'izanagi', level: 4 },
      ],
      // The hand is deliberately NOT authored. An authored hand replaces the
      // opening draw wholesale, and a hand of five support cards leaves the
      // player with no Personas to replace the two that fusion consumes — which
      // made fusing actively lose the fight. The board above is the only thing
      // this battle needs to guarantee.
      opponent: {
        starter: 'unicorn',
        /**
         * The wall, and why it is built this way.
         *
         * It is weak to dark and nothing else, and the starter deck contains no
         * dark at all — so for the first time in the campaign there is no
         * weakness to lean on. It attacks with LIGHT, which matters more than it
         * looks: Kikuri-Hime, the Persona this fight is teaching the player to
         * make, resists light. Everything else they own takes it in full.
         *
         * So the fusion is not "a bigger number". It is the one body on the
         * board that survives what this thing does, and it out-heals it 60 to
         * 25 while it works. Measured over 16 seeded matches: the player wins
         * 100% of the time when allowed to fuse and 31% when not.
         *
         * Endurance 14 is what stops chip damage from a level-4 board; magic 9
         * is what stops it killing that board before turn 4, when fusion first
         * becomes legal. Both are the knobs to turn if this needs to move.
         */
        field: [
          { cardId: 'unicorn', level: 21, maxHp: 80, hp: 80, maxSp: 40, sp: 40, endurance: 14, magic: 9, active: true },
          { cardId: 'unicorn', level: 21, maxHp: 80, hp: 80, maxSp: 40, sp: 40, endurance: 14, magic: 9 },
        ],
        deck: [
          'unicorn', 'apsaras', 'apsaras', 'pixie', 'pixie', 'angel',
          'angel', 'orpheus', 'orpheus', 'jack-frost', 'jack-frost', 'izanagi',
          'izanagi', 'arsene', 'arsene', 'silky',
          'medicine', 'medicine', 'snuff-soul', 'snuff-soul',
          'amrita-soda', 'amrita-soda', 'smoke-bomb', 'smoke-bomb',
          'third-eye', 'fortunes-draw', 'baton-pass', 'dekunda', 'dekaja', 'traesto',
        ],
      },
    },
  },

  /* ---------------------------------------------------------------- *
   * Battles 5-7 — the deck-identity block. One assigned archetype deck each.
   *
   * PLACEHOLDER OPPONENTS. The deck assignments and the structure are final;
   * the fights themselves are built in Part B, along with the three teaching
   * decks they hand out.
   * ---------------------------------------------------------------- */
  {
    number: 5,
    id: 'the-rush',
    playerDeck: 'TEMPO_DECK',
    icon: '💨',
    name: 'The Rush',
    opponent: 'The Rush',
    tagline: 'Faster than it is strong.',
    blurb: 'An opponent that folds to weakness-chaining. Learn what a tempo deck feels like in your hands.',
    lesson: 'Tempo: chaining One Mores and snowballing a turn.',
    deckId: 'p4',
    archetype: 'swift',
    difficulty: 'medium',
    playstyle: 'allrounder',
    seed: 30505,
  },
  {
    number: 6,
    id: 'the-wall',
    playerDeck: 'WALLBREAKER_DECK',
    boss: true,
    icon: '🛡️',
    name: 'The Wall',
    opponent: 'The Silent Wall',
    tagline: 'Nothing gets past it by being clever.',
    blurb: 'High Endurance, guards and heals. Chip damage is mended before it matters — break it instead.',
    lesson: 'Wall-breaking: one enormous Phys hit rather than many small ones.',
    deckId: 'p5',
    archetype: 'defensive',
    difficulty: 'brutal',
    playstyle: 'defensive',
    seed: 30606,
  },
  {
    number: 7,
    id: 'the-siege',
    playerDeck: 'STALL_DECK',
    boss: true,
    icon: '⛰️',
    name: 'The Siege',
    opponent: 'The Siege',
    tagline: 'Survive the first ten turns and it has already lost.',
    blurb: 'It comes at you hard and early. Stack Endurance, heal through it, and let the storm spend itself.',
    lesson: 'Attrition: winning by not losing.',
    deckId: 'p3',
    archetype: 'aggressive',
    difficulty: 'brutal',
    playstyle: 'combo',
    seed: 30707,
  },

  /* ---------------------------------------------------------------- *
   * Battle 8 — the exam. PLACEHOLDER; built in Part C.
   * ---------------------------------------------------------------- */
  {
    number: 8,
    id: 'nyx',
    playerDeck: PLAYER_CHOICE,
    boss: true,
    icon: '🌑',
    name: 'Nyx',
    opponent: 'Nyx',
    tagline: 'The night itself, and it has been waiting.',
    blurb: 'Everything the night taught you, asked all at once. Bring whichever deck you trust.',
    lesson: 'No new lesson — an exam of all of them.',
    deckId: 'p3',
    archetype: 'aggressive',
    difficulty: 'brutal',
    playstyle: 'combo',
    seed: 30808,
  },
]);

/** The number of battles in the campaign. Derived, never hand-written. */
export const BATTLE_COUNT = BATTLES.length;

/** One battle by its position in the campaign (1-based). Null if out of range. */
export function getBattle(number) {
  return BATTLES.find((b) => b.number === number) ?? null;
}

/** The battle after this one, or null at the end of the campaign. */
export function nextBattle(number) {
  return getBattle(number + 1);
}

/**
 * Where failing out of this battle puts the player.
 *
 * One checkpoint, so this is the whole of it: past it you go back to just after
 * it, at or before it you start the night again.
 */
export function checkpointFor(number) {
  return number > CHECKPOINT_AFTER_BATTLE ? CHECKPOINT_AFTER_BATTLE + 1 : 1;
}

/** The battles that count as bosses, for the trophies that ask. */
export function isBoss(number) {
  return Boolean(getBattle(number)?.boss);
}

/** Is this a real battle number? */
export function isBattleNumber(number) {
  return Number.isInteger(number) && number >= 1 && number <= BATTLE_COUNT;
}
