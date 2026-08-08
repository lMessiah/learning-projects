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
import { getCard, getPersona } from '../data/cards.js';
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
} from './state.js';

export const DIFFICULTIES = Object.freeze([
  { id: 'easy', label: 'Easy', blurb: 'Plays at random. Never goes looking for your weaknesses.' },
  { id: 'medium', label: 'Medium', blurb: 'Exploits weaknesses it has discovered, heals when hurt, hits hard.' },
  { id: 'brutal', label: 'Brutal', blurb: 'Knows every weakness from turn 1. Chains One Mores, buffs, and fuses.' },
  { id: 'chaos', label: 'Chaos', blurb: 'Random, but drawn to the biggest number on the board. Swingy.' },
]);

const HEAL_THRESHOLD = 0.3; // "heals when a Persona is under 30% HP"
const MAX_ACTIONS_PER_TURN = 40; // safety net against a scoring loop

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
  const card = getPersona(persona.cardId);
  const knows = difficulty === 'brutal' || persona.revealedTypes.includes(damageType);
  if (!knows) return 'neutral';
  if (card.weaknesses.includes(damageType)) return 'weak';
  if (card.resists.includes(damageType)) return 'resist';
  return 'neutral';
}

/**
 * Damage the bot *expects*, using only what it knows. Mirrors damage.js but
 * substitutes perceived affinity for the real one.
 */
function estimateDamage(attacker, defender, { power, damageType, category }, difficulty) {
  const cat = category || skillCategory(damageType);
  const atkStat = Math.max(1, cat === 'phys' ? attacker.strength : attacker.magic);
  const base = (power * atkStat) / (atkStat + Math.max(0, defender.endurance));

  const affinity = perceivedAffinity(defender, damageType, difficulty);
  const affinityMult = affinity === 'weak' ? CONFIG.WEAK_MULT : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;

  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;
  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;
  const guardMult = defender.guarding ? CONFIG.GUARD_MULT : 1;
  const shockMult = hasAilment(defender, 'shock') ? CONFIG.SHOCK_TAKEN_MULT : 1;
  const wantedCharge = cat === 'phys' ? 'charge' : 'concentrate';
  const chargeMult = attacker.charges.includes(wantedCharge) ? CONFIG.CHARGE_MULT : 1;

  return {
    amount: Math.max(0, Math.round(base * affinityMult * attackMult * defenseMult * guardMult * shockMult * chargeMult)),
    affinity,
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

  if (action.type === 'ATTACK') {
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };
    return estimateDamage(attacker, target, { power: CONFIG.BASIC_ATTACK_POWER, damageType: 'phys', category: 'phys' }, difficulty);
  }

  if (action.type === 'USE_SKILL') {
    const skill = personaSkills(state, attacker).find((s) => s.id === action.skillId);
    if (!skill) return { amount: 0, affinity: 'neutral' };
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };

    if (skill.effect.kind === 'instakill') {
      const affinity = perceivedAffinity(target, skill.type, difficulty);
      let chance = skill.effect.chance;
      if (affinity === 'weak') chance *= 2;
      if (affinity === 'resist') chance *= 0.5;
      if (target.guarding) chance *= 0.5;
      // Value an instant kill as a fraction of the target's remaining HP.
      return { amount: Math.min(1, chance) * target.hp, affinity, instakill: true };
    }
    if (skill.effect.kind !== 'damage') return { amount: 0, affinity: 'neutral' };
    return estimateDamage(attacker, target, { power: skill.power, damageType: skill.type, category: skillCategory(skill.type) }, difficulty);
  }

  if (action.type === 'PLAY_SPECIAL') {
    const card = getCard(action.cardId ?? '');
    if (card?.effect?.kind !== 'damage') return { amount: 0, affinity: 'neutral' };
    const category = card.effect.statSource === 'magic' ? 'magic' : attacker.magic >= attacker.strength ? 'magic' : 'phys';
    if (card.effect.target === 'enemyAll') {
      const total = livingField(state, foeId).reduce(
        (sum, target) =>
          sum + estimateDamage(attacker, target, { power: card.effect.power, damageType: card.effect.damageType, category }, difficulty).amount,
        0
      );
      return { amount: total, affinity: 'neutral' };
    }
    const target = targetOf();
    if (!target) return { amount: 0, affinity: 'neutral' };
    return estimateDamage(attacker, target, { power: card.effect.power, damageType: card.effect.damageType, category }, difficulty);
  }

  return { amount: 0, affinity: 'neutral' };
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
      const { amount, affinity, instakill } = actionDamage(state, action, difficulty);

      if (action.type === 'USE_SKILL') {
        const skill = personaSkills(state, active).find((s) => s.id === action.skillId);
        if (skill && skill.effect.kind !== 'damage' && skill.effect.kind !== 'instakill') {
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
      if (target && amount >= target.hp) score += 60; // finishing blow

      // A known weakness means a One More: an entire extra action.
      if (affinity === 'weak' && !turn?.oneMoreUsed && !instakill) {
        score += brutal ? 55 : 35;
      }
      if (affinity === 'resist') score -= 10;

      // Don't burn a big-ticket Special on a target that is nearly dead.
      if (action.type === 'PLAY_SPECIAL' && target && target.hp < amount * 0.4) score -= 25;

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
      if (count <= 1) return 90 + power; // never sit on an empty board
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

    case 'FUSE': {
      if (!brutal && difficulty !== 'medium') return 0;
      const result = getPersona(action.result);
      const parents = action.sacrifices.map((sac) => {
        const persona = findPersona(state, sac.uid);
        if (persona) return getPersona(persona.cardId);
        const entry = state.players[playerId].hand.find((c) => c.uid === sac.uid);
        return entry ? getPersona(entry.cardId) : null;
      });
      const parentPower = parents.reduce((sum, card) => sum + (card ? card.strength + card.magic + card.endurance : 0), 0);
      const resultPower = result.strength + result.magic + result.endurance;
      // Two bodies become one, so it has to be a clear upgrade to be worth it.
      const gain = resultPower - parentPower / 1.6;
      if (gain <= 0) return 0;
      if (livingField(state, playerId).length <= 2) return 0; // don't gut a thin board
      return brutal ? gain * 1.4 : gain * 0.6;
    }

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

/** Best damage a Persona could do to a target right now, for comparisons. */
function bestDamageFrom(state, attacker, defender, difficulty) {
  let best = estimateDamage(attacker, defender, { power: CONFIG.BASIC_ATTACK_POWER, damageType: 'phys', category: 'phys' }, difficulty).amount;
  for (const skill of personaSkills(state, attacker)) {
    if (skill.effect.kind !== 'damage') continue;
    const cat = skillCategory(skill.type);
    const affordable = cat === 'phys' ? attacker.hp > skill.hpCost : attacker.sp >= (skill.spCost ?? 0);
    if (!affordable) continue;
    best = Math.max(best, estimateDamage(attacker, defender, { power: skill.power, damageType: skill.type, category: cat }, difficulty).amount);
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

    case 'buff': {
      const target = effect.target === 'enemyActive' ? enemyActive : active;
      if (!target) return 0;
      const existing = buffOf(target, effect.stat);
      if (existing && existing.direction === effect.direction) return 1; // just a refresh
      const base = existing ? 26 : 18; // cancelling an enemy's buff is worth more
      return brutal ? base * 1.5 : difficulty === 'medium' ? base * 0.7 : base * 0.4;
    }

    case 'dispel': {
      const target = effect.target === 'enemyActive' ? enemyActive : active;
      if (!target) return 0;
      const hits = target.buffs.filter((b) => (effect.remove === 'buffs' ? b.direction === 'up' : b.direction === 'down'));
      return hits.length * (brutal ? 30 : 18);
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

    case 'transferSp': {
      const from = findPersona(state, action.fromUid);
      const to = findPersona(state, action.toUid);
      if (!from || !to) return 0;
      if (to.uid !== active?.uid) return 0; // only feed the Persona that is fighting
      const moved = Math.min(effect.amount, from.sp, to.maxSp - to.sp);
      return to.sp < 10 ? moved * 1.2 : moved * 0.2;
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

/** Highest score wins; ties are broken randomly so the bot isn't robotic. */
function pickBest(state, actions, difficulty, rng) {
  let best = -Infinity;
  let bestActions = [];
  for (const action of actions) {
    const score = scoreAction(state, action, difficulty);
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
export function explainBotActions(state, playerId, difficulty) {
  return getLegalActions(state, playerId)
    .map((action) => ({ action, score: Number(scoreAction(state, action, difficulty).toFixed(2)) }))
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
 * @returns {[object|null, object]} the action (null if there is nothing to do) and the next RNG
 */
export function chooseBotAction(state, playerId, difficulty, rng) {
  const legal = getLegalActions(state, playerId);
  if (!legal.length) return [null, rng];
  if (legal.length === 1) return [legal[0], rng];

  if (state.phase === 'starterSelect') {
    if (difficulty === 'easy' || difficulty === 'chaos') return pickRandom(legal, rng);
    return pickBest(state, legal, difficulty, rng);
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
  const [choice, next] = pickBest(state, legal, difficulty, rng);

  if (!isPassive(choice)) return [choice, next];

  // The scorer wanted to give up the turn. Only allow that if there is really
  // nothing better: an available attack always wins over passing.
  if (hasAction && damaging.length) return pickBest(state, damaging, difficulty, next);

  const [bestProductive, next2] = pickBest(state, productive, difficulty, next);
  if (scoreAction(state, bestProductive, difficulty) > 0) return [bestProductive, next2];

  return [endTurnFrom(legal, choice), next2];
}

/**
 * Play out a bot's entire turn, returning the actions in order. The UI applies
 * them one at a time so the player can follow along.
 */
export function planBotTurn(state, playerId, difficulty, rng, applyAction) {
  const actions = [];
  let current = state;
  let currentRng = rng;

  for (let i = 0; i < MAX_ACTIONS_PER_TURN; i++) {
    if (current.winner !== null) break;
    if (current.phase === 'playing' && current.activePlayer !== playerId) break;
    const [action, nextRng] = chooseBotAction(current, playerId, difficulty, currentRng);
    currentRng = nextRng;
    if (!action) break;
    actions.push(action);
    current = applyAction(current, action);
    if (action.type === 'END_TURN' || action.type === 'CHOOSE_STARTER') break;
  }

  return { actions, rng: currentRng, state: current };
}

export { MAX_ACTIONS_PER_TURN };
