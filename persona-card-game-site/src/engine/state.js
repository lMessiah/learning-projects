/**
 * Game state construction and read-only selectors.
 *
 * State is a plain JSON-serialisable object: no class instances, no functions,
 * no DOM references. `applyAction` (actions.js) always returns a fresh copy.
 */
import { CONFIG } from './config.js';
import { createRng, shuffle, sample } from './rng.js';
import { getCard, getPersona, getSkillDefinition, STARTER_POOL, SHOWTIMES } from '../data/cards.js';
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
    pendingDraw: null, // reserved by Fortune's Draw
    deck: [],
    hand: [], // [{ uid, cardId }]
    discard: [],
    field: [], // persona instances, including KO'd ones (KO'd don't occupy the cap)
    activeUid: null,
    koCount: 0, // how many of THIS player's Personas have been KO'd
    showtimesUsed: [], // duo ids already spent — once per match, per pair
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
    showtimes: 0, // duo attacks called
    gallows: 0, // Personas fed to another of your own
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

  for (let i = 0; i < 2; i++) {
    const [options, rng] = sample(state.rng, STARTER_POOL, 3);
    state.rng = rng;
    state.starterOptions[i] = options;
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
    fusionsPerformed: 0, // fusion is free, but rationed like an Item or Special
    gallowsUsed: 0, // one Persona may be fed to another per turn
    canTargetBench: false, // granted by Ambush for the WHOLE turn
    momentumUsed: false, // Momentum draws once a turn, however many cheap skills fly
    personasPlayed: 0,
  };
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

/** Can this Persona card be played to the field yet? */
export function canPlayPersonaCard(state, playerId, cardId) {
  return getPersona(cardId).level <= playableLevelCap(state, playerId);
}

/** Every skill a Persona can currently use: printed (unlocked) + inherited. */
export function personaSkills(state, persona) {
  const card = getPersona(persona.cardId);
  const printed = card.skills.filter((s) => s.unlockLevel <= persona.level);
  if (!persona.inheritedSkills.length) return printed;

  const known = new Set(printed.map((s) => s.id));
  const inherited = [];
  for (const skillId of persona.inheritedSkills) {
    if (known.has(skillId)) continue;
    known.add(skillId);
    const source = findSkillDefinition(skillId);
    if (source) inherited.push({ ...source, unlockLevel: 1, inherited: true });
  }
  return [...printed, ...inherited];
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
 * Duo attacks this player could call right now.
 *
 * A Showtime belongs to the PAIR, not to either Persona: both halves have to be
 * on your field and on their feet, and once spent it is gone for the match.
 *
 * DESIGN NOTE: neither partner has to be in the active slot. "Usable by either
 * partner" is about which one leads, and requiring a specific one would mean
 * spending your Persona change to line the duo up before you could ever use it
 * — on top of drawing and fielding both halves, which is already the cost.
 */
export function availableShowtimes(state, playerId) {
  const player = state.players[playerId];
  const standing = new Set(player.field.filter((p) => !p.ko && !p.knockedDown).map((p) => p.cardId));
  return SHOWTIMES.filter(
    (showtime) => !player.showtimesUsed?.includes(showtime.id) && showtime.pair.every((id) => standing.has(id))
  );
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
  };
}
