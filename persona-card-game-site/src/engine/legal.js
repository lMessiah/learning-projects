/**
 * `getLegalActions(state, playerId)` — every action the player may take right
 * now, as concrete, directly-applicable action objects.
 *
 * Used by the UI to light up controls and by the bot as its move list. Where an
 * action needs a choice the engine can't make (which skills a fusion inherits,
 * which cards to discard at the hand limit) a sensible default is filled in and
 * the alternatives are attached as metadata for the UI.
 */
import { CONFIG, skillCategory } from './config.js';
import { getCard, getPersona, FUSION_RECIPES } from '../data/cards.js';
import {
  opponentOf,
  getActive,
  livingField,
  benchOf,
  koedField,
  hasFieldRoom,
  canPlayPersonaCard,
  personaSkills,
  hasAilment,
} from './state.js';

/** Enemy Personas that may legally be targeted right now. */
function enemyTargets(state, playerId) {
  const foeId = opponentOf(playerId);
  if (state.turnState?.canTargetBench) return livingField(state, foeId);
  const active = getActive(state, foeId);
  return active ? [active] : [];
}

function canAffordSkill(persona, skill) {
  if (skillCategory(skill.type) === 'phys') return persona.hp > skill.hpCost;
  return persona.sp >= (skill.spCost ?? 0);
}

/** Targets an effect needs the player to choose, or null when it is automatic. */
function effectTargets(state, playerId, effect) {
  switch (effect.kind) {
    case 'heal':
      return effect.target === 'ownAll' ? null : livingField(state, playerId);
    case 'restoreSp':
    case 'fullRestore':
    case 'cureAilments':
      return livingField(state, playerId);
    case 'revive':
      return koedField(state, playerId);
    case 'damage':
      return effect.target === 'enemyAll' ? null : enemyTargets(state, playerId);
    default:
      return null; // buff / dispel / charge / grant hit fixed slots
  }
}

/** True when an effect has at least one thing to do. */
function effectIsUseful(state, playerId, effect) {
  const foeId = opponentOf(playerId);
  switch (effect.kind) {
    case 'heal':
      return effect.target === 'ownAll'
        ? livingField(state, playerId).some((p) => p.hp < p.maxHp)
        : livingField(state, playerId).some((p) => p.hp < p.maxHp);
    case 'restoreSp':
      return livingField(state, playerId).some((p) => p.sp < p.maxSp);
    case 'fullRestore':
      return livingField(state, playerId).some((p) => p.hp < p.maxHp || p.sp < p.maxSp);
    case 'cureAilments':
      return livingField(state, playerId).some((p) => p.ailments.length > 0);
    case 'revive':
      return koedField(state, playerId).length > 0 && hasFieldRoom(state, playerId);
    case 'buff':
      return effect.target === 'enemyActive' ? Boolean(getActive(state, foeId)) : Boolean(getActive(state, playerId));
    case 'dispel': {
      const target = effect.target === 'enemyActive' ? getActive(state, foeId) : getActive(state, playerId);
      if (!target) return false;
      return target.buffs.some((b) => (effect.remove === 'buffs' ? b.direction === 'up' : b.direction === 'down'));
    }
    case 'charge': {
      const active = getActive(state, playerId);
      return Boolean(active) && !active.charges.includes(effect.charge);
    }
    case 'grant':
      return true;
    case 'transferSp': {
      const own = livingField(state, playerId);
      return own.some((a) => a.sp > 0) && own.some((b) => b.sp < b.maxSp) && own.length >= 2;
    }
    case 'damage': {
      // Damage Specials are delivered BY your active Persona, so they need one.
      if (!getActive(state, playerId)) return false;
      return effect.target === 'enemyAll' ? livingField(state, foeId).length > 0 : enemyTargets(state, playerId).length > 0;
    }
    default:
      return false;
  }
}

/** Expand a card play into one action per legal target. */
function cardActions(state, playerId, entry, card, actionType) {
  if (!effectIsUseful(state, playerId, card.effect)) return [];

  const base = { type: actionType, player: playerId, handUid: entry.uid, cardId: card.id };

  if (card.effect.kind === 'transferSp') {
    const own = livingField(state, playerId);
    const out = [];
    for (const from of own) {
      if (from.sp <= 0) continue;
      for (const to of own) {
        if (to.uid === from.uid || to.sp >= to.maxSp) continue;
        out.push({ ...base, fromUid: from.uid, toUid: to.uid, amount: card.effect.amount });
      }
    }
    return out;
  }

  const targets = effectTargets(state, playerId, card.effect);
  if (!targets) return [base];
  return targets.map((target) => ({ ...base, targetUid: target.uid }));
}

/**
 * Every Persona you could feed into a fusion right now: your living field plus
 * any Persona cards in hand. Shared by the legal-action list and the UI panel
 * so the two can never disagree about what counts as material.
 */
export function fusionCandidates(state, playerId) {
  const player = state.players[playerId];
  return [
    ...livingField(state, playerId).map((persona) => {
      const card = getPersona(persona.cardId);
      return {
        zone: 'field',
        uid: persona.uid,
        cardId: persona.cardId,
        name: card.name,
        level: persona.level,
        arcana: card.arcana,
        skills: personaSkills(state, persona),
        isActive: player.activeUid === persona.uid,
      };
    }),
    ...player.hand
      .filter((entry) => getCard(entry.cardId).type === 'persona')
      .map((entry) => {
        const card = getPersona(entry.cardId);
        return {
          zone: 'hand',
          uid: entry.uid,
          cardId: card.id,
          name: card.name,
          level: card.level,
          arcana: card.arcana,
          skills: card.skills.filter((s) => s.unlockLevel <= card.level),
          isActive: false,
        };
      }),
  ];
}

const pairMatchesArcana = (a, b, [arcanaA, arcanaB]) =>
  (a.arcana === arcanaA && b.arcana === arcanaB) || (a.arcana === arcanaB && b.arcana === arcanaA);

/** Would this pair leave room on the field for the result? */
function pairFits(state, playerId, a, b) {
  const freed = [a, b].filter((c) => c.zone === 'field').length;
  return livingField(state, playerId).length - freed < CONFIG.FIELD_CAP;
}

/**
 * Describe every recipe for the UI: which are satisfiable right now, which
 * pairs would satisfy them, and — when they are not — exactly why.
 */
export function describeFusions(state, playerId) {
  const candidates = fusionCandidates(state, playerId);
  const hasAction = (state.turnState?.actionsRemaining ?? 0) > 0;

  return FUSION_RECIPES.map((recipe) => {
    const pairs = [];
    let bestCombined = 0;
    let anyArcanaPair = false;
    let blockedByRoom = false;

    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (!pairMatchesArcana(a, b, recipe.arcana)) continue;
        anyArcanaPair = true;
        const combined = a.level + b.level;
        bestCombined = Math.max(bestCombined, combined);
        if (combined < recipe.minCombinedLevel) continue;
        if (!a.skills.length || !b.skills.length) continue;
        if (!pairFits(state, playerId, a, b)) {
          blockedByRoom = true;
          continue;
        }
        pairs.push({ a, b, combined });
      }
    }

    // How many Personas of each arcana the recipe needs (handles same-arcana pairs).
    const need = {};
    for (const arcana of recipe.arcana) need[arcana] = (need[arcana] || 0) + 1;
    const missing = Object.entries(need)
      .filter(([arcana, count]) => candidates.filter((c) => c.arcana === arcana).length < count)
      .map(([arcana]) => arcana);

    let reason = null;
    if (pairs.length === 0) {
      if (missing.length) reason = `Need a ${missing.join(' and a ')} Persona`;
      else if (!anyArcanaPair) reason = `Need ${recipe.arcana.join(' + ')} at the same time`;
      else if (bestCombined < recipe.minCombinedLevel) reason = `Combined level ${bestCombined}/${recipe.minCombinedLevel}`;
      else if (blockedByRoom) reason = 'No room on your field for the result';
      else reason = 'No usable pair';
    } else if (!hasAction) {
      reason = 'No action left this turn';
    }

    return {
      recipe,
      result: getPersona(recipe.result),
      minCombinedLevel: recipe.minCombinedLevel,
      arcana: recipe.arcana,
      pairs,
      bestCombined,
      satisfiable: pairs.length > 0 && hasAction,
      reason,
    };
  });
}

function fusionActions(state, playerId) {
  if (state.turnState.actionsRemaining <= 0) return [];
  const candidates = fusionCandidates(state, playerId);
  const out = [];
  for (const recipe of FUSION_RECIPES) {
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (!pairMatchesArcana(a, b, recipe.arcana)) continue;
        if (a.level + b.level < recipe.minCombinedLevel) continue;
        if (!a.skills.length || !b.skills.length) continue;
        // Sacrificing field Personas frees their slots first, so only a fusion
        // fed entirely from hand can be blocked by a full field.
        if (!pairFits(state, playerId, a, b)) continue;

        out.push({
          type: 'FUSE',
          player: playerId,
          recipeId: recipe.id,
          result: recipe.result,
          sacrifices: [
            { zone: a.zone, uid: a.uid },
            { zone: b.zone, uid: b.uid },
          ],
          inherit: [a.skills[0].id, b.skills[0].id], // default choice
          inheritOptions: [a.skills.map((s) => s.id), b.skills.map((s) => s.id)],
          needsChoice: true,
        });
      }
    }
  }
  return out;
}

export function getLegalActions(state, playerId) {
  if (state.winner !== null) return [];

  if (state.phase === 'starterSelect') {
    if (state.players[playerId].field.length > 0) return [];
    return state.starterOptions[playerId].map((cardId) => ({ type: 'CHOOSE_STARTER', player: playerId, cardId }));
  }

  if (state.phase !== 'playing' || state.activePlayer !== playerId) return [];

  const player = state.players[playerId];
  const turn = state.turnState;
  const actions = [];

  // --- Free plays -------------------------------------------------------
  if (hasFieldRoom(state, playerId)) {
    for (const entry of player.hand) {
      // Gated by the power curve as well as the field cap.
      if (getCard(entry.cardId).type === 'persona' && canPlayPersonaCard(state, playerId, entry.cardId)) {
        actions.push({ type: 'PLAY_PERSONA', player: playerId, handUid: entry.uid, cardId: entry.cardId });
      }
    }
  }

  if (turn.itemsPlayed < CONFIG.ITEMS_PER_TURN) {
    for (const entry of player.hand) {
      const card = getCard(entry.cardId);
      if (card.type !== 'item') continue;
      if (card.usesAction && turn.actionsRemaining <= 0) continue;
      actions.push(...cardActions(state, playerId, entry, card, 'PLAY_ITEM'));
    }
  }

  if (turn.specialsPlayed < CONFIG.SPECIALS_PER_TURN) {
    for (const entry of player.hand) {
      const card = getCard(entry.cardId);
      if (card.type !== 'special') continue;
      if (card.usesAction && turn.actionsRemaining <= 0) continue;
      actions.push(...cardActions(state, playerId, entry, card, 'PLAY_SPECIAL'));
    }
  }

  if (turn.personaChangesRemaining > 0) {
    for (const persona of benchOf(state, playerId)) {
      if (persona.knockedDown) continue;
      actions.push({ type: 'CHANGE_ACTIVE', player: playerId, targetUid: persona.uid });
    }
  }

  // --- The one action ---------------------------------------------------
  if (turn.actionsRemaining > 0) {
    const active = getActive(state, playerId);
    const canAct = active && !active.knockedDown && !hasAilment(active, 'shock');

    if (canAct) {
      for (const target of enemyTargets(state, playerId)) {
        actions.push({ type: 'ATTACK', player: playerId, targetUid: target.uid });
      }

      for (const skill of personaSkills(state, active)) {
        if (!canAffordSkill(active, skill)) continue;
        const isOffensive = skill.effect.kind === 'damage' || skill.effect.kind === 'instakill';
        if (isOffensive) {
          for (const target of enemyTargets(state, playerId)) {
            actions.push({ type: 'USE_SKILL', player: playerId, skillId: skill.id, targetUid: target.uid });
          }
        } else {
          if (!effectIsUseful(state, playerId, skill.effect)) continue;
          const targets = effectTargets(state, playerId, skill.effect);
          if (!targets) actions.push({ type: 'USE_SKILL', player: playerId, skillId: skill.id });
          else {
            for (const target of targets) {
              actions.push({ type: 'USE_SKILL', player: playerId, skillId: skill.id, targetUid: target.uid });
            }
          }
        }
      }

      actions.push({ type: 'GUARD', player: playerId });
      actions.push(...fusionActions(state, playerId));
    }

    // Pass is always available — it is the guaranteed escape from any lock.
    actions.push({ type: 'PASS', player: playerId });
  }

  // --- Ending the turn --------------------------------------------------
  const overflow = Math.max(0, player.hand.length - CONFIG.HAND_LIMIT);
  actions.push({
    type: 'END_TURN',
    player: playerId,
    discard: player.hand.slice(0, overflow).map((c) => c.uid),
    ...(overflow > 0 ? { needsChoice: true, discardCount: overflow } : {}),
  });

  return actions;
}
