/**
 * Shared effect primitives.
 *
 * Every rule that changes a Persona goes through exactly one function here, so
 * a Persona skill, an Item and a Special that all say "Tarukaja" behave
 * identically. These mutate the *draft* state that `applyAction` cloned — they
 * are never called on a state the caller still holds a reference to.
 */
import { CONFIG, skillCategory as skillCategoryOf } from './config.js';
import { shuffle, sample, rollChance, nextFloat } from './rng.js';
import { getCard, getPersona, cardQuality, skillsAtLevel, DAMAGE_TYPES } from '../data/cards.js';
import { computeDamage, executeMultiplier, technicalFor, percentPowerAgainst, affinityOf } from './damage.js';
import {
  pushLog,
  opponentOf,
  livingField,
  totalRemainingHp,
  benchOf,
  bumpStat,
  recordTypeUsed,
  getActive as getActiveOf,
  personaSkills,
  hasAilment,
  affinitiesOf,
} from './state.js';
import {
  preventsKnockdown,
  enduresFatalBlow,
  counterReflection,
  revealsAllAffinities,
  passiveDamageMultiplier,
  spRegenFor,
  koDeficit,
} from './passives.js';

const nameOf = (persona) => getPersona(persona.cardId).name;

/* ------------------------------------------------------------------ *
 * Cards
 * ------------------------------------------------------------------ */

/**
 * Draw n cards. Running the deck dry shuffles the discard back in and adds a
 * stacking Fatigue counter; with both piles empty, the draw simply fizzles.
 */
export function drawCards(state, playerId, n) {
  const player = state.players[playerId];
  const drawn = [];
  for (let i = 0; i < n; i++) {
    if (player.deck.length === 0) {
      if (player.discard.length === 0) {
        pushLog(state, `${player.name} has no cards left to draw.`, 'system');
        break;
      }
      const [reshuffled, rng] = shuffle(state.rng, player.discard);
      state.rng = rng;
      player.deck = reshuffled;
      player.discard = [];
      player.fatigue += 1;
      player.reshuffles += 1;
      pushLog(
        state,
        `${player.name} ran out of cards! Discard reshuffled — Fatigue ${player.fatigue} ` +
          `(${CONFIG.FATIGUE_DAMAGE * player.fatigue} damage to all their Personas each turn).`,
        'fatigue'
      );
    }
    const index = pickDrawIndex(state, player);
    const [cardId] = player.deck.splice(index, 1);
    const entry = { uid: `c${state.nextUid++}`, cardId };
    player.hand.push(entry);
    drawn.push(entry);
    bumpStat(state, playerId, 'cardsDrawn');
    recordDrawAgainstFloor(state, playerId, cardId);
  }
  return drawn;
}

/**
 * How high a Persona draw is aiming right now.
 *
 * "Still drawing bad Personas on turn 27" is the failure this exists to stop.
 * The floor starts at zero, wakes up on DRAW_SCALE_START, and climbs one level
 * every DRAW_SCALE_RATE turns to DRAW_SCALE_CAP.
 */
export function drawLevelFloor(state) {
  const turn = state.turn ?? 0;
  if (turn < CONFIG.DRAW_SCALE_START) return 0;
  const climbed = Math.floor((turn - CONFIG.DRAW_SCALE_START) / CONFIG.DRAW_SCALE_RATE) + 1;
  return Math.min(CONFIG.DRAW_SCALE_CAP, climbed);
}

/**
 * Book-keeping for the balance simulator: how often a late-game Persona draw
 * actually clears the floor. Only counted once the floor has had time to bite,
 * which is what makes the number worth reading.
 */
const DRAW_FLOOR_SAMPLE_FROM = 10;

function recordDrawAgainstFloor(state, playerId, cardId) {
  if ((state.turn ?? 0) <= DRAW_FLOOR_SAMPLE_FROM) return;
  if (getCard(cardId).type !== 'persona') return;
  bumpStat(state, playerId, 'personaDrawsLate');
  if (getCard(cardId).level >= drawLevelFloor(state)) bumpStat(state, playerId, 'personaDrawsLateAboveFloor');
}

/**
 * Which card comes off the deck.
 *
 * Normally the top one. Three things bend that, all of them deterministic
 * through the seeded RNG so an online match stays reproducible:
 *
 *  - a **pending draw** (Fortune's Draw and friends) claims a specific card and
 *    is consumed whether or not one was found — explicit draw manipulation
 *    always wins over any of the weighting below;
 *  - **Momentum Draw** weights the whole deck toward stronger cards while the
 *    player is behind on the KO tally, scaling with the deficit;
 *  - the **draw-level floor** pushes down Personas that have fallen behind the
 *    turn count, so a long match stops dealing openers.
 *
 * With none of them in play every weight is 1, i.e. the plain top-of-deck draw.
 */
function pickDrawIndex(state, player) {
  if (player.pendingDraw) {
    const resolved = resolvePendingDraw(state, player);
    if (resolved !== -1) return resolved;
  }
  return weightedDrawIndex(state, player);
}

/**
 * Consume a reserved draw. Returns the deck index to take, or -1 when the
 * reservation found nothing — the reservation is spent either way, so a whiff
 * costs the card rather than hanging around waiting to come good.
 */
function resolvePendingDraw(state, player) {
  const request = player.pendingDraw;
  player.pendingDraw = null;

  const candidates = [];
  for (const [index, cardId] of player.deck.entries()) {
    const card = getCard(cardId);
    if (card.type !== 'persona') continue;
    if (request.arcana && card.arcana !== request.arcana) continue;
    if (request.types?.length && !answersAnyType(card, request.types)) continue;
    candidates.push({ index, card });
  }

  if (!candidates.length) {
    pushLog(
      state,
      request.types
        ? `Fate finds nothing — ${player.name} draws as normal.`
        : `${player.name} had no matching Persona left in the deck.`,
      'draw'
    );
    return -1;
  }

  // Fortune's Draw takes the first match; Arcana Reading takes the best one.
  const chosen = request.best
    ? candidates.reduce((a, b) => (b.card.level > a.card.level ? b : a))
    : candidates[0];
  pushLog(state, `${player.name}'s next draw was already decided.`, 'draw');
  return chosen.index;
}

/**
 * Could this Persona card actually punish one of those damage types, right out
 * of the pack? Only skills it has at its PRINTED level count — a Persona that
 * would learn Agi eleven levels from now is not an answer to anything today.
 */
export function answersAnyType(card, types) {
  return skillsAtLevel(card, card.level).some((skill) => types.includes(skill.type));
}

function weightedDrawIndex(state, player) {

  const deficit = koDeficit(state, player.id);
  const floor = drawLevelFloor(state);
  if ((deficit <= 0 && floor <= 0) || player.deck.length <= 1) return 0;

  const weights = player.deck.map((cardId) => {
    let weight = 1 + Math.max(0, deficit) * CONFIG.COMEBACK_MOMENTUM_FACTOR * cardQuality(cardId);
    if (floor > 0) {
      const card = getCard(cardId);
      // Only Persona cards have a level to fall behind. Items and Specials are
      // useful at any point in a match, so the floor leaves them alone.
      if (card.type === 'persona' && card.level < floor) {
        weight /= 1 + (floor - card.level) * CONFIG.DRAW_SCALE_PENALTY;
      }
    }
    return weight;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const [roll, rng] = nextFloat(state.rng);
  state.rng = rng;

  let cursor = roll * total;
  for (let i = 0; i < weights.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return i;
  }
  return player.deck.length - 1;
}

export function discardFromHand(state, playerId, handUid) {
  const player = state.players[playerId];
  const index = player.hand.findIndex((c) => c.uid === handUid);
  if (index === -1) throw new Error(`Card "${handUid}" is not in ${player.name}'s hand`);
  const [entry] = player.hand.splice(index, 1);
  player.discard.push(entry.cardId);
  return entry;
}

/* ------------------------------------------------------------------ *
 * HP / SP
 * ------------------------------------------------------------------ */

export function healPersona(state, persona, amount) {
  if (persona.ko) return 0;
  const before = persona.hp;
  persona.hp = Math.min(persona.maxHp, persona.hp + amount);
  const healed = persona.hp - before;
  if (healed > 0) pushLog(state, `${nameOf(persona)} recovered ${healed} HP.`, 'heal');
  return healed;
}

export function restoreSp(state, persona, amount) {
  if (persona.ko) return 0;
  const before = persona.sp;
  persona.sp = Math.min(persona.maxSp, persona.sp + amount);
  const gained = persona.sp - before;
  if (gained > 0) pushLog(state, `${nameOf(persona)} recovered ${gained} SP.`, 'heal');
  return gained;
}

export function fullRestore(state, persona) {
  if (persona.ko) return;
  persona.hp = persona.maxHp;
  persona.sp = persona.maxSp;
  pushLog(state, `${nameOf(persona)} was fully restored.`, 'heal');
}

export function revivePersona(state, persona, hpPercent) {
  if (!persona.ko) throw new Error(`${nameOf(persona)} is not knocked out`);
  persona.ko = false;
  persona.knockedDown = false;
  persona.hp = Math.max(1, Math.round(persona.maxHp * hpPercent));
  // HP comes back per the reviving effect; SP comes back in full, like every
  // other way a Persona enters play.
  persona.sp = persona.maxSp;
  // The KO already counted for the opponent and stays counted.
  pushLog(state, `${nameOf(persona)} was revived with ${persona.hp} HP and a full SP pool.`, 'heal');
  // A revived Persona returns to the bench; if the owner has no active, it steps up.
  promoteActiveIfEmpty(state, persona.owner);
}

/* ------------------------------------------------------------------ *
 * Buffs / debuffs  (the one shared implementation)
 * ------------------------------------------------------------------ */

/**
 * Apply a kaja/nda effect.
 *  - never stacks with itself: reapplying refreshes the duration
 *  - a buff and its opposing debuff cancel out, leaving the stat neutral
 */
export function applyBuff(state, persona, stat, direction, duration = CONFIG.BUFF_DURATION) {
  if (persona.ko) return 'noop';
  const existing = persona.buffs.find((b) => b.stat === stat);
  const label = `${stat === 'atk' ? 'attack' : 'defense'}`;

  if (!existing) {
    persona.buffs.push({ stat, direction, turnsLeft: duration });
    pushLog(
      state,
      `${nameOf(persona)}'s ${label} ${direction === 'up' ? 'rose' : 'fell'}! (${duration} turns)`,
      'buff'
    );
    return 'applied';
  }

  if (existing.direction === direction) {
    existing.turnsLeft = duration;
    pushLog(state, `${nameOf(persona)}'s ${label} change was refreshed. (${duration} turns)`, 'buff');
    return 'refreshed';
  }

  persona.buffs = persona.buffs.filter((b) => b !== existing);
  pushLog(state, `${nameOf(persona)}'s ${label} change was cancelled out.`, 'buff');
  return 'cancelled';
}

/** Dekaja / Dekunda. `which` is 'buffs' | 'debuffs' | 'all'. */
export function dispelBuffs(state, persona, which) {
  const before = persona.buffs.length;
  persona.buffs = persona.buffs.filter((b) => {
    if (which === 'all') return false;
    if (which === 'buffs') return b.direction !== 'up';
    return b.direction !== 'down';
  });
  const removed = before - persona.buffs.length;
  if (removed > 0) {
    pushLog(state, `${nameOf(persona)}'s ${which === 'buffs' ? 'buffs' : 'debuffs'} were removed!`, 'buff');
  }
  return removed;
}

export function addCharge(state, persona, charge) {
  if (persona.charges.includes(charge)) return false;
  persona.charges.push(charge);
  pushLog(
    state,
    `${nameOf(persona)} is ${charge === 'charge' ? 'charging up' : 'concentrating'}! Next ` +
      `${charge === 'charge' ? 'physical' : 'magic'} skill deals x${CONFIG.CHARGE_MULT} damage.`,
    'buff'
  );
  return true;
}

/* ------------------------------------------------------------------ *
 * Ailments
 * ------------------------------------------------------------------ */

export function applyAilment(state, persona, type) {
  if (persona.ko) return false;
  const duration = type === 'burn' ? CONFIG.BURN_DURATION : CONFIG.SHOCK_DURATION;
  const existing = persona.ailments.find((a) => a.type === type);
  if (existing) {
    existing.turnsLeft = duration; // refresh, never stack
  } else {
    persona.ailments.push({ type, turnsLeft: duration });
  }
  pushLog(state, `${nameOf(persona)} was inflicted with ${type === 'burn' ? 'Burn' : 'Shock'}!`, 'ailment');
  return true;
}

export function cureAilments(state, persona) {
  const removed = persona.ailments.length;
  persona.ailments = [];
  if (removed > 0) pushLog(state, `${nameOf(persona)}'s ailments were cured.`, 'heal');
  return removed;
}

/* ------------------------------------------------------------------ *
 * Damage, KO, levelling
 * ------------------------------------------------------------------ */

/** Record that a damage type has been used on a Persona — reveals its affinity. */
export function revealType(state, persona, damageType) {
  if (damageType === 'almighty') return; // nothing to learn
  if (!persona.revealedTypes.includes(damageType)) persona.revealedTypes.push(damageType);
}

/**
 * Lay a Persona's whole affinity chart bare (Analyst, Third Eye). Only the
 * types it actually reacts to are marked: `visibleAffinities` filters by
 * `revealedTypes`, so recording exactly the weaknesses and resists is enough.
 */
export function revealAllTypes(state, persona) {
  const { weaknesses, resists } = affinitiesOf(persona);
  const before = persona.revealedTypes.length;
  for (const type of [...weaknesses, ...resists]) {
    if (!persona.revealedTypes.includes(type)) persona.revealedTypes.push(type);
  }
  const learned = persona.revealedTypes.length > before;
  if (learned) pushLog(state, `${nameOf(persona)}'s weaknesses and resists are laid bare!`, 'info');
  return learned;
}

/**
 * Book the damage ledger the post-match screen reads.
 *
 * Done here, in the one funnel every source of damage passes through, so Burn
 * ticks and Counter reflections count exactly as much as a skill does. Damage a
 * player does to their own Personas is taken but never "dealt" — Fatigue is not
 * an achievement.
 */
function recordDamage(state, defender, dealt, killer) {
  if (dealt <= 0) return;
  bumpStat(state, defender.owner, 'damageTaken', dealt);
  if (!killer || killer.owner === defender.owner) return;
  bumpStat(state, killer.owner, 'damageDealt', dealt);
  killer.dmgDealt = (killer.dmgDealt ?? 0) + dealt;
}

/**
 * Rewrite a Persona's affinity chart.
 *
 * The point of this is that the card database is memorisable and the Brutal bot
 * reads it outright. After a rewrite the printed card no longer describes this
 * Persona: the new chart is drawn from the seeded RNG, everything anyone had
 * uncovered is forgotten, and `rewritten` tells the bot it has to find out the
 * hard way like everyone else.
 *
 * The SHAPE is preserved — the same number of weaknesses and the same number of
 * resists — so a rewrite never makes a Persona stronger or weaker on average,
 * only different. Weaknesses and resists are drawn as one disjoint set, so a
 * Persona can never end up both weak to and resistant to the same thing.
 *
 * @returns {boolean} false when there was nothing to rewrite
 */
export function rewriteAffinities(state, persona) {
  const current = affinitiesOf(persona);
  const wanted = current.weaknesses.length + current.resists.length;
  if (!wanted) return false; // nothing printed, nothing to scramble

  const pool = DAMAGE_TYPES.filter((type) => type !== 'almighty');
  const key = (list) => [...list].sort().join(',');
  const before = `${key(current.weaknesses)}|${key(current.resists)}`;

  // Redraw until it actually differs. Bounded rather than a while-loop: with a
  // seven-type pool a repeat is unlikely, and an engine must never be able to
  // spin on its own RNG.
  let picked = null;
  for (let attempt = 0; attempt < 8 && !picked; attempt++) {
    const [drawn, rng] = sample(state.rng, pool, wanted);
    state.rng = rng;
    const weaknesses = drawn.slice(0, current.weaknesses.length);
    const resists = drawn.slice(current.weaknesses.length);
    if (`${key(weaknesses)}|${key(resists)}` !== before) picked = { weaknesses, resists };
  }
  if (!picked) return false;

  persona.weaknesses = picked.weaknesses;
  persona.resists = picked.resists;
  persona.rewritten = true;
  persona.revealedTypes = []; // whatever anyone had learned is now wrong
  pushLog(
    state,
    `${nameOf(persona)}'s nature is rewritten. Every weakness and resist anyone had read is worthless.`,
    'special'
  );
  return true;
}

/**
 * Elements Twist of Fate may legally name against a target.
 *
 * Excludes almighty (nothing is weak to it), anything the target already
 * RESISTS — a resist beats a weakness, so creating one would be a dead card,
 * and the rule is "disallow it" rather than "strip the resist" — and anything
 * it is already weak to, which would do nothing.
 *
 * Exported because the legal-action list, the handler and the UI all need the
 * same answer, and a card whose picker offers a choice the handler then refuses
 * is exactly the soft-lock this codebase already had once.
 */
export function twistableElements(persona) {
  if (!persona) return [];
  const { weaknesses, resists } = affinitiesOf(persona);
  if (!weaknesses.length) return []; // nothing to replace
  return DAMAGE_TYPES.filter(
    (type) => type !== 'almighty' && !resists.includes(type) && !weaknesses.includes(type)
  );
}

/**
 * Which weakness the DEFENDER gives up.
 *
 * The card says the choice is theirs, and this is that choice made for them
 * deterministically rather than by a prompt — the engine has no way to stop
 * mid-action and ask, and a coin flip would not be "the opponent chooses" in
 * any meaningful sense.
 *
 * A defender always sheds a weakness you have already UNCOVERED before one you
 * have not: the uncovered one is the one actually being used against them, and
 * the hidden one still costs you a turn to find. Among equals, the fixed
 * damage-type order decides, so the whole thing is reproducible.
 */
export function twistSacrifice(persona) {
  const { weaknesses } = affinitiesOf(persona);
  if (!weaknesses.length) return null;
  const revealed = new Set(persona.revealedTypes ?? []);
  const rank = (type) => (revealed.has(type) ? 0 : 1) * 100 + DAMAGE_TYPES.indexOf(type);
  return [...weaknesses].sort((a, b) => rank(a) - rank(b))[0];
}

/**
 * Twist of Fate: swap one of the enemy active's weaknesses for one you name.
 *
 * The counterplay for "my deck cannot hit anything they are weak to". It does
 * not scramble the chart the way the rewrite Specials do — it makes one precise
 * edit, and pays for it by letting the defender pick what they lose.
 *
 * @returns {string|null} the weakness that was given up, or null if it could
 *                        not be done
 */
export function twistFate(state, persona, element) {
  const given = twistSacrifice(persona);
  if (given === null) return null;
  if (!twistableElements(persona).includes(element)) return null;

  const { weaknesses, resists } = affinitiesOf(persona);
  persona.weaknesses = weaknesses.map((type) => (type === given ? element : type));
  persona.resists = [...resists];
  // The printed card no longer describes it, exactly as after a rewrite.
  persona.rewritten = true;

  // The new weakness is public knowledge — that is the point of the card, and
  // it is what lets Whims of Fate fetch an answer for it immediately.
  if (!persona.revealedTypes.includes(element)) persona.revealedTypes.push(element);
  // What they gave up is no longer true, so nobody should still "know" it.
  persona.revealedTypes = persona.revealedTypes.filter((type) => type !== given);

  pushLog(
    state,
    `Fate twists around ${nameOf(persona)}: its ${given} weakness becomes a ${element} weakness, for all to see.`,
    'special'
  );
  return given;
}

/**
 * Deal already-computed damage. Returns { dealt, ko }.
 * `killer` gets the level-up credit if this drops the target.
 */
export function applyDamage(state, defender, amount, killer = null) {
  if (defender.ko) return { dealt: 0, ko: false };
  // Moonless Gown: nothing gets through, at the price of not acting.
  if (defender.warded) {
    pushLog(state, `${nameOf(defender)} is untouchable — the damage passes straight through.`, 'guard');
    return { dealt: 0, ko: false };
  }
  const dealt = Math.min(defender.hp, Math.max(0, amount));

  // Endure, once per match. Deliberately sits here rather than in resolveAttack
  // so it catches EVERY source of damage — a skill, a Counter, a Burn tick,
  // Fatigue. "Otherwise fatal" is a single rule with a single implementation.
  if (dealt >= defender.hp && enduresFatalBlow(defender)) {
    defender.endured = true;
    defender.hp = 1;
    pushLog(state, `${nameOf(defender)} endured the hit! (Endure)`, 'endure');
    recordDamage(state, defender, dealt - 1, killer);
    return { dealt: dealt - 1, ko: false, endured: true };
  }

  defender.hp -= dealt;
  recordDamage(state, defender, dealt, killer);
  if (defender.hp <= 0) {
    defender.hp = 0;
    koPersona(state, defender, killer);
    return { dealt, ko: true };
  }
  return { dealt, ko: false };
}

/** The single hardest blow a player has landed, and what threw it. */
function recordBiggestHit(state, attacker, defender, dealt, sourceName) {
  if (dealt <= 0) return;
  const stats = state.players[attacker.owner]?.stats;
  if (!stats) return;
  if (stats.biggestHit && stats.biggestHit.amount >= dealt) return;
  stats.biggestHit = {
    amount: dealt,
    source: sourceName,
    by: getPersona(attacker.cardId).name,
    target: getPersona(defender.cardId).name,
    turn: state.turn,
  };
}

const TECHNICAL_FLAVOUR = Object.freeze({
  burn: 'The blow fans the flames —',
  shock: 'The blow lands through the current —',
});

/**
 * Resolve a full attack: compute damage, apply it, handle weakness knockdown,
 * Technicals and the ailment rider.
 *
 * @returns {{ amount:number, weak:boolean, resisted:boolean, ko:boolean,
 *             knockedDown:boolean, technical:string|null, ailment:string|null }}
 */
export function resolveAttack(
  state,
  {
    attacker,
    defender,
    power,
    damageType,
    category,
    effect = {},
    consumeCharge = true,
    flat = false,
    // What to credit the hit to on the post-match screen: a skill name, a card
    // name, or "Attack". Only used for the biggest-hit line.
    sourceName = 'Attack',
  }
) {
  revealType(state, defender, damageType);
  const wasStanding = !defender.knockedDown && !defender.ko;

  // A percentage skill (Life Drain) computes its power from the target and then
  // resolves down the flat path — a share of their HP, modified only by
  // weakness, resist and guard, exactly like a Special that prints a number.
  const share = percentPowerAgainst(effect, defender);
  if (share !== null) {
    power = share;
    flat = true;
  }

  // Two board-wide modifiers ride on top of the usual formula. Dark Hour is
  // symmetric — it makes the whole round more dangerous for both sides. Phantom
  // Strike is armed by its Special and spends itself on the first weakness hit,
  // which is also what refunds the skill's SP back in the caller.
  const darkHour = state.darkHour?.turnsLeft > 0 ? CONFIG.DARK_HOUR_MULT : 1;
  const phantomArmed = Boolean(state.turnState?.phantomStrike) && attacker.owner === state.activePlayer;
  const preview = computeDamage({ attacker, defender, power, damageType, category, flat });
  const phantomHit = phantomArmed && preview.weak;

  // Execute (Hama / Mudo) and Technical are both read off the defender BEFORE
  // the hit lands, so what you can see on the board is what you get.
  const execute = executeMultiplier(defender, effect.execute);
  const technical = technicalFor(defender, damageType);

  const result = computeDamage({
    attacker,
    defender,
    power,
    damageType,
    category,
    flat,
    // A Technical from Shock replaces the plain Shock damage bonus rather than
    // stacking with it — they are the same idea, and x1.5 twice on top of a
    // free knockdown is not a combo, it is a coin flip that ends the game.
    ignoreShockBonus: technical === 'shock',
    passiveMult:
      passiveDamageMultiplier(state, attacker) *
      darkHour *
      execute *
      (technical ? CONFIG.TECHNICAL_MULT : 1) *
      (phantomHit ? CONFIG.PHANTOM_STRIKE_MULT : 1),
  });
  if (phantomHit) {
    state.turnState.phantomStrike = false;
    pushLog(state, `${nameOf(attacker)} struck from the shadows! (Phantom Strike)`, 'special');
  }

  // A multi-target effect resolves per target, so it opts out of consuming the
  // charge here and strips it once for the whole attack instead.
  if (result.chargeUsed && consumeCharge) {
    attacker.charges = attacker.charges.filter((c) => c !== result.chargeUsed);
  }

  const { dealt, ko } = applyDamage(state, defender, result.amount, attacker);

  bumpStat(state, attacker.owner, 'attacks');
  recordTypeUsed(state, attacker.owner, damageType);
  if (result.weak) bumpStat(state, attacker.owner, 'weaknessHits');
  if (dealt >= defender.maxHp * 0.25) bumpStat(state, defender.owner, 'heavyHitsTaken');
  recordBiggestHit(state, attacker, defender, dealt, sourceName);

  let text = `${nameOf(defender)} took ${dealt} damage`;
  if (result.weak) text += ' — Weakness!';
  else if (result.resisted) text += ' — Resisted.';
  else text += '.';
  pushLog(state, text, 'attack');

  // Life Drain and friends: the attacker takes back exactly what it dealt,
  // which is capped by its own ceiling like any other healing.
  if (effect.drain === 'hp' && dealt > 0 && !attacker.ko) {
    healPersona(state, attacker, dealt);
  }

  if (technical) {
    bumpStat(state, attacker.owner, 'technicals');
    pushLog(
      state,
      `TECHNICAL! ${TECHNICAL_FLAVOUR[technical]} ${nameOf(defender)} takes x${CONFIG.TECHNICAL_MULT} damage.`,
      'technical'
    );
  }

  // Analyst: probing an enemy with this Persona lays its whole affinity chart bare.
  if (dealt > 0 && revealsAllAffinities(attacker, defender)) revealAllTypes(state, defender);

  // Weakness knocks the target down, and so does a Shock Technical — hitting a
  // twitching Persona with something solid puts it on the floor. Guarding
  // prevents it, and so does Stalwart while the defender is still healthy.
  let knockedDown = false;
  if ((result.weak || technical === 'shock') && !ko) {
    if (defender.guarding) {
      pushLog(state, `${nameOf(defender)} guarded and stayed on its feet.`, 'attack');
    } else if (preventsKnockdown(defender)) {
      pushLog(state, `${nameOf(defender)} shrugged it off and stayed standing. (Stalwart)`, 'knockdown');
    } else if (!defender.knockedDown) {
      defender.knockedDown = true;
      knockedDown = true;
      bumpStat(state, attacker.owner, 'knockdowns');
      pushLog(state, `${nameOf(defender)} is knocked down!`, 'knockdown');
    }
  }

  // Counter: a physical hit on a standing holder comes back at the attacker.
  // Reflected damage is applied directly, so it can never counter a counter and
  // can never itself grant a One More.
  const reflected = counterReflection(defender, { damageType, dealt, wasStanding });
  if (reflected > 0 && !attacker.ko) {
    pushLog(state, `${nameOf(defender)} counters for ${reflected} damage! (Counter)`, 'attack');
    applyDamage(state, attacker, reflected, defender);
  }

  // Ailment rider (Burn from fire, Shock from elec).
  let ailment = null;
  if (!ko && effect.ailment && dealt > 0) {
    const [inflicted, rng] = rollChance(state.rng, effect.ailmentChance ?? 0);
    state.rng = rng;
    if (inflicted) {
      applyAilment(state, defender, effect.ailment);
      ailment = effect.ailment;
    }
  }

  return {
    amount: dealt,
    weak: result.weak,
    resisted: result.resisted,
    ko,
    knockedDown,
    technical,
    ailment,
    chargeUsed: result.chargeUsed,
    phantom: phantomHit,
  };
}

export function koPersona(state, persona, killer = null) {
  if (persona.ko) return;
  persona.ko = true;
  persona.hp = 0;
  persona.knockedDown = false;
  persona.guarding = false;
  persona.buffs = [];
  persona.ailments = [];
  persona.charges = [];

  const owner = state.players[persona.owner];
  owner.koCount += 1;
  pushLog(
    state,
    `${nameOf(persona)} was knocked out! (${owner.name}: ${owner.koCount}/${CONFIG.KO_TARGET})`,
    'ko'
  );

  // The KO timeline the post-match screen reads. Bounded by KO_TARGET x 2, so
  // unlike the log it never has to forget anything.
  if (!state.koTimeline) state.koTimeline = [];
  state.koTimeline.push({
    turn: state.turn,
    owner: persona.owner,
    cardId: persona.cardId,
    level: persona.level,
    killerCardId: killer && killer.owner !== persona.owner ? killer.cardId : null,
    killerOwner: killer && killer.owner !== persona.owner ? killer.owner : null,
  });

  if (killer && !killer.ko && killer.owner !== persona.owner) {
    killer.kos = (killer.kos ?? 0) + 1;
    const levels = levelsEarnedFor(killer, persona);
    if (levels > 0) levelUp(state, killer, levels);
    else {
      pushLog(
        state,
        `${nameOf(killer)} learned nothing from that — ${nameOf(persona)} was ${killer.level - persona.level} levels below it.`,
        'levelup'
      );
    }
  }

  if (owner.activeUid === persona.uid) {
    owner.activeUid = null;
    // Losing your active with nothing to send out is the board-management
    // mistake worth telling a player about afterwards.
    if (!livingField(state, persona.owner).length) bumpStat(state, persona.owner, 'koWithEmptyBench');
    promoteActiveIfEmpty(state, persona.owner);
  }
}

/**
 * DESIGN NOTE: when the active Persona is KO'd, the first living bench Persona
 * steps up automatically and it does NOT consume the owner's persona change for
 * the turn — otherwise a KO on the opponent's turn would silently eat it.
 */
export function promoteActiveIfEmpty(state, playerId) {
  const player = state.players[playerId];
  if (player.activeUid) return null;
  const next = player.field.find((p) => !p.ko);
  if (!next) return null;
  player.activeUid = next.uid;
  pushLog(state, `${nameOf(next)} stepped up as ${player.name}'s active Persona.`, 'swap');
  return next;
}

/**
 * How many levels a KO is worth to the Persona that scored it.
 *
 *  - beating something well below you teaches nothing (COMEBACK_FARM_GAP), so a
 *    strong Persona cannot farm a weak board into an unbeatable one;
 *  - beating something well above you is worth double (LEVEL_UP_GAP);
 *  - anything in between is worth one level.
 */
export function levelsEarnedFor(killer, victim) {
  if (killer.level - victim.level >= CONFIG.COMEBACK_FARM_GAP) return 0;
  return victim.level >= killer.level + CONFIG.LEVEL_UP_GAP ? 2 : 1;
}

export function levelUp(state, persona, levels) {
  const card = getPersona(persona.cardId);
  const growth = card.statGrowth;
  const before = persona.level;
  for (let i = 0; i < levels; i++) {
    persona.level += 1;
    persona.strength += growth.strength || 0;
    persona.magic += growth.magic || 0;
    persona.endurance += growth.endurance || 0;
    persona.maxHp += growth.hp || 0;
    persona.hp += growth.hp || 0;
    persona.maxSp += growth.sp || 0;
    persona.sp += growth.sp || 0;
  }
  pushLog(state, `${nameOf(persona)} grew to level ${persona.level}!`, 'levelup');

  const unlocked = card.skills.filter((s) => s.unlockLevel > before && s.unlockLevel <= persona.level);
  for (const skill of unlocked) {
    pushLog(state, `${nameOf(persona)} learned ${skill.name}!`, 'levelup');
  }
  return unlocked;
}

/* ------------------------------------------------------------------ *
 * Win condition
 * ------------------------------------------------------------------ */

/**
 * Evaluate the win condition. Called after every action so a simultaneous KO
 * is judged once, on the whole batch, rather than per-Persona.
 */
export function evaluateGameEnd(state) {
  if (state.winner !== null) return state;

  const down = [0, 1].map((id) => state.players[id].koCount >= CONFIG.KO_TARGET);

  if (state.suddenDeath) {
    const delta0 = state.players[0].koCount - state.suddenDeath.koAt[0];
    const delta1 = state.players[1].koCount - state.suddenDeath.koAt[1];
    if (delta0 !== delta1) {
      // Whoever lost fewer Personas since sudden death began takes it.
      const winner = delta0 > delta1 ? 1 : 0;
      return endGame(state, winner, 'sudden-death');
    }
    return state;
  }

  if (down[0] && down[1]) {
    const hp0 = totalRemainingHp(state, 0);
    const hp1 = totalRemainingHp(state, 1);
    if (hp0 !== hp1) {
      const winner = hp0 > hp1 ? 0 : 1;
      pushLog(
        state,
        `Simultaneous knockout! ${state.players[winner].name} wins on remaining HP (${Math.max(hp0, hp1)} vs ${Math.min(hp0, hp1)}).`,
        'system'
      );
      return endGame(state, winner, 'simultaneous-ko-hp');
    }
    state.suddenDeath = { koAt: [state.players[0].koCount, state.players[1].koCount] };
    pushLog(state, 'Simultaneous knockout and remaining HP is tied — SUDDEN DEATH! Next KO wins.', 'system');
    return state;
  }

  if (down[0]) return endGame(state, 1, 'ko-target');
  if (down[1]) return endGame(state, 0, 'ko-target');
  return state;
}

export function endGame(state, winner, reason) {
  state.winner = winner;
  state.endReason = reason;
  state.phase = 'gameOver';
  pushLog(state, `${state.players[winner].name} wins!`, 'system');
  return state;
}

/* ------------------------------------------------------------------ *
 * Turn boundaries
 * ------------------------------------------------------------------ */

/** Start-of-turn upkeep for the player about to act. */
export function runStartOfTurn(state, playerId) {
  const player = state.players[playerId];

  for (const persona of livingField(state, playerId)) {
    if (persona.knockedDown) {
      persona.knockedDown = false;
      pushLog(state, `${nameOf(persona)} stood back up.`, 'knockdown');
    }
    persona.guarding = false; // guard lasted until the start of this turn
    if (persona.warded) {
      persona.warded = false;
      pushLog(state, `${nameOf(persona)} steps out of the gown and can act again.`, 'guard');
    }
  }

  if (player.fatigue > 0) {
    const damage = CONFIG.FATIGUE_DAMAGE * player.fatigue;
    pushLog(state, `Fatigue x${player.fatigue} bites — ${damage} damage to all of ${player.name}'s Personas.`, 'fatigue');
    for (const persona of livingField(state, playerId)) {
      applyDamage(state, persona, damage, null);
    }
  }

  // SP regenerates in the ACTIVE SLOT ONLY.
  //
  // Regenerating the whole field made SP a non-resource: a Persona could sit on
  // the bench for ten turns and walk in with a full pool, so the only real
  // budget was its printed maximum. Now the slot is the tap. Benched Personas
  // neither gain nor lose SP — they simply keep what they had, which makes
  // rotating a spent Persona out a genuine cost rather than a free refill.
  // Soul Battery doubles the tap, so it too only pays while its holder fights.
  const active = getActiveOf(state, playerId);
  if (active) restoreSpQuietly(active, spRegenFor(active, CONFIG.SP_REGEN_PER_TURN));

  drawCards(state, playerId, drawCountFor(state, playerId));
  return state;
}

/**
 * Underdog Draw: a player far enough behind on the KO tally draws more each
 * turn. Inert at parity or ahead, so it only ever shortens a losing streak.
 */
export function drawCountFor(state, playerId) {
  return koDeficit(state, playerId) >= CONFIG.COMEBACK_UNDERDOG_DEFICIT
    ? CONFIG.COMEBACK_UNDERDOG_DRAW
    : CONFIG.DRAW_PER_TURN;
}

/**
 * Could this Persona pay for the strongest damage skill it knows right now?
 *
 * "Strongest" is by printed power, which is what a player reaches for first.
 * Used only to measure SP pressure — a game where this is always true has no
 * SP economy at all.
 */
export function canAffordBestSkill(state, persona) {
  const damaging = personaSkills(state, persona).filter((s) => s.effect.kind === 'damage' && s.power > 0);
  if (!damaging.length) return true;
  const best = damaging.reduce((a, b) => (b.power > a.power ? b : a));
  if (skillCategoryOf(best.type) === 'phys') return persona.hp > (best.hpCost ?? 0);
  return persona.sp >= (best.spCost ?? 0);
}

function restoreSpQuietly(persona, amount) {
  persona.sp = Math.min(persona.maxSp, persona.sp + amount);
}

/** End-of-turn upkeep for the player who just acted (before passing the turn). */
export function runEndOfTurn(state, playerId) {
  const player = state.players[playerId];

  // The Dark Hour covers one full round, so it ticks on every turn boundary
  // rather than only on its caster's.
  if (state.darkHour?.turnsLeft > 0) {
    state.darkHour.turnsLeft -= 1;
    if (state.darkHour.turnsLeft <= 0) {
      state.darkHour = null;
      pushLog(state, 'The Dark Hour passes.', 'special');
    }
  }

  for (const persona of livingField(state, playerId)) {
    const burn = persona.ailments.find((a) => a.type === 'burn');
    if (burn) {
      pushLog(state, `${nameOf(persona)} is burning! ${CONFIG.BURN_DAMAGE} damage.`, 'ailment');
      applyDamage(state, persona, CONFIG.BURN_DAMAGE, null);
    }
  }

  // Tick durations on this player's Personas (including KO'd ones, harmlessly).
  for (const persona of player.field) {
    persona.buffs = persona.buffs
      .map((b) => ({ ...b, turnsLeft: b.turnsLeft - 1 }))
      .filter((b) => b.turnsLeft > 0);
    persona.ailments = persona.ailments
      .map((a) => ({ ...a, turnsLeft: a.turnsLeft - 1 }))
      .filter((a) => {
        if (a.turnsLeft > 0) return true;
        pushLog(state, `${nameOf(persona)}'s ${a.type === 'burn' ? 'Burn' : 'Shock'} wore off.`, 'ailment');
        return false;
      });
  }

  return state;
}

export { nameOf, opponentOf, affinityOf };
