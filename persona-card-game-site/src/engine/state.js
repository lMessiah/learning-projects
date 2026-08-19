/**
 * Game state construction and read-only selectors.
 *
 * State is a plain JSON-serialisable object: no class instances, no functions,
 * no DOM references. `applyAction` (actions.js) always returns a fresh copy.
 */
import { CONFIG, PASSIVE_CHOICE_PREFIX } from './config.js';
import { createRng, shuffle, sample } from './rng.js';
import { getCard, getPersona, getSkillDefinition, STARTER_POOL, STARTER_SIGNATURES } from '../data/cards.js';
import { buildDeck } from '../data/archetypes.js';

/* ------------------------------------------------------------------ *
 * Construction
 * ------------------------------------------------------------------ */

export function createPersonaInstance(state, cardId, owner, opts = {}) {
  const card = getPersona(cardId);
  const level = opts.level ?? card.level;
  const uid = `p${state.nextUid++}`;
  return {
    uid,
    cardId,
    owner,
    level,
    strength: card.strength,
    magic: card.magic,
    endurance: card.endurance,
    maxHp: card.hp,
    hp: card.hp,
    maxSp: card.sp,
    sp: card.sp,
    ko: false,
    knockedDown: false,
    guarding: false,
    warded: false, // Moonless Gown: immune, but cannot act
    endured: false, // Endure fires once per match, per Persona
    buffs: [], // [{ stat:'atk'|'def', direction:'up'|'down', turnsLeft }]
    ailments: [], // [{ type:'burn'|'shock', turnsLeft }]
    charges: [], // ['concentrate'|'charge']
    // At most one passive, printed on the card. Fusion can replace it with an
    // inherited one, so it lives on the instance rather than being read from
    // the card definition every time.
    passive: opts.passive !== undefined ? opts.passive : card.passive || null,
    inheritedSkills: opts.inheritedSkills ? [...opts.inheritedSkills] : [],
    // Skills this Persona has given up to stay under MAX_SKILLS_PER_PERSONA.
    // Printed skills live on the card, so forgetting one has to be recorded on
    // the instance; an inherited skill is simply dropped from the list above.
    forgottenSkills: [],
    // Damage types the OPPONENT has already struck this Persona with. Its
    // weakness/resist to those types is public knowledge from then on.
    revealedTypes: [],
    // Affinity overrides. `null` means "read the card". A rewrite Special
    // (Turn of the Moon / Jester's Trickery / Change of Heart) replaces them,
    // and `rewritten` records that the card no longer describes this Persona —
    // which is what strips the Brutal bot's knowledge of it. See affinitiesOf.
    weaknesses: null,
    resists: null,
    rewritten: false,
    // Contribution counters, for the MVP line on the post-match screen. They
    // live on the instance because that is the only thing that survives a
    // Persona being benched, knocked out and left there.
    dmgDealt: 0,
    kos: 0,
  };
}

function createPlayer(id, { name, deckId, archetype = null, controller = 'human', difficulty = null }) {
  return {
    id,
    name,
    deckId, // the flavour: 'p3' | 'p4' | 'p5'
    archetype, // 'aggressive' | 'defensive' | 'tactical' | 'swift' | null
    controller, // 'human' | 'bot'
    difficulty, // bot only
    lastSkillId: null, // the last skill this player used, for Wild Card
    // The Persona chosen from the opening three. When it is one of the three
    // SIGNATURE_CARDS it is also the player's declared plan, which is what the
    // signature draw priority and level scaling key off.
    starterCardId: null,
    pendingDraw: null, // reserved by Fortune's Draw
    deck: [],
    hand: [], // [{ uid, cardId }]
    discard: [],
    field: [], // persona instances, including KO'd ones (KO'd don't occupy the cap)
    activeUid: null,
    koCount: 0, // how many of THIS player's Personas have been KO'd
    // Consecutive turns this player has STARTED with nothing living on the
    // field. Drives the loss timer, the Persona draw filter and the countdown
    // the board shows. Reset the moment a Persona lands.
    emptyFieldTurns: 0,
    // Cards owed to this player on their NEXT draw phase, banked by catching
    // the opponent boardless at the end of a turn. Paid out and cleared there.
    pendingBonusDraws: 0,
    fatigue: 0,
    reshuffles: 0,
    stats: createStats(),
  };
}

/**
 * Per-player play counters.
 *
 * These exist so the post-match tips can say something true about how you
 * actually played rather than mining the log for phrases — the log is capped,
 * so it forgets the early game exactly when the advice would be most useful.
 * They are ordinary state: deterministic, serialisable, and safe to send to a
 * client (everything here is already visible in the log as it happens).
 */
export function createStats() {
  return {
    turnsTaken: 0,
    attacks: 0, // offensive actions resolved
    weaknessHits: 0,
    technicals: 0, // ailment follow-ups cashed in
    knockdowns: 0, // standing Personas put on their back
    oneMores: 0,
    guards: 0,
    fusions: 0,
    gallows: 0, // Personas fed to another of your own
    gallowsPaid: 0, // ...of which cost an action (feast or meal)
    gallowsJunk: 0, // ...of which were free disposal
    fusionReadyTurns: 0, // turns that began with a fusion available
    cardsDrawn: 0,
    cardsPlayed: 0, // Personas, Items and Specials put down from hand
    // --- Damage ledger, for the post-match screen ------------------------
    damageDealt: 0,
    damageTaken: 0,
    biggestHit: null, // { amount, source, target } — the single hardest blow landed
    // Draw-level scaling, sampled late enough for the floor to mean something.
    personaDrawsLate: 0,
    personaDrawsLateAboveFloor: 0,
    turnsEndedFullSp: 0, // turns ended without the active spending a drop of SP
    heavyHitsTaken: 0, // single hits of 25%+ of a Persona's max HP
    koWithEmptyBench: 0, // active knocked out with nothing left to step up
    typesUsed: [], // damage types this player has attacked with
    // --- Field presence and the knockdown combo -------------------------
    // Kept for the balance simulator, which has to answer "is the combo doing
    // too much of the damage?" and "who is collecting the reward draws?".
    comboStacksTotal: 0, // summed over turns; divide by turnsTaken for the mean
    comboMax: 0, // deepest single chain this match
    comboDamageBonus: 0, // damage attributable to the combo multiplier alone
    emptyFieldRewardDraws: 0, // bonus draws for catching the opponent boardless
    // --- SP pressure ---------------------------------------------------
    spSpent: 0,
    spUnspentAtTurnEnd: 0, // summed over turns; divide by turnsTaken for the mean
    turnsBestSkillUnaffordable: 0, // the active could not pay for its strongest skill
  };
}

/** Bump a counter, tolerating states built before `stats` existed. */
export function bumpStat(state, playerId, key, amount = 1) {
  const player = state.players[playerId];
  if (!player) return;
  if (!player.stats) player.stats = createStats();
  player.stats[key] = (player.stats[key] ?? 0) + amount;
}

export function recordTypeUsed(state, playerId, damageType) {
  const player = state.players[playerId];
  if (!player) return;
  if (!player.stats) player.stats = createStats();
  if (!player.stats.typesUsed.includes(damageType)) player.stats.typesUsed.push(damageType);
}

/**
 * Start a match. The result sits in the `starterSelect` phase: each player is
 * offered 3 random low-level Personas and must CHOOSE_STARTER before play.
 */
export function createMatch({ seed = 1, players }) {
  if (!players || players.length !== 2) throw new Error('createMatch needs exactly 2 players');

  const state = {
    version: 1,
    config: { ...CONFIG },
    rng: createRng(seed),
    seed,
    nextUid: 1,
    phase: 'starterSelect',
    turn: 0,
    activePlayer: 0,
    players: players.map((p, i) => createPlayer(i, p)),
    turnState: null,
    starterOptions: [[], []],
    winner: null,
    endReason: null,
    suddenDeath: null,
    // Every knockout, in order. The log is capped and forgets the early game;
    // this is bounded by KO_TARGET x 2 and never does.
    koTimeline: [],
    log: [],
  };

  // Decks are generated from the flavour + archetype using the match RNG, so
  // both sides of an online match derive identical decks from the same seed.
  for (const player of state.players) {
    const [built, buildRng] = buildDeck({
      flavour: player.deckId,
      archetype: player.archetype,
      rng: state.rng,
    });
    state.rng = buildRng;
    const [deck, rng] = shuffle(state.rng, built);
    state.rng = rng;
    player.deck = deck;
  }

  // Starter offers. Each flavour's SIGNATURE Persona is always one of the three
  // — the card that flavour is about should be a decision on turn one, not a
  // lucky roll — and the other two are sampled from the rest of the pool, so
  // choosing is still choosing. A flavour with no signature gets three sampled,
  // exactly as before.
  for (let i = 0; i < 2; i++) {
    const signature = STARTER_SIGNATURES[state.players[i].deckId] ?? null;
    const rest = signature ? STARTER_POOL.filter((id) => id !== signature) : STARTER_POOL;
    const [sampled, rng] = sample(state.rng, rest, signature ? 2 : 3);
    state.rng = rng;
    // Signature first, so the eye lands on it before the alternatives.
    state.starterOptions[i] = signature ? [signature, ...sampled] : sampled;
  }

  pushLog(state, 'Match start. Choose your starting Persona.', 'system');
  return state;
}

export function createTurnState() {
  return {
    actionsRemaining: CONFIG.ACTIONS_PER_TURN,
    personaChangesRemaining: CONFIG.PERSONA_CHANGES_PER_TURN,
    // How many One Mores have been granted this turn, and whether one of them
    // is still unspent. `oneMoreActive` is what opens up the enemy bench: the
    // One More action — and only that action — may hit any enemy Persona.
    oneMoresGranted: 0,
    oneMoreActive: false,
    oneMoreUsed: false, // convenience mirror of `oneMoresGranted > 0`
    itemsPlayed: 0,
    specialsPlayed: 0,
    fusionsPerformed: 0, // fusion costs the action AND is rationed — see FUSION_USES_ACTION
    // Two separate rations: one nourishing meal (which costs the action) and
    // one free junk disposal. See the CONFIG comment for why they don't share.
    gallowsUsed: 0,
    gallowsJunkUsed: 0,
    canTargetBench: false, // granted by Ambush for the WHOLE turn
    momentumUsed: false, // Momentum draws once a turn, however many cheap skills fly
    personasPlayed: 0,
    // Knockdown combo: one stack per standing Persona you put on its back this
    // turn. Lives on the turn state, so it resets itself — a new turn builds a
    // new one of these and the stacks are simply gone.
    comboStacks: 0,
  };
}

/**
 * The damage multiplier the acting player's knockdown combo is currently worth.
 *
 * The single place the stacks are turned into a number, so the damage pipeline,
 * the bot and the board all price a combo identically.
 */
export function comboMultiplier(state) {
  const stacks = state.turnState?.comboStacks ?? 0;
  return 1 + stacks * CONFIG.COMBO_DAMAGE_STEP;
}

/**
 * How deep into the empty-field timer a player is: 0 when they have a board,
 * 1 on the first turn they start without one, and so on up to the loss.
 */
export function emptyFieldStage(state, playerId) {
  return state.players[playerId].emptyFieldTurns ?? 0;
}

/**
 * How many turns this player has left — INCLUDING the one they are in — before
 * an empty field loses them the match.
 *
 * Stage 1 (the first empty turn-start) reads 3: this turn and two more. Stage 3
 * reads 1, the last chance. Starting a turn that would be stage 4 is the loss,
 * so this never legitimately reads 0.
 */
export function emptyFieldTurnsLeft(state, playerId) {
  const stage = emptyFieldStage(state, playerId);
  if (stage <= 0) return CONFIG.EMPTY_FIELD_LOSS_TURNS;
  return Math.max(0, CONFIG.EMPTY_FIELD_LOSS_TURNS - stage + 1);
}

/**
 * May this player hit the opponent's bench right now?
 * Two routes: Ambush opens the bench for the whole turn, and a One More opens
 * it for the extra action it granted.
 */
export function canTargetBench(state) {
  const turn = state.turnState;
  return Boolean(turn?.canTargetBench || turn?.oneMoreActive);
}

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

/**
 * Every action deep-copies the state, so an unbounded log would make a long
 * match quadratic in memory and time. Only the recent tail is retained; ids
 * keep counting so the UI can still tell entries apart.
 */
export const MAX_LOG_ENTRIES = 400;

/**
 * `data` is optional structured detail for entries the UI wants to do more with
 * than print — the fusion and Gallows animations read the cast off it rather
 * than parsing the sentence back apart. It is plain JSON like everything else,
 * so it survives redaction and the wire untouched.
 */
export function pushLog(state, text, kind = 'info', data = null) {
  const id = (state.log[state.log.length - 1]?.id ?? 0) + 1;
  state.log.push(data ? { id, turn: state.turn, kind, text, data } : { id, turn: state.turn, kind, text });
  if (state.log.length > MAX_LOG_ENTRIES) {
    state.log.splice(0, state.log.length - MAX_LOG_ENTRIES);
  }
  return state;
}

/* ------------------------------------------------------------------ *
 * Selectors
 * ------------------------------------------------------------------ */

export const opponentOf = (playerId) => (playerId === 0 ? 1 : 0);

export function findPersona(state, uid) {
  for (const player of state.players) {
    const found = player.field.find((p) => p.uid === uid);
    if (found) return found;
  }
  return null;
}

export function requirePersona(state, uid) {
  const persona = findPersona(state, uid);
  if (!persona) throw new Error(`No Persona with uid "${uid}"`);
  return persona;
}

export function getActive(state, playerId) {
  const player = state.players[playerId];
  if (!player.activeUid) return null;
  return player.field.find((p) => p.uid === player.activeUid) || null;
}

/** Living Personas on a player's field (active + bench). */
export function livingField(state, playerId) {
  return state.players[playerId].field.filter((p) => !p.ko);
}

export function benchOf(state, playerId) {
  const player = state.players[playerId];
  return player.field.filter((p) => !p.ko && p.uid !== player.activeUid);
}

export function koedField(state, playerId) {
  return state.players[playerId].field.filter((p) => p.ko);
}

export function fieldCount(state, playerId) {
  return livingField(state, playerId).length;
}

export function hasFieldRoom(state, playerId) {
  return fieldCount(state, playerId) < CONFIG.FIELD_CAP;
}

/**
 * Highest level among the Personas on a player's field.
 *
 * DESIGN NOTE: KO'd Personas still count. They are still on your field, and
 * ignoring them would mean a board wipe throws your power ceiling back to zero
 * and strands every mid-tier card in your hand.
 */
export function highestFieldLevel(state, playerId) {
  return state.players[playerId].field.reduce((max, persona) => Math.max(max, persona.level), 0);
}

/** The printed level a Persona card must be at or under to be played right now. */
export function playableLevelCap(state, playerId) {
  return highestFieldLevel(state, playerId) + CONFIG.PLAY_LEVEL_GAP;
}

/* ------------------------------------------------------------------ *
 * Signature Personas
 * ------------------------------------------------------------------ *
 *
 * Pixie, Slime and Ara Mitama are the three cards their flavours are ABOUT.
 * Every flavour is guaranteed one of them among its opening three offers, and
 * the player picks one because they want to play that plan.
 *
 * The problem this solves: a signature is a low-level card. Once it dies, a
 * replacement drawn fifteen turns later is a level-4 body walking into a level-
 * 15 board — legal to play, useless to play. The plan the player chose on turn
 * one is gone for the rest of the match, which is a bad thing to do to someone
 * for the crime of losing one Persona.
 *
 * Two rules, and both are about ACCESS, not power:
 *
 *   1. SUPPRESSION — you never draw a signature while you already hold one
 *      (alive on the field, or in hand). Applies to all three cards, for
 *      anyone. Copies never clog a hand, and the deck keeps them for when you
 *      have none.
 *   2. PRIORITY — the signature you CHOSE as your starter is the likeliest
 *      Persona in your deck once you have none.
 *
 * What you get back is the CARD, at its printed level — not the Persona you
 * lost. A signature that died at level 15 returns as a level 4 body, and every
 * level it had is gone with it.
 *
 * That is deliberate and it is the design's centre of gravity. A third rule was
 * built and then removed: it scaled the returning copy to the player's own
 * board level, which made the plan fully recoverable and, measured, turned
 * losing your signature into barely a setback. Losing the Persona you built
 * your match around is supposed to HURT. These two rules only guarantee you can
 * start rebuilding — through the Gallows and knockout levelling, like anything
 * else — rather than spending the rest of the match unable to draw the card at
 * all.
 */

/** The three cards. Read off the data, so adding a flavour needs no edit here. */
export const SIGNATURE_CARDS = Object.freeze([...new Set(Object.values(STARTER_SIGNATURES))]);

export const isSignatureCard = (cardId) => SIGNATURE_CARDS.includes(cardId);

/**
 * Does this player already have this signature? Alive on the field or in hand.
 *
 * KO'd copies deliberately do NOT count: a dead Ara Mitama is the situation the
 * whole mechanism exists for, not a reason to keep withholding the card.
 */
export function holdsSignature(state, playerId, cardId) {
  const player = state.players[playerId];
  return (
    player.field.some((p) => p.cardId === cardId && !p.ko) ||
    player.hand.some((c) => c.cardId === cardId)
  );
}

/**
 * Is this the signature this player actually chose on turn one?
 *
 * The plan is the pick, not the flavour. A P5 player who passed on Ara Mitama
 * for Orpheus did not choose the wall, and does not get it handed back.
 */
export function isChosenSignature(state, playerId, cardId) {
  return isSignatureCard(cardId) && state.players[playerId].starterCardId === cardId;
}

/*
 * There is deliberately no `signatureEntryLevel` here.
 *
 * A signature enters play at its printed level like every other Persona card —
 * the draw rules above hand back the CARD, and nothing hands back the levels.
 * Traesto is the one exception to that, and it is not a signature rule: it
 * carries a Persona's real level home because that body never left your side.
 */

/** Can this Persona card be played to the field yet? */
export function canPlayPersonaCard(state, playerId, cardId, entry = null) {
  // A Persona pulled back by Traesto is exempt: the ceiling exists to stop a
  // card you have not earned dropping onto a small board, and this one was
  // legally standing on your field a moment ago. Without the exemption,
  // retreating your last Persona would be unrecoverable — you could never put
  // it back down — which contradicts the whole point of an empty field being a
  // position a player may choose.
  if (entry?.persona) return true;
  return handPersonaLevel(entry, cardId) <= playableLevelCap(state, playerId);
}

/**
 * Can a fusion put this card on the board right now?
 *
 * The SAME ceiling a card played from hand answers to. Fusion used to be exempt,
 * on the reasoning that two sacrifices and a combined-level requirement were
 * price enough — but the two prices measure different things. Combined level
 * asks "are the materials big enough"; the ceiling asks "has your board earned a
 * Persona this size", and only the second one stops a small board leapfrogging
 * straight to the top of the ladder.
 *
 * Read BEFORE the parents leave the field, which is what makes the ladder climb
 * rather than lock: the Persona being fed in usually IS the board's ceiling, so
 * a Lv 36 parent is exactly what admits a Lv 46 result.
 */
export function canFuseInto(state, playerId, resultCardId) {
  return getPersona(resultCardId).level <= fusionLevelCap(state, playerId);
}

/** The printed level a FUSION RESULT must be at or under right now. */
export function fusionLevelCap(state, playerId) {
  return highestFieldLevel(state, playerId) + CONFIG.FUSION_LEVEL_GAP;
}

/**
 * Has fusion opened yet?
 *
 * A whole-match gate rather than a per-player one, keyed to the turn counter
 * the board already shows, so "fusion opens on turn 4" means the number the
 * player is looking at.
 */
export function fusionUnlocked(state) {
  return (state.turn ?? 0) >= CONFIG.FUSION_FIRST_TURN;
}

/**
 * The level a Persona in hand actually is.
 *
 * Normally that is the printed level of the card. A Persona pulled back by
 * Traesto is different: the hand entry carries the living instance, so the card
 * in your hand is a level 30 body rather than the level 6 one on its face.
 *
 * Read by everything that prices a Persona in hand — the play ceiling, fusion
 * material, the Gallows — so there is one answer to "how big is this card"
 * rather than three. It is also the honest cost of the retreat: you cannot put
 * a grown Persona back down until your board has climbed to meet it again.
 */
export function handPersonaLevel(entry, fallbackCardId = null) {
  if (entry?.persona) return entry.persona.level;
  const cardId = entry?.cardId ?? fallbackCardId;
  return cardId ? getPersona(cardId).level : 0;
}

/** Every skill a Persona can currently use: printed (unlocked) + inherited. */
export function personaSkills(state, persona) {
  const card = getPersona(persona.cardId);
  // `forgottenSkills` is undefined on states written before the cap existed, so
  // an old save or a hand-built fixture reads as "has forgotten nothing".
  const forgotten = persona.forgottenSkills;
  const gone = forgotten?.length ? new Set(forgotten) : null;
  let printed = card.skills.filter((s) => s.unlockLevel <= persona.level);
  if (gone) printed = printed.filter((s) => !gone.has(s.id));
  const inheritedIds = gone
    ? persona.inheritedSkills.filter((id) => !gone.has(id))
    : persona.inheritedSkills;
  if (!inheritedIds.length) return printed;

  const known = new Set(printed.map((s) => s.id));
  const inherited = [];
  for (const skillId of inheritedIds) {
    if (known.has(skillId)) continue;
    known.add(skillId);
    const source = findSkillDefinition(skillId);
    if (source) inherited.push({ ...source, unlockLevel: 1, inherited: true });
  }
  return [...printed, ...inherited];
}

/* ------------------------------------------------------------------ *
 * The skill cap
 *
 * One accessor per question, so the engine, the bot and the UI all price a full
 * Persona the same way. Nothing else may count skills for itself.
 * ------------------------------------------------------------------ */

/** How many skills this Persona currently knows. */
export function skillCount(state, persona) {
  return personaSkills(state, persona).length;
}

/** Is there no room for another one? */
export function isSkillFull(state, persona) {
  return skillCount(state, persona) >= CONFIG.MAX_SKILLS_PER_PERSONA;
}

/**
 * What this Persona could give up to make room, as full skill objects.
 *
 * Everything it knows is on the table — a printed skill is no more sacred than
 * an inherited one, which is what the games do and what stops a Persona being
 * permanently wedged by five printed skills it has outgrown.
 */
export function droppableSkills(state, persona) {
  return personaSkills(state, persona);
}

/**
 * Record that a Persona has given up a skill. Inherited ones leave the list;
 * printed ones cannot, so they are remembered as forgotten instead.
 *
 * Pure bookkeeping — the caller decides whether a drop was legal.
 */
export function forgetSkill(persona, skillId) {
  if (!persona.forgottenSkills) persona.forgottenSkills = [];
  const wasInherited = persona.inheritedSkills.includes(skillId);
  if (wasInherited) {
    persona.inheritedSkills = persona.inheritedSkills.filter((id) => id !== skillId);
  }
  // Recorded either way: an inherited skill can also be a printed one the card
  // unlocks later, and forgetting it must survive that.
  if (!persona.forgottenSkills.includes(skillId)) persona.forgottenSkills.push(skillId);
  return wasInherited;
}

/** Look a skill definition up by id. Single source of truth: the card data. */
export function findSkillDefinition(skillId) {
  return getSkillDefinition(skillId);
}

export function getSkill(state, persona, skillId) {
  return personaSkills(state, persona).find((s) => s.id === skillId) || null;
}

export function buffOf(persona, stat) {
  return persona.buffs.find((b) => b.stat === stat) || null;
}

export function hasAilment(persona, type) {
  return persona.ailments.some((a) => a.type === type);
}

export function totalRemainingHp(state, playerId) {
  return livingField(state, playerId).reduce((sum, p) => sum + p.hp, 0);
}

export function handCard(state, playerId, uid) {
  return state.players[playerId].hand.find((c) => c.uid === uid) || null;
}

/**
 * The Arcana of the Personas still sitting in a player's deck, deduplicated.
 *
 * Fortune's Draw needs this to offer a choice, but a redacted view has no deck
 * ORDER — so redaction leaves an order-free `deckArcana` summary on the
 * viewer's own player and this falls back to it. Knowing what is left in your
 * own deck is legitimate; knowing what order it is in is not.
 */
export function remainingPersonaArcana(state, playerId) {
  const player = state.players[playerId];
  if (player.deckArcana) return [...player.deckArcana];
  const seen = new Set();
  for (const cardId of player.deck) {
    if (!cardId) continue; // redacted placeholder
    const card = getCard(cardId);
    if (card.type === 'persona') seen.add(card.arcana);
  }
  return [...seen];
}

/**
 * A Persona's CURRENT affinity chart.
 *
 * The single place anything is allowed to ask what a Persona is weak to. The
 * printed card is only the default: a rewrite Special replaces the chart on the
 * instance, and every reader — the damage formula, the bot, the card face, the
 * board strip — goes through here so none of them can disagree about it.
 */
export function affinitiesOf(persona) {
  const card = getPersona(persona.cardId);
  return {
    weaknesses: persona.weaknesses ?? card.weaknesses,
    resists: persona.resists ?? card.resists,
  };
}

/** Has every weakness and resist this Persona has already been uncovered? */
export function affinitiesFullyRevealed(persona) {
  const { weaknesses, resists } = affinitiesOf(persona);
  const chart = [...weaknesses, ...resists];
  if (!chart.length) return true; // nothing to learn: it counts as read
  return chart.every((type) => persona.revealedTypes.includes(type));
}

/**
 * The top of a player's own deck, as far as they are allowed to look.
 *
 * Shuffle Time is the only thing that grants this. A redacted view has no deck
 * order at all, so redaction leaves `deckTop` on the viewer's own player when
 * they are holding the card, and this reads whichever is available.
 */
export function deckTop(state, playerId, count) {
  const player = state.players[playerId];
  if (player.deckTop) return player.deckTop.slice(0, count);
  return player.deck.slice(0, count).filter(Boolean);
}


/**
 * The skill Wild Card would copy: the last one the opponent used, if any.
 * Public knowledge — every skill use is written into the match log.
 */
export function mimicableSkill(state, playerId) {
  const skillId = state.players[opponentOf(playerId)].lastSkillId;
  return skillId ? getSkillDefinition(skillId) : null;
}

/**
 * What `viewerId` is allowed to know about a Persona's affinities.
 * Your own Personas are fully visible; the opponent's are masked until struck.
 */
export function visibleAffinities(state, persona, viewerId) {
  const { weaknesses, resists } = affinitiesOf(persona);
  if (persona.owner === viewerId) {
    return { weaknesses: [...weaknesses], resists: [...resists], revealed: 'all' };
  }
  const revealed = new Set(persona.revealedTypes);
  return {
    weaknesses: weaknesses.filter((t) => revealed.has(t)),
    resists: resists.filter((t) => revealed.has(t)),
    revealed: [...persona.revealedTypes],
  };
}

/** Deep copy for the reducer. State is plain JSON, so this is total. */
export function cloneState(state) {
  return typeof structuredClone === 'function'
    ? structuredClone(state)
    : JSON.parse(JSON.stringify(state));
}

/** Convenience for UI/bot: the card definition behind a hand entry. */
export function handCardDefinition(entry) {
  return getCard(entry.cardId);
}

/* ------------------------------------------------------------------ *
 * The Gallows
 * ------------------------------------------------------------------ */

/**
 * What a Gallows meal is worth.
 *
 * The ONLY place the food/eater level comparison is made. The legal-action
 * list, the action handler, the bot's valuation and the confirmation panel all
 * read this, so the tier the UI previews before you click is by construction
 * the tier you get.
 *
 * Pure: it takes levels and a passive id rather than reaching into state, so it
 * works just as well for a Persona card still sitting in hand.
 *
 * @param eaterLevel   level of the Persona doing the eating
 * @param foodLevel    printed/current level of the Persona being fed to it
 * @param foodPassive  the food's passive id, or null
 * @param eaterMaxHp   used only to turn the junk-tier heal into a flat number
 */
export function gallowsMeal(eaterLevel, foodLevel, foodPassive = null, eaterMaxHp = 0) {
  // Sacrificial Lamb rides on top of whichever tier the levels put it in, so
  // the hierarchy holds: a Lamb feast still beats a Lamb meal, and a Lamb
  // always beats the same food without it.
  const lamb = foodPassive === 'sacrificial-lamb' ? CONFIG.GALLOWS_LAMB_BONUS : 0;

  if (foodLevel >= eaterLevel) {
    return {
      tier: 'feast',
      label: 'Feast',
      levels: CONFIG.GALLOWS_FEAST_LEVELS + lamb,
      heal: 0,
      // Eating something at or above your own level is the strongest play the
      // Gallows offers, so it is the one that costs a whole action.
      usesAction: true,
      nourishing: true,
      // Both nourishing tiers may pass on one skill; only the feast can hand
      // over the food's PASSIVE instead, and only the feast leaves a permanent
      // mark on the body that ate.
      canInherit: true,
      canInheritPassive: true,
      statBump: CONFIG.GALLOWS_STAT_BUMP,
    };
  }

  if (foodLevel >= eaterLevel - CONFIG.COMEBACK_FARM_GAP) {
    return {
      tier: 'meal',
      label: 'Meal',
      levels: CONFIG.GALLOWS_LEVELS + lamb,
      heal: 0,
      usesAction: true,
      nourishing: true,
      canInherit: true,
      // A passive is the food's whole identity; handing one over takes food
      // that had grown to your own size. See CONFIG for why that gate matters.
      canInheritPassive: false,
      statBump: 0,
    };
  }

  return {
    tier: 'junk',
    label: 'Junk',
    levels: 0,
    heal: Math.round(eaterMaxHp * CONFIG.GALLOWS_JUNK_HEAL),
    // Free: binning a card the board has long outgrown is housekeeping, not a
    // play, and charging a turn for it meant nobody ever did it.
    usesAction: false,
    nourishing: false,
    // Nothing that far beneath you has anything left to teach.
    canInherit: false,
    canInheritPassive: false,
    statBump: 0,
  };
}

/**
 * The stat a Gallows feast permanently raises: whichever of the three combat
 * stats the eater's card grows fastest, ties broken in printed order.
 *
 * DESIGN NOTE: `statGrowth` also carries hp and sp, and both grow by far larger
 * numbers than str/mag/end — +1 HP on a 60 HP body is nothing anyone would
 * notice, so the bump deliberately looks only at the three stats that move
 * damage. Read here and nowhere else, so the Rules screen, the confirm dialog
 * and the reducer can never disagree about which stat is coming.
 */
export const GALLOWS_BUMP_STATS = Object.freeze(['strength', 'magic', 'endurance']);

export function gallowsBumpStat(cardId) {
  const growth = getPersona(cardId).statGrowth ?? {};
  let best = GALLOWS_BUMP_STATS[0];
  for (const stat of GALLOWS_BUMP_STATS) {
    if ((growth[stat] ?? 0) > (growth[best] ?? 0)) best = stat;
  }
  return best;
}

/**
 * The skills a piece of Gallows food could pass on — the same rule fusion uses:
 * a Persona on the field offers everything it can currently cast (printed and
 * inherited alike), a card still in hand offers only what its printed level has
 * unlocked. Anything the eater already knows is dropped, because inheriting it
 * would change nothing.
 *
 * One list, read by the legal-action builder and by the reducer that validates
 * the choice, so the UI can never offer a skill the engine would refuse.
 */
export function gallowsInheritOptions(state, food = {}, eater = null, { passives = false } = {}) {
  const { persona = null, cardId = null } = food;
  let offered;
  let foodPassive;
  if (persona) {
    offered = personaSkills(state, persona);
    foodPassive = persona.passive ?? null;
  } else if (cardId) {
    const card = getPersona(cardId);
    offered = card.skills.filter((s) => s.unlockLevel <= card.level);
    foodPassive = card.passive || null;
  } else {
    return [];
  }

  const known = eater ? new Set(personaSkills(state, eater).map((s) => s.id)) : new Set();
  const out = offered
    .filter((s) => !known.has(s.id))
    .map((s) => ({ id: s.id, name: s.name, kind: 'skill' }));

  // The food's passive, offered INSTEAD of a skill and only on the top tier —
  // see gallowsMeal. Any passive in the game may move this way; the gate is the
  // price (food grown to the eater's own level), not a list of approved ones.
  // Dropped when the eater already has it, for the same reason a known skill is.
  if (passives && foodPassive && (!eater || (eater.passive ?? null) !== foodPassive)) {
    // The display name is filled in by legal.js, which owns the passive table;
    // resolving it here would make state.js and passives.js import each other.
    out.push({
      id: `${PASSIVE_CHOICE_PREFIX}${foodPassive}`,
      name: foodPassive,
      kind: 'passive',
      passiveId: foodPassive,
    });
  }
  return out;
}
