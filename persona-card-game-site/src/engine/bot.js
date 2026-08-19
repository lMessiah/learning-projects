/**
 * Bot opponents — pure and deterministic, like the rest of the engine.
 *
 * `chooseBotAction(state, playerId, difficulty, rng) -> [action, nextRng]`
 *
 * The bot never mutates the game state and never calls Math.random(): it takes
 * its own RNG and hands back the advanced one. It only ever returns actions
 * that came out of `getLegalActions`, so it cannot cheat the rules — the one
 * sanctioned cheat is Brutal reading hidden weaknesses, which is a *knowledge*
 * advantage applied while scoring, not an illegal move.
 *
 * Difficulties:
 *   easy   - random legal moves; never deliberately targets weaknesses
 *   medium - heuristic; exploits weaknesses it has DISCOVERED, heals under 30%,
 *            otherwise uses the strongest affordable skill
 *   brutal - the medium heuristic plus full hidden-info knowledge from turn 1,
 *            deliberate One More setups, strategic buffs/debuffs and fusion
 *   chaos  - random, biased hard toward the highest-damage option; swingy
 */
import { CONFIG, skillCategory } from './config.js';
import { getCard, getPersona, getSkillDefinition, cardQuality } from '../data/cards.js';
import { nextInt, nextFloat } from './rng.js';
import { getLegalActions } from './legal.js';
import {
  opponentOf,
  getActive,
  livingField,
  koedField,
  personaSkills,
  buffOf,
  hasAilment,
  findPersona,
  mimicableSkill,
  affinitiesOf,
  comboMultiplier,
  emptyFieldStage,
} from './state.js';
import {
  chainsOneMore,
  preventsKnockdown,
  enduranceScaleFor,
  weaknessScaleFor,
  enduresFatalBlow,
  koDeficit,
  fusionLevelBonus,
  passiveOf,
} from './passives.js';
import { executeMultiplier, technicalFor } from './damage.js';
import { applyPlaystyle, preferredStarter } from './playstyles.js';

export const DIFFICULTIES = Object.freeze([
  { id: 'easy', label: 'Easy', blurb: 'Plays at random. Never goes looking for your weaknesses.' },
  { id: 'medium', label: 'Medium', blurb: 'Exploits weaknesses it has discovered, heals when hurt, hits hard.' },
  { id: 'brutal', label: 'Brutal', blurb: 'Knows every weakness from turn 1. Chains One Mores, buffs, and fuses.' },
  { id: 'chaos', label: 'Chaos', blurb: 'Random, but drawn to the biggest number on the board. Swingy.' },
]);

const HEAL_THRESHOLD = 0.3; // "heals when a Persona is under 30% HP"
const MAX_ACTIONS_PER_TURN = 40; // safety net against a scoring loop

/** Is there still a One More to be earned this turn? Trickster lifts the cap. */
function oneMoreAvailable(state, attacker, turn) {
  if (!turn) return false;
  return chainsOneMore(attacker) || turn.oneMoresGranted < CONFIG.MAX_ONE_MORE_PER_TURN;
}

/* ------------------------------------------------------------------ *
 * Knowledge
 * ------------------------------------------------------------------ */

/**
 * What this bot believes about a Persona's affinity to a damage type.
 * Easy ignores affinities entirely, so it can never *aim* for a weakness —
 * it still hits one by accident now and then, which is the point.
 */
function perceivedAffinity(persona, damageType, difficulty) {
  if (difficulty === 'easy') return 'neutral';
  if (damageType === 'almighty') return 'neutral';

  // Brutal's one sanctioned cheat is reading the CARD. A Persona whose chart
  // has been rewritten is no longer described by its card, so that cheat buys
  // nothing and Brutal has to uncover the new chart by hitting things — which
  // is exactly what the rewrite Specials are sold on.
  const knows = persona.rewritten
    ? persona.revealedTypes.includes(damageType)
    : difficulty === 'brutal' || persona.revealedTypes.includes(damageType);
  if (!knows) return 'neutral';

  const { weaknesses, resists } = affinitiesOf(persona);
  if (weaknesses.includes(damageType)) return 'weak';
  if (resists.includes(damageType)) return 'resist';
  return 'neutral';
}

/**
 * Damage the bot *expects*, using only what it knows. Mirrors damage.js but
 * substitutes perceived affinity for the real one.
 */
function estimateDamage(attacker, defender, { power, damageType, category, execute, comboMult = 1 }, difficulty) {
  const cat = category || skillCategory(damageType);
  const atkStat = Math.max(1, cat === 'phys' ? attacker.strength : attacker.magic);
  // Mirrors computeDamage's Endurance scaling. Without this the bot would
  // undervalue its own Corrosive attacker against exactly the walls the passive
  // exists to beat.
  const defStat = Math.max(0, defender.endurance * enduranceScaleFor(attacker, damageType));
  const base = (power * atkStat) / (atkStat + defStat);

  const affinity = perceivedAffinity(defender, damageType, difficulty);
  const affinityMult =
    affinity === 'weak' ? CONFIG.WEAK_MULT * weaknessScaleFor(defender) : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;

  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;
  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;
  const guardMult = defender.guarding ? CONFIG.GUARD_MULT : 1;
  // Both of the deterministic riders. Technical replaces the plain Shock bonus,
  // exactly as the real pipeline does, so the bot never overvalues the combo.
  const technical = technicalFor(defender, damageType);
  const technicalMult = technical ? CONFIG.TECHNICAL_MULT : 1;
  const shockMult = !technical && hasAilment(defender, 'shock') ? CONFIG.SHOCK_TAKEN_MULT : 1;
  const executeMult = executeMultiplier(defender, execute);
  const wantedCharge = cat === 'phys' ? 'charge' : 'concentrate';
  const chargeMult = attacker.charges.includes(wantedCharge) ? CONFIG.CHARGE_MULT : 1;

  return {
    amount: Math.max(
      0,
      Math.round(
        base * affinityMult * attackMult * defenseMult * comboMult * guardMult * shockMult * technicalMult * executeMult * chargeMult
      )
    ),
    affinity,
    technical,
  };
}

/** Damage an action is expected to do, or 0 if it isn't an attack. */
function actionDamage(state, action, difficulty) {
  const playerId = action.player;
  const attacker = getActive(state, playerId);
  if (!attacker) return { amount: 0, affinity: 'neutral' };
  const foeId = opponentOf(playerId);

  const targetOf = () =>
    (action.targetUid && findPersona(state, action.targetUid)) || getActive(state, foeId);

  // The knockdown combo the bot has already built this turn. Without it the bot
  // systematically under-reads its own damage mid-combo, which is exactly when
  // it most needs to know whether the next hit finishes something.
  const comboMult = playerId === state.activePlayer ? comboMultiplier(state) : 1;

  if (action.type === 'ATTACK') {
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };
    return estimateDamage(attacker, target, { power: CONFIG.BASIC_ATTACK_POWER, damageType: 'phys', category: 'phys', comboMult }, difficulty);
  }

  if (action.type === 'USE_SKILL') {
    const skill = personaSkills(state, attacker).find((s) => s.id === action.skillId);
    if (!skill) return { amount: 0, affinity: 'neutral' };
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };

    if (skill.effect.kind !== 'damage') return { amount: 0, affinity: 'neutral' };
    return estimateDamage(
      attacker,
      target,
      { power: skill.power, damageType: skill.type, category: skillCategory(skill.type), execute: skill.effect.execute, comboMult },
      difficulty
    );
  }

  // A Special is a card-level effect delivered by whoever holds the active slot.
  if (action.type === 'PLAY_SPECIAL') {
    const source = getCard(action.cardId ?? '');
    if (source?.effect?.kind !== 'damage') return { amount: 0, affinity: 'neutral' };
    const { effect } = source;
    const category = effect.statSource === 'magic' ? 'magic' : attacker.magic >= attacker.strength ? 'magic' : 'phys';
    // A flat Special ignores the attacker entirely, so estimating it through the
    // stat ratio would badly misprice it.
    const estimate = (target) =>
      effect.flat
        ? estimateFlat(target, effect, difficulty)
        : estimateDamage(attacker, target, { power: effect.power, damageType: effect.damageType, category }, difficulty);

    if (effect.target === 'enemyAll') {
      const total = livingField(state, foeId).reduce((sum, target) => sum + estimate(target).amount, 0);
      return { amount: total, affinity: 'neutral' };
    }
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };
    return estimate(target);
  }

  return { amount: 0, affinity: 'neutral' };
}

/** Flat Special damage: weakness, resist and guard, and nothing else. */
function estimateFlat(defender, effect, difficulty) {
  const affinity = perceivedAffinity(defender, effect.damageType, difficulty);
  const affinityMult =
    affinity === 'weak' ? CONFIG.WEAK_MULT * weaknessScaleFor(defender) : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;
  const guardMult = defender.guarding ? CONFIG.GUARD_MULT : 1;
  return { amount: Math.max(0, Math.round((effect.amount ?? effect.power ?? 0) * affinityMult * guardMult)), affinity };
}

/* ------------------------------------------------------------------ *
 * Scoring (medium / brutal)
 * ------------------------------------------------------------------ */

const hpRatio = (persona) => (persona.maxHp > 0 ? persona.hp / persona.maxHp : 0);

function healValue(state, playerId, targetUid, amount) {
  const own = livingField(state, playerId);
  const target = targetUid ? own.find((p) => p.uid === targetUid) : null;
  const candidates = target ? [target] : own;
  let best = 0;
  for (const persona of candidates) {
    const missing = persona.maxHp - persona.hp;
    if (missing <= 0) continue;
    const healed = Math.min(missing, amount >= 9999 ? missing : amount);
    // Healing only matters when something is actually in danger.
    const urgency = hpRatio(persona) < HEAL_THRESHOLD ? 3 : hpRatio(persona) < 0.6 ? 0.8 : 0.15;
    best = Math.max(best, healed * urgency);
  }
  return best;
}

function scoreAction(state, action, difficulty) {
  const playerId = action.player;
  const foeId = opponentOf(playerId);
  const active = getActive(state, playerId);
  const enemyActive = getActive(state, foeId);
  const brutal = difficulty === 'brutal';
  const turn = state.turnState;

  switch (action.type) {
    case 'CHOOSE_STARTER': {
      const card = getPersona(action.cardId);
      return card.strength + card.magic + card.endurance + card.hp / 4 + card.sp / 4;
    }

    case 'ATTACK':
    case 'USE_SKILL':
    case 'PLAY_SPECIAL': {
      const { amount, affinity, technical } = actionDamage(state, action, difficulty);

      if (action.type === 'USE_SKILL') {
        const skill = personaSkills(state, active).find((s) => s.id === action.skillId);
        if (skill && skill.effect.kind !== 'damage') {
          return scoreSupportEffect(state, action, skill.effect, difficulty, skill);
        }
      }
      if (action.type === 'PLAY_SPECIAL') {
        const card = getCard(action.cardId);
        if (card.effect.kind !== 'damage') return scoreSupportEffect(state, action, card.effect, difficulty, card);
      }

      if (amount <= 0) return 0;
      let score = amount;

      const target = (action.targetUid && findPersona(state, action.targetUid)) || enemyActive;
      // A finishing blow, unless Endure is still holding — in which case this
      // is an ordinary hit that happens to leave them on 1 HP.
      if (target && amount >= target.hp && !enduresFatalBlow(target)) score += 60;

      // A knockdown is only worth a One More when it lands on a STANDING
      // Persona: a guard and an already-downed target pay nothing. A KILLING
      // blow does pay — the engine knocks the target down before it removes it,
      // so a lethal weakness hit earns the One More too. A Shock Technical
      // knocks down in its own right, so it earns the same bonus without needing
      // a weakness. The cap applies unless the attacker chains.
      //
      // Stalwart is judged on the HP the target has RIGHT NOW, because that is
      // the HP the blow would arrive at. A lethal hit no longer slips past it:
      // if the target is healthy when it is struck, it shrugs the knockdown off
      // and dies standing, and the attacker collects nothing for it.
      const knocksDown = affinity === 'weak' || technical === 'shock';
      if (knocksDown && target && oneMoreAvailable(state, active, turn)) {
        const wouldKnockDown =
          !target.knockedDown && !target.guarding && !preventsKnockdown(target);
        if (wouldKnockDown) score += brutal ? 55 : 35;
      }
      if (affinity === 'resist') score -= 10;

      // Don't burn a big-ticket Special on a target that is nearly dead.
      if (action.type === 'PLAY_SPECIAL' && target && target.hp < amount * 0.4) {
        score -= 25;
      }

      return score;
    }

    case 'PLAY_ITEM': {
      const card = getCard(action.cardId);
      return scoreSupportEffect(state, action, card.effect, difficulty, card);
    }

    case 'PLAY_PERSONA': {
      // Board presence is how you avoid losing; keep a healthy bench.
      const count = livingField(state, playerId).length;
      if (count >= CONFIG.FIELD_CAP) return 0;
      const card = getPersona(action.cardId);
      const power = (card.strength + card.magic + card.endurance) / 3;
      // An empty field is not a board-management preference, it is a countdown
      // to losing the match outright. Nothing else on the list can outbid this,
      // and it climbs as the timer does.
      if (count === 0) return 1000 * (1 + emptyFieldStage(state, playerId)) + power;
      if (count <= 1) return 90 + power;
      if (count <= 3) return 45 + power / 2;
      return Math.max(4, 20 - count * 2);
    }

    case 'CHANGE_ACTIVE': {
      if (!active) return 50;
      const target = findPersona(state, action.targetUid);
      if (!target) return 0;

      let score = 0;
      // Retreat a dying active behind something healthier.
      if (hpRatio(active) < HEAL_THRESHOLD && hpRatio(target) > hpRatio(active) + 0.25) score += 40;
      if (hasAilment(active, 'shock')) score += 35; // it cannot act anyway
      if (active.knockedDown) score += 20;

      // Brutal swaps to whatever hits the current enemy hardest.
      if (brutal && enemyActive) {
        const bestNow = bestDamageFrom(state, active, enemyActive, difficulty);
        const bestNext = bestDamageFrom(state, target, enemyActive, difficulty);
        if (bestNext > bestNow * 1.5) score += 30;
      }
      return score;
    }

    case 'FUSE':
      return scoreFusion(state, action, difficulty);

    case 'GALLOWS':
      return scoreGallows(state, action, difficulty);

    case 'GUARD': {
      if (!active) return 0;
      let score = hpRatio(active) < HEAL_THRESHOLD ? 18 : 2;
      if (brutal && enemyActive && bestDamageFrom(state, active, enemyActive, difficulty) < 5) score += 10;
      return score;
    }

    case 'PASS':
      return 1; // better than nothing: it draws a card

    case 'END_TURN':
      return 0.5;

    default:
      return 0;
  }
}

/**
 * What a fusion is worth.
 *
 * Two bodies become one, so the question is never "is the result strong?" but
 * "is it stronger than what it costs me?". The costs differ sharply by zone: a
 * Persona on the field is board presence you are giving up, while one in hand
 * is a card you have not paid for yet — feeding the hand copy is close to free.
 * Sacrificial Lamb material is cheaper still, and pays the result extra levels.
 */
function scoreFusion(state, action, difficulty) {
  const playerId = action.player;
  const brutal = difficulty === 'brutal';
  if (!brutal && difficulty !== 'medium') return 0;

  const result = getPersona(action.result);
  const own = livingField(state, playerId);
  const active = getActive(state, playerId);
  const enemyActive = getActive(state, opponentOf(playerId));

  const parents = action.sacrifices.map((sac) => {
    const persona = findPersona(state, sac.uid);
    if (persona) return { card: getPersona(persona.cardId), persona, zone: 'field' };
    const entry = state.players[playerId].hand.find((c) => c.uid === sac.uid);
    return entry ? { card: getPersona(entry.cardId), persona: null, zone: 'hand' } : null;
  });
  if (parents.some((p) => !p)) return 0;

  const fieldParents = parents.filter((p) => p.zone === 'field').length;
  // Never fuse away the last of your board, and never fuse the Persona that is
  // currently holding the line if there is nothing to put in its place.
  if (own.length - fieldParents < 1) return 0;
  if (own.length <= 2 && fieldParents > 0) return 0;

  // An immediate lethal threat outranks any amount of long-term value.
  if (active && enemyActive) {
    const incoming = bestDamageFrom(state, enemyActive, active, difficulty);
    if (incoming >= active.hp && own.length - fieldParents <= 1) return 0;
  }

  const power = (card) => card.strength + card.magic + card.endurance;
  const bonusLevels = fusionLevelBonus(parents.map((p) => p.persona ?? { cardId: p.card.id, passive: p.card.passive }));

  const resultValue =
    power(result) +
    (result.level + bonusLevels) * 0.8 +
    result.skills.length * 4 +
    (result.passive ? 8 : 0);

  const cost = parents.reduce((sum, parent) => {
    const lamb = parent.card.passive === 'sacrificial-lamb';
    if (parent.zone === 'hand') return sum + power(parent.card) * (lamb ? 0.1 : 0.25);
    // Losing a body off the field costs presence as well as stats.
    const presence = own.length <= 4 ? 34 : 18;
    const level = parent.persona ? parent.persona.level : parent.card.level;
    return sum + (power(parent.card) * 0.7 + level * 0.5 + presence) * (lamb ? 0.55 : 1);
  }, 0);

  let gain = resultValue - cost;

  // Fusion costs the action, so it does not merely have to be worth doing — it
  // has to be worth more than the attack it displaces. Without this the bot
  // would fuse on a scale calibrated back when fusing was free, and give up
  // lethal swings to do it. The forgone damage is subtracted on the same scale
  // the attack scorer uses (score starts at `amount`, +60 for a finishing blow),
  // so the two are directly comparable rather than merely both being numbers.
  if (CONFIG.FUSION_USES_ACTION && active && enemyActive && !active.knockedDown) {
    const forgone = bestDamageFrom(state, active, enemyActive, difficulty);
    const lethal = forgone >= enemyActive.hp && !enduresFatalBlow(enemyActive);
    gain -= forgone + (lethal ? 60 : 0);
  }

  if (gain <= 0) return 0;
  return brutal ? gain * 1.6 : gain * 0.8;
}

/**
 * What feeding one Persona to another is worth.
 *
 * The same trade as a fusion, one size down: a body for a level. It is worth
 * doing with a card in hand that will never be worth playing, and almost never
 * worth doing with a body already holding the line — so the cost of field food
 * carries the board-presence penalty and hand food barely costs anything.
 */
function scoreGallows(state, action, difficulty) {
  const brutal = difficulty === 'brutal';
  if (!brutal && difficulty !== 'medium') return 0;

  const playerId = action.player;
  const eater = findPersona(state, action.eaterUid);
  if (!eater) return 0;

  const own = livingField(state, playerId);
  const fromField = action.food.zone === 'field';
  if (fromField && own.length <= 2) return 0; // never eat your way to an empty board

  const card = getPersona(action.foodCardId);
  const foodPersona = fromField ? findPersona(state, action.food.uid) : null;
  const level = foodPersona ? foodPersona.level : card.level;
  const lamb = (foodPersona ? passiveOf(foodPersona) : card.passive) === 'sacrificial-lamb';

  // The tier and its payout already rode in on the action, so the bot values
  // exactly what the rules will hand it.
  const LEVEL_VALUE = 16;
  let gain = action.nourishing
    ? action.levels * LEVEL_VALUE
    : Math.min(eater.maxHp - eater.hp, action.heal) * 0.6;

  // The expanded rewards. Both are free riders on a meal the bot was already
  // weighing, so they nudge rather than decide: a kept skill is worth about a
  // third of a level, and a permanent stat point rather less.
  if (action.inherit) gain += LEVEL_VALUE * 0.35;
  if (action.statBump) gain += action.statBumpAmount * LEVEL_VALUE * 0.25;

  const power = (c) => c.strength + c.magic + c.endurance;
  let cost = fromField
    ? (power(card) * 0.5 + level * 0.5 + (own.length <= 4 ? 30 : 16)) * (lamb ? 0.5 : 1)
    : power(card) * (lamb ? 0.08 : 0.2);

  // A junk meal costs no action, so the only thing it spends is the card — and
  // if the eater is at full HP there is nothing to weigh against that but the
  // tidiness of the board, which the bot does not care about.
  if (!action.usesAction) cost *= 0.35;

  const value = gain - cost;
  if (value <= 0) return 0;
  return brutal ? value * 1.3 : value * 0.7;
}

/** Best damage a Persona could do to a target right now, for comparisons. */
function bestDamageFrom(state, attacker, defender, difficulty) {
  let best = estimateDamage(attacker, defender, { power: CONFIG.BASIC_ATTACK_POWER, damageType: 'phys', category: 'phys' }, difficulty).amount;
  for (const skill of personaSkills(state, attacker)) {
    if (skill.effect.kind !== 'damage') continue;
    const cat = skillCategory(skill.type);
    const affordable = cat === 'phys' ? attacker.hp > skill.hpCost : attacker.sp >= (skill.spCost ?? 0);
    if (!affordable) continue;
    best = Math.max(
      best,
      estimateDamage(
        attacker,
        defender,
        { power: skill.power, damageType: skill.type, category: cat, execute: skill.effect.execute },
        difficulty
      ).amount
    );
  }
  return best;
}

/** Score the non-damage effects shared by skills, Items and Specials. */
function scoreSupportEffect(state, action, effect, difficulty, source) {
  const playerId = action.player;
  const foeId = opponentOf(playerId);
  const active = getActive(state, playerId);
  const enemyActive = getActive(state, foeId);
  const brutal = difficulty === 'brutal';
  const turn = state.turnState;

  switch (effect.kind) {
    case 'heal':
      return healValue(state, playerId, action.targetUid, effect.amount);

    case 'fullRestore': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target) return 0;
      return healValue(state, playerId, action.targetUid, 9999) + (target.maxSp - target.sp) * 0.4;
    }

    /**
     * Traesto. The bot pulls a Persona back for exactly one reason: it is about
     * to lose it. So the value is the damage it would have taken had it stayed,
     * which is roughly the HP it is missing — plus a large bonus for a body it
     * has actually invested levels in, because that is what a retreat saves.
     *
     * It refuses to empty its own board. That is a legal move and a human may
     * want it; the bot has no plan that needs it and the clock is fatal, so it
     * never spends an action to start one.
     */
    case 'retreat': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target) return 0;
      const own = livingField(state, playerId);
      if (own.length <= 1) return 0; // never leave the board bare on purpose

      const missing = target.maxHp - target.hp;
      const ratio = target.hp / target.maxHp;
      if (ratio > HEAL_THRESHOLD) return 0; // not in danger; the action is worth more elsewhere

      const printed = getPersona(target.cardId).level;
      const grown = Math.max(0, target.level - printed);
      return missing * 0.5 + grown * 14 + (target.knockedDown ? 20 : 0);
    }

    case 'restoreSp': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target) return 0;
      const missing = target.maxSp - target.sp;
      if (missing <= 0) return 0;
      // Only valuable when the Persona is actually starved of SP.
      const starved = target.sp < 10 && target.uid === active?.uid;
      return Math.min(missing, effect.amount) * (starved ? 1.6 : 0.25);
    }

    case 'cureAilments': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target || target.ailments.length === 0) return 0;
      return target.uid === active?.uid ? 30 : 12;
    }

    case 'revive': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target) return 0;
      return livingField(state, playerId).length <= 2 ? 70 : 35;
    }

    /**
     * A buff covers a whole side, so it is worth roughly what it covers: a
     * Tarukaja into three bodies is a far better card than the same Tarukaja
     * into a lone active. The per-body value is scaled down from the old
     * single-target number so a full field lands near where it used to and a
     * thin one lands below — otherwise the bot would buff a solo Persona at
     * triple the old price.
     */
    case 'buff': {
      const side = effect.target === 'enemyField' ? foeId : playerId;
      const targets = livingField(state, side);
      if (!targets.length) return 0;

      let value = 0;
      for (const target of targets) {
        const existing = buffOf(target, effect.stat);
        if (!existing) value += 12;
        // Opposite direction: this cast cancels it, which is the good case.
        else if (existing.direction !== effect.direction) value += 18;
        // Same direction already at the ceiling: this body gains nothing.
        else if (existing.turnsLeft >= CONFIG.BUFF_MAX_DURATION) value += 0;
        // Same direction with room: extending is real, but only worth the turns.
        else value += 3;
      }
      return brutal ? value * 1.5 : difficulty === 'medium' ? value * 0.7 : value * 0.4;
    }

    case 'dispel': {
      const side = effect.target === 'enemyField' ? foeId : playerId;
      const hits = livingField(state, side).reduce(
        (n, p) =>
          n + p.buffs.filter((b) => (effect.remove === 'buffs' ? b.direction === 'up' : b.direction === 'down')).length,
        0
      );
      return hits * (brutal ? 22 : 13);
    }

    case 'charge': {
      if (!active || active.charges.includes(effect.charge)) return 0;
      if (!enemyActive) return 0;
      // Only worth it if there is a big follow-up to spend it on this turn.
      const followUp = bestDamageFrom(state, active, enemyActive, difficulty);
      if (turn && turn.actionsRemaining <= 0) return 0;
      const wantsPhys = effect.appliesTo === 'phys';
      const suits = wantsPhys ? active.strength >= active.magic : active.magic >= active.strength;
      if (!suits) return 2;
      return brutal ? followUp * 0.9 : followUp * 0.35;
    }

    case 'grant': {
      if (effect.grant === 'targetBench') {
        // Worth it to snipe something hurt on the bench.
        const bench = livingField(state, foeId).filter((p) => p.uid !== enemyActive?.uid);
        if (!bench.length) return 0;
        const weakest = Math.min(...bench.map((p) => p.hp));
        return brutal ? Math.max(0, 60 - weakest) : 8;
      }
      if (effect.grant === 'extraPersonaChange') {
        return livingField(state, playerId).length > 1 && brutal ? 10 : 3;
      }
      return 0;
    }

    /**
     * A Skill Card is worth exactly what it adds that the student did not
     * already have — which is why the bot will happily put a Fire skill on a
     * Persona with none and ignore the same card for one that already knows it.
     */
    case 'teachSkill': {
      const student = action.targetUid ? findPersona(state, action.targetUid) : null;
      const taught = getSkillDefinition(effect.skillId);
      if (!student || !taught) return 0;
      if (personaSkills(state, student).some((s) => s.id === taught.id)) return 0;

      if (taught.effect.kind !== 'damage') return student.uid === active?.uid ? 14 : 6;
      if (!enemyActive) return 8;

      const cat = skillCategory(taught.type);
      const before = bestDamageFrom(state, student, enemyActive, difficulty);
      const after = estimateDamage(
        student,
        enemyActive,
        { power: taught.power, damageType: taught.type, category: cat, execute: taught.effect.execute },
        difficulty
      ).amount;
      // A coverage patch on the Persona actually fighting is worth far more
      // than the same card parked on the bench.
      return Math.max(4, (after - before) * (student.uid === active?.uid ? 0.8 : 0.35));
    }

    /**
     * A guaranteed ailment is only worth what the follow-up is worth, so this
     * prices the Technical it sets up rather than the ailment itself.
     *
     * Shock is the immediate one: it costs no action, any physical hit cashes
     * it in — and the basic attack is always a physical hit — and the Technical
     * knocks them down, which is a One More. Burn is the patient one: half a
     * Technical next turn, plus its ticks in the meantime.
     */
    case 'inflict': {
      if (!active || !enemyActive) return 0;
      const wanted = action.ailment ?? effect.ailments[0];
      if (hasAilment(enemyActive, wanted)) return 1; // just refreshing the timer

      const follow = bestDamageFrom(state, active, enemyActive, difficulty);
      const bonus = follow * (CONFIG.TECHNICAL_MULT - 1);

      if (wanted === 'shock') {
        const knocksDown =
          oneMoreAvailable(state, active, turn) &&
          !enemyActive.knockedDown &&
          !enemyActive.guarding &&
          !preventsKnockdown(enemyActive);
        // The 12 is their lost turn: a shocked Persona cannot act at all.
        return bonus + (knocksDown ? 30 : 0) + 12;
      }
      return bonus * 0.5 + CONFIG.BURN_DAMAGE * CONFIG.BURN_DURATION * 0.5;
    }

    /**
     * Twist of Fate: worth exactly the damage it unlocks.
     *
     * Score the named element by what our own board could actually do with it.
     * A weakness we cannot hit is worth nothing, so the bot naturally names the
     * element it has the most and the biggest skills in — which is also the
     * only sensible way to play the card.
     */
    case 'twistFate': {
      if (!active || !enemyActive) return 0;
      const element = action.element;
      if (!element) return 0;

      // The best skill we hold in that element, across the whole living field:
      // a weakness lasts, so it is worth opening for a Persona on the bench.
      let best = 0;
      for (const persona of livingField(state, playerId)) {
        for (const skill of personaSkills(state, persona)) {
          if (skill.type !== element || skill.effect.kind !== 'damage') continue;
          best = Math.max(best, skill.power ?? 0);
        }
      }
      if (element === 'phys') best = Math.max(best, CONFIG.BASIC_ATTACK_POWER);
      if (!best) return 0; // naming something we cannot hit is a wasted card

      // Roughly what the extra multiplier is worth, plus the One More a
      // weakness hit tends to buy.
      const gain = best * (CONFIG.WEAK_MULT - 1) * 0.5;
      return gain + (oneMoreAvailable(state, active, turn) ? 20 : 0);
    }

    case 'drainSp': {
      const target = (action.targetUid && findPersona(state, action.targetUid)) || enemyActive;
      if (!active || !target) return 0;
      const stolen = Math.min(effect.amount, target.sp);
      if (stolen <= 0) return 0;
      const gained = Math.min(stolen, active.maxSp - active.sp);
      // Denial is worth something on its own, but only when the SP was going to
      // buy them anything. Filling your own pool is what makes it a real play.
      const denial = target.sp - stolen < 6 ? stolen * 0.8 : stolen * 0.3;
      return gained * 1.2 + denial;
    }

    case 'transferSp': {
      const from = findPersona(state, action.fromUid);
      const to = findPersona(state, action.toUid);
      if (!from || !to) return 0;
      if (to.uid !== active?.uid) return 0; // only feed the Persona that is fighting
      const moved = Math.min(effect.amount, from.sp, to.maxSp - to.sp);
      return to.sp < 10 ? moved * 1.2 : moved * 0.2;
    }

    /* --- Strategic Specials ------------------------------------------- */

    case 'guaranteedDraw':
      // Worth most when the board is thin and a body is what you need.
      return livingField(state, playerId).length <= 2 ? 26 : 8;

    case 'fateFetch': {
      // A body that answers what is standing opposite you is worth more than
      // just any body, and worth most when you are behind — which is also the
      // point at which the card stops needing you to have found the weakness.
      if (!enemyActive) return 0;
      return koDeficit(state, playerId) >= CONFIG.WHIMS_DEFICIT ? 24 : 14;
    }

    case 'providence': {
      const top = action.providenceTop ?? [];
      const picked = action.discardIndexes ?? [];
      if (!top.length) return 0;
      // Throwing away a weak card is worth something and throwing away a strong
      // one costs, on the same 0..1 scale Momentum Draw weights draws by. That
      // makes "discard nothing" score zero, which is exactly right.
      let value = 0;
      for (const index of picked) value += (0.45 - cardQuality(top[index])) * 22;
      return Math.max(0, value);
    }

    case 'growth': {
      const bench = livingField(state, playerId).filter((p) => p.uid !== active?.uid);
      return bench.length * (brutal ? 9 : 5);
    }

    case 'forceSwitch': {
      if (!enemyActive) return 0;
      const bench = livingField(state, foeId).filter((p) => p.uid !== enemyActive.uid && !p.knockedDown);
      if (!bench.length) return 0;
      // Dragging out a Persona you cannot hurt is the whole point.
      const now = active ? bestDamageFrom(state, active, enemyActive, difficulty) : 0;
      const after = active ? Math.max(...bench.map((p) => bestDamageFrom(state, active, p, difficulty))) : 0;
      return Math.max(brutal ? 10 : 4, (after - now) * (brutal ? 0.8 : 0.3));
    }

    case 'reveal': {
      // Knowledge the bot already has on Brutal; genuinely useful below that.
      if (!enemyActive) return 0;
      if (brutal && !enemyActive.rewritten) return 3;
      const { weaknesses, resists } = affinitiesOf(enemyActive);
      const unknown = [...weaknesses, ...resists].filter((t) => !enemyActive.revealedTypes.includes(t));
      return unknown.length * 12;
    }

    case 'peekHand':
      // The bot cannot act on hidden information it was never given, so this is
      // cheap filler rather than a play it should build around.
      return 2;

    case 'recall': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target) return 0;
      const card = getPersona(target.cardId);
      const power = (card.strength + card.magic + card.endurance) / 3;
      // Getting a body back matters most when there is barely a board left.
      return (livingField(state, playerId).length <= 2 ? 55 : 20) + power / 2;
    }

    case 'swapHpSp': {
      if (!active) return 0;
      const wouldHp = Math.max(1, Math.min(active.maxHp, active.sp));
      const wouldSp = Math.min(active.maxSp, active.hp);
      // Only a good trade if it moves the resource you are actually short of.
      const hpGain = wouldHp - active.hp;
      const spGain = wouldSp - active.sp;
      if (hpGain <= 0 && spGain <= 0) return 0;
      const hpUrgency = hpRatio(active) < HEAL_THRESHOLD ? 1.4 : 0.3;
      return Math.max(0, hpGain * hpUrgency + Math.max(0, spGain) * 0.25);
    }

    case 'ward': {
      // Total immunity, at the price of a whole turn of doing nothing. Only
      // worth it when the alternative is losing the Persona outright.
      if (!active || active.warded || !enemyActive) return 0;
      const incoming = bestDamageFrom(state, enemyActive, active, difficulty);
      if (incoming < active.hp) return 0;
      return brutal ? 45 : 20;
    }

    case 'darkHour': {
      // Symmetric, so it only favours whoever hits harder right now.
      if (!active || !enemyActive) return 0;
      const mine = bestDamageFrom(state, active, enemyActive, difficulty);
      const theirs = bestDamageFrom(state, enemyActive, active, difficulty);
      return mine > theirs ? (brutal ? (mine - theirs) * 0.5 : 4) : 0;
    }

    case 'phantomStrike': {
      if (!active || !enemyActive) return 0;
      const best = bestDamageFrom(state, active, enemyActive, difficulty);
      return brutal ? best * 0.5 : best * 0.2;
    }

    case 'swapFree': {
      const target = action.targetUid ? findPersona(state, action.targetUid) : null;
      if (!target || !enemyActive) return 0;
      const now = active ? bestDamageFrom(state, active, enemyActive, difficulty) : 0;
      const after = bestDamageFrom(state, target, enemyActive, difficulty);
      // A free swap is pure upside when it improves the matchup.
      return Math.max(2, (after - now) * (brutal ? 0.7 : 0.3));
    }

    case 'shuffleTime':
      return 12;

    case 'evolve': {
      if (!active) return 0;
      const known = new Set(personaSkills(state, active).map((s) => s.id));
      const next = getPersona(active.cardId).skills.filter((s) => !known.has(s.id))[0];
      return next ? (brutal ? 26 : 14) : 0;
    }

    case 'mimic': {
      const skill = mimicableSkill(state, playerId);
      if (!skill || !active) return 0;
      if (skill.effect.kind === 'damage') {
        const target = enemyActive;
        if (!target) return 0;
        return estimateDamage(
          active,
          target,
          { power: skill.power, damageType: skill.type, category: skillCategory(skill.type), execute: skill.effect.execute },
          difficulty
        ).amount;
      }
      // A free cast of someone else's support skill is worth roughly what it
      // would be worth cast normally, minus the cost you did not pay.
      return scoreSupportEffect(state, action, skill.effect, difficulty, skill) * 0.9;
    }

    default:
      return 0;
  }
}

/* ------------------------------------------------------------------ *
 * Selection
 * ------------------------------------------------------------------ */

function pickRandom(list, rng) {
  const [index, next] = nextInt(rng, list.length);
  return [list[index], next];
}

/**
 * Highest score wins; ties are broken randomly so the bot isn't robotic.
 *
 * The playstyle is laid over the score HERE and nowhere else. Keeping it to one
 * seam means a playstyle can never disagree with the rules or with the scorer's
 * judgement of what is possible — it only re-ranks what the scorer already
 * approved of. See playstyles.js.
 */
function pickBest(state, actions, difficulty, rng, playstyle = 'normal') {
  let best = -Infinity;
  let bestActions = [];
  for (const action of actions) {
    const score = applyPlaystyle(scoreAction(state, action, difficulty), action, playstyle);
    if (score > best + 1e-9) {
      best = score;
      bestActions = [action];
    } else if (Math.abs(score - best) <= 1e-9) {
      bestActions.push(action);
    }
  }
  if (!bestActions.length) return [actions[0], rng];
  return pickRandom(bestActions, rng);
}

/** Chaos: weight by damage^2 so the biggest hit usually — not always — wins. */
function pickChaotic(state, actions, rng) {
  const weights = actions.map((action) => {
    if (action.type === 'END_TURN') return 0.35;
    const { amount } = actionDamage(state, action, 'chaos');
    return 1 + amount * amount * 0.02;
  });
  const total = weights.reduce((sum, w) => sum + w, 0);
  const [roll, next] = nextFloat(rng);
  let cursor = roll * total;
  for (let i = 0; i < actions.length; i++) {
    cursor -= weights[i];
    if (cursor <= 0) return [actions[i], next];
  }
  return [actions[actions.length - 1], next];
}

/**
 * Actions a bot must never take, at any difficulty.
 *
 * Resigning is legal on your turn and therefore appears in `getLegalActions`,
 * which is also the bot's move list. A Chaos bot picking uniformly from that
 * list would concede roughly one turn in twenty, so it is filtered out here
 * rather than being given a very negative score — a score can be tied with.
 */
const FORBIDDEN_TYPES = new Set(['RESIGN']);

const botLegalActions = (state, playerId) =>
  getLegalActions(state, playerId).filter((action) => !FORBIDDEN_TYPES.has(action.type));

/** Actions that give up the turn rather than doing something with it. */
const PASSIVE_TYPES = new Set(['PASS', 'END_TURN']);

const isPassive = (action) => PASSIVE_TYPES.has(action.type);
const isDamaging = (action) => action.type === 'ATTACK' || action.type === 'USE_SKILL' || action.type === 'PLAY_SPECIAL';

/** Everything that actually does something: attack, skill, item, special, swap, play, guard, fuse. */
const productiveActions = (legal) => legal.filter((a) => !isPassive(a));

const endTurnFrom = (legal, fallback) => legal.find((a) => a.type === 'END_TURN') ?? fallback;

/**
 * Score every legal action, highest first. Exposed for debugging — the UI logs
 * this each bot turn when the ?debugBot flag is set.
 */
export function explainBotActions(state, playerId, difficulty, playstyle = 'normal') {
  return botLegalActions(state, playerId)
    .map((action) => {
      const base = scoreAction(state, action, difficulty);
      return {
        action,
        base: Number(base.toFixed(2)),
        score: Number(applyPlaystyle(base, action, playstyle).toFixed(2)),
      };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Choose one action for the bot.
 *
 * Passivity rule (all difficulties): a bot never gives up its action while a
 * damaging move is on the table. Easy and Chaos additionally never pick PASS
 * unless it is the only thing left — passing used to sit in their random pools,
 * which made them look asleep roughly one turn in seven.
 *
 * @param playstyle a RESOLVED playstyle id — see playstyles.js. 'random' must be
 *                  resolved once at setup, not here, or the bot changes its mind
 *                  every turn.
 * @returns {[object|null, object]} the action (null if there is nothing to do) and the next RNG
 */
export function chooseBotAction(state, playerId, difficulty, rng, playstyle = 'normal') {
  const legal = botLegalActions(state, playerId);
  if (!legal.length) return [null, rng];
  if (legal.length === 1) return [legal[0], rng];

  if (state.phase === 'starterSelect') {
    // A playstyle built around a signature Persona takes it whenever it is on
    // offer, at every difficulty — the plan is the point, and an Easy Defensive
    // bot that opened on something other than Ara Mitama would not be playing
    // the playstyle the player picked. The signature is guaranteed to be offered
    // to its own flavour (STARTER_SIGNATURES), so this almost always fires.
    const wanted = preferredStarter(playstyle);
    const signature = wanted && legal.find((a) => a.type === 'CHOOSE_STARTER' && a.cardId === wanted);
    if (signature) return [signature, rng];

    if (difficulty === 'easy' || difficulty === 'chaos') return pickRandom(legal, rng);
    return pickBest(state, legal, difficulty, rng, playstyle);
  }

  const productive = productiveActions(legal);
  const damaging = legal.filter(isDamaging);
  const hasAction = state.turnState.actionsRemaining > 0;

  // Nothing worth doing — end the turn.
  if (!productive.length) return [endTurnFrom(legal, legal[0]), rng];

  if (difficulty === 'easy') {
    // Random legal moves, but never the do-nothing ones while alternatives exist.
    return pickRandom(productive, rng);
  }

  if (difficulty === 'chaos') {
    // Swingy, but still never asleep: weight only the productive options.
    return pickChaotic(state, productive, rng);
  }

  // --- medium / brutal --------------------------------------------------
  const [choice, next] = pickBest(state, legal, difficulty, rng, playstyle);

  if (!isPassive(choice)) return [choice, next];

  // The scorer wanted to give up the turn. Only allow that if there is really
  // nothing better: an available attack always wins over passing.
  if (hasAction && damaging.length) return pickBest(state, damaging, difficulty, next, playstyle);

  const [bestProductive, next2] = pickBest(state, productive, difficulty, next, playstyle);
  if (scoreAction(state, bestProductive, difficulty) > 0) return [bestProductive, next2];

  return [endTurnFrom(legal, choice), next2];
}

/**
 * Play out a bot's entire turn, returning the actions in order. The UI applies
 * them one at a time so the player can follow along.
 */
export function planBotTurn(state, playerId, difficulty, rng, applyAction, playstyle = 'normal') {
  const actions = [];
  let current = state;
  let currentRng = rng;

  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i++) {
    if (current.winner !== null) break;
    if (current.phase === 'playing' && current.activePlayer !== playerId) break;
    const [action, nextRng] = chooseBotAction(current, playerId, difficulty, currentRng, playstyle);
    currentRng = nextRng;
    if (!action) break;
    actions.push(action);
    current = applyAction(current, action);
    if (action.type === 'END_TURN' || action.type === 'CHOOSE_STARTER') break;
  }

  return { actions, rng: currentRng, state: current };
}

export { MAX_ACTIONS_PER_TURN };
