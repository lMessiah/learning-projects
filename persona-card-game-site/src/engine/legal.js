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
import { getCard, getPersona, cardQuality, FUSION_RECIPES } from '../data/cards.js';
import {
  opponentOf,
  getActive,
  livingField,
  benchOf,
  koedField,
  hasFieldRoom,
  canPlayPersonaCard,
  canFuseInto,
  fusionLevelCap,
  fusionUnlocked,
  personaSkills,
  isSkillFull,
  droppableSkills,
  hasAilment,
  canTargetBench,
  remainingPersonaArcana,
  mimicableSkill,
  affinitiesFullyRevealed,
  affinitiesOf,
  deckTop,
  gallowsMeal,
  gallowsBumpStat,
  gallowsInheritOptions,
  handPersonaLevel,
} from './state.js';
import { passiveOf, printedPassive, passiveDefinition, koDeficit, PASSIVE_CHOICE_PREFIX } from './passives.js';
import { twistableElements } from './effects.js';

/**
 * Enemy Personas that may legally be targeted right now. Active-only, unless
 * Ambush opened the bench for the turn or a One More is waiting to be spent.
 */
function enemyTargets(state, playerId) {
  const foeId = opponentOf(playerId);
  if (canTargetBench(state)) return livingField(state, foeId);
  const active = getActive(state, foeId);
  return active ? [active] : [];
}

/** Has this Persona anything to rewrite? A blank chart cannot be scrambled. */
function rewritable(persona) {
  const { weaknesses, resists } = affinitiesOf(persona);
  return weaknesses.length + resists.length > 0;
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
    case 'recall':
      return koedField(state, playerId);
    case 'swapFree':
      return benchOf(state, playerId).filter((p) => !p.knockedDown);
    case 'damage':
      return effect.target === 'enemyAll' ? null : enemyTargets(state, playerId);
    case 'drainSp':
      return enemyTargets(state, playerId).filter((p) => p.sp > 0);
    case 'teachSkill':
      return livingField(state, playerId).filter(
        (p) => !personaSkills(state, p).some((s) => s.id === effect.skillId)
      );
    case 'rewriteAffinities':
      // Only the "any of yours" scope needs a target; the rest hit fixed slots.
      return effect.scope === 'ownAny'
        ? livingField(state, playerId).filter((p) => rewritable(p))
        : null;
    case 'mimic': {
      // Whatever the copied skill would need.
      const skill = mimicableSkill(state, playerId);
      return skill ? effectTargets(state, playerId, skill.effect) : null;
    }
    default:
      // charge / grant / growth / forceSwitch / reveal / peekHand / swapHpSp
      // all hit fixed slots, and buff / dispel cover a whole side at once — so
      // none of them asks the player to pick anything.
      return null;
  }
}

/**
 * The extra, non-Persona choices an effect needs. Fortune's Draw is the only
 * one: it asks for an Arcana rather than a target on the board.
 */
function effectChoices(state, playerId, effect) {
  if (effect.kind === 'guaranteedDraw') {
    const arcana = remainingPersonaArcana(state, playerId);
    return arcana.length ? arcana.map((value) => ({ arcana: value })) : null;
  }
  if (effect.kind === 'shuffleTime') {
    // One choice per card the player is allowed to look at. The card ids ride
    // along so the UI can show what it is choosing between.
    const top = deckTop(state, playerId, effect.look ?? CONFIG.SHUFFLE_TIME_LOOK);
    return top.length ? top.map((cardId, index) => ({ keepIndex: index, keepCardId: cardId })) : null;
  }
  if (effect.kind === 'inflict' && effect.ailments.length > 1) {
    // One option per ailment on offer — the whole point of the card is which.
    const target = getActive(state, opponentOf(playerId));
    const open = effect.ailments.filter((type) => target && !hasAilment(target, type));
    return open.length ? open.map((ailment) => ({ ailment })) : null;
  }
  if (effect.kind === 'twistFate') {
    // One option per element you are allowed to name. Nothing you resist, and
    // nothing they are already weak to — the picker offers exactly what the
    // handler will accept.
    const target = getActive(state, opponentOf(playerId));
    const elements = twistableElements(target);
    return elements.length ? elements.map((element) => ({ element })) : null;
  }
  if (effect.kind === 'providence') {
    const top = deckTop(state, playerId, effect.look ?? CONFIG.PROVIDENCE_LOOK);
    if (!top.length) return null;

    // DESIGN NOTE: Providence accepts any subset of the cards it showed you, so
    // the honest legal-action list would be 2^5 entries. Instead this offers
    // "throw away the k weakest", ranked by the same 0..1 card-quality scale
    // Momentum Draw uses, for k = 0..look. That is a real gradient for the bot
    // to score against; the UI ignores these and opens a free-form picker, and
    // the handler accepts whatever it sends.
    const ranked = top
      .map((cardId, index) => ({ index, quality: cardQuality(cardId) }))
      .sort((a, b) => a.quality - b.quality);

    const options = [];
    for (let k = 0; k <= ranked.length; k++) {
      options.push({
        discardIndexes: ranked.slice(0, k).map((entry) => entry.index).sort((a, b) => a - b),
        providenceTop: top,
        needsChoice: true,
      });
    }
    return options;
  }
  return null;
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
    // Buffs and dispels cover a whole side, so what they need is a BODY on that
    // side — not an active one. A player who just lost their active still has a
    // bench worth buffing.
    case 'buff':
      return livingField(state, effect.target === 'enemyField' ? foeId : playerId).length > 0;
    case 'dispel': {
      const side = effect.target === 'enemyField' ? foeId : playerId;
      return livingField(state, side).some((p) =>
        p.buffs.some((b) => (effect.remove === 'buffs' ? b.direction === 'up' : b.direction === 'down'))
      );
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

    // Traesto needs a body to pull back and somewhere to put it. Retreating
    // your LAST Persona is deliberately still legal — an empty field is a
    // position a player may choose, and the clock is the only consequence.
    case 'retreat':
      return livingField(state, playerId).length > 0 && state.players[playerId].hand.length < CONFIG.HAND_LIMIT + 1;

    // Worth casting even at a full pool: taking it off them is half the value.
    case 'drainSp':
      return Boolean(getActive(state, playerId)) && enemyTargets(state, playerId).some((p) => p.sp > 0);

    case 'teachSkill':
      return livingField(state, playerId).some(
        (p) => !personaSkills(state, p).some((s) => s.id === effect.skillId)
      );
    case 'damage': {
      // Damage Specials are delivered BY your active Persona, so they need one.
      if (!getActive(state, playerId)) return false;
      return effect.target === 'enemyAll' ? livingField(state, foeId).length > 0 : enemyTargets(state, playerId).length > 0;
    }

    case 'guaranteedDraw':
      return remainingPersonaArcana(state, playerId).length > 0;

    case 'fateFetch': {
      // Playable once there is a question to answer. Below the deficit that
      // means a weakness you have actually uncovered; at or above it, any.
      const target = getActive(state, foeId);
      if (!target) return false;
      const { weaknesses } = affinitiesOf(target);
      if (koDeficit(state, playerId) >= CONFIG.WHIMS_DEFICIT) return weaknesses.length > 0;
      return weaknesses.some((type) => target.revealedTypes.includes(type));
    }

    case 'providence':
      return deckTop(state, playerId, effect.look ?? CONFIG.PROVIDENCE_LOOK).length > 0;

    case 'rewriteAffinities': {
      // A Persona with nothing printed either way has nothing to scramble.
      if (effect.scope === 'ownAny') return livingField(state, playerId).some((p) => rewritable(p));
      const mine = getActive(state, playerId);
      if (effect.scope === 'bothActive') {
        const theirs = getActive(state, foeId);
        return Boolean(mine && theirs) && (rewritable(mine) || rewritable(theirs));
      }
      return Boolean(mine) && rewritable(mine);
    }

    case 'twistFate': {
      // Needs a target with at least one weakness to trade away, and at least
      // one element left that is neither resisted nor already a weakness.
      const target = getActive(state, foeId);
      return twistableElements(target).length > 0;
    }

    case 'inflict': {
      const target = getActive(state, foeId);
      // Re-applying an ailment only refreshes its duration, so it is still
      // worth doing — but not if they already have every one on offer at full.
      return Boolean(target) && effect.ailments.some((type) => !hasAilment(target, type));
    }

    case 'growth':
      return benchOf(state, playerId).length > 0;

    case 'forceSwitch':
      return Boolean(getActive(state, foeId)) && benchOf(state, foeId).some((p) => !p.knockedDown);

    case 'reveal': {
      const target = getActive(state, foeId);
      if (!target) return false;
      const { weaknesses, resists } = affinitiesOf(target);
      // Nothing to learn if it has already been read.
      return [...weaknesses, ...resists].some((type) => !target.revealedTypes.includes(type));
    }

    case 'peekHand':
      return state.players[foeId].hand.length > 0 && !state.turnState?.peekHand;

    case 'recall':
      return koedField(state, playerId).length > 0;

    case 'swapHpSp': {
      const active = getActive(state, playerId);
      return Boolean(active) && active.hp !== active.sp;
    }

    case 'phantomStrike': {
      const target = getActive(state, foeId);
      // Only worth arming — and only legal — once the mark has been fully read.
      return Boolean(target) && affinitiesFullyRevealed(target) && !state.turnState?.phantomStrike;
    }

    case 'swapFree':
      return benchOf(state, playerId).some((p) => !p.knockedDown);

    case 'shuffleTime':
      return deckTop(state, playerId, effect.look ?? CONFIG.SHUFFLE_TIME_LOOK).length > 0;

    case 'evolve': {
      const active = getActive(state, playerId);
      if (!active) return false;
      const known = new Set(personaSkills(state, active).map((s) => s.id));
      return getPersona(active.cardId).skills.some((s) => !known.has(s.id));
    }

    case 'darkHour':
      return !(state.darkHour?.turnsLeft > 0);

    case 'ward': {
      const active = getActive(state, playerId);
      return Boolean(active) && !active.warded;
    }

    case 'mimic': {
      const skill = mimicableSkill(state, playerId);
      if (!skill) return false;
      if (skill.effect.kind === 'damage') {
        return Boolean(getActive(state, playerId)) && enemyTargets(state, playerId).length > 0;
      }
      return Boolean(getActive(state, playerId)) && effectIsUseful(state, playerId, skill.effect);
    }

    default:
      return false;
  }
}

/** Expand a card play into one action per legal target. */
/**
 * What a Persona would give up to learn one more skill, when it is already at
 * MAX_SKILLS_PER_PERSONA.
 *
 * Follows the same contract as every other choice in this file: a sensible
 * default is filled in so the bot and a one-click UI both work, and the full
 * list rides along as metadata so the player can pick something else. Below the
 * cap it returns nothing at all, and the engine rejects a drop nobody needs.
 *
 * The default is the WEAKEST thing it knows — lowest power first, then whatever
 * it learned earliest. Support skills have no power and so go first, which is
 * the right instinct for an auto-pick: a Persona at eight skills is a fighter,
 * and the buff it has not cast in twenty turns is the cheapest thing to lose.
 */
function skillDropFor(state, persona, learningSkillId = null) {
  if (!persona || !isSkillFull(state, persona)) return null;
  const options = droppableSkills(state, persona).filter((s) => s.id !== learningSkillId);
  if (!options.length) return null;
  const ranked = [...options].sort(
    (a, b) => (a.power ?? 0) - (b.power ?? 0) || (a.unlockLevel ?? 0) - (b.unlockLevel ?? 0)
  );
  return {
    dropSkillId: ranked[0].id,
    dropOptions: ranked.map((s) => ({ id: s.id, name: s.name, power: s.power ?? 0, inherited: Boolean(s.inherited) })),
  };
}

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

  // Traesto asks two questions at once: who leaves, and — if that was the
  // active Persona — who steps into the empty slot. The promotion is free, so
  // the second question only exists when there is more than one answer.
  if (card.effect.kind === 'retreat') {
    const own = livingField(state, playerId);
    return own.map((target) => {
      const isActive = target.uid === state.players[playerId].activeUid;
      const bench = isActive ? own.filter((p) => p.uid !== target.uid && !p.knockedDown) : [];
      // Healthiest body first: stepping up into the slot the retreat opened is
      // a defensive move, so the default is the one most able to take a hit.
      const ranked = [...bench].sort((a, b) => b.hp / b.maxHp - a.hp / a.maxHp);
      return {
        ...base,
        targetUid: target.uid,
        promoteOptions: ranked.map((p) => ({ uid: p.uid, cardId: p.cardId })),
        promoteUid: ranked.length ? ranked[0].uid : null,
        needsChoice: ranked.length > 1,
      };
    });
  }

  // Evolve teaches the ACTIVE Persona its next printed skill, so the skill cap
  // has to be answered here rather than at a chosen target.
  if (card.effect.kind === 'evolve') {
    const active = getActive(state, playerId);
    const known = new Set(active ? personaSkills(state, active).map((s) => s.id) : []);
    const next = active
      ? getPersona(active.cardId)
          .skills.filter((s) => !known.has(s.id))
          .sort((a, b) => a.unlockLevel - b.unlockLevel)[0]
      : null;
    const drop = skillDropFor(state, active, next?.id ?? null);
    return [{ ...base, ...(drop ?? {}), needsChoice: Boolean(drop) }];
  }

  const choices = effectChoices(state, playerId, card.effect);
  if (choices) return choices.map((choice) => ({ ...base, ...choice }));

  const targets = effectTargets(state, playerId, card.effect);
  if (!targets) return [base];
  return targets.map((target) => {
    const action = { ...base, targetUid: target.uid };
    // A Skill Card can land on a Persona that is already full.
    if (card.effect.kind === 'teachSkill') {
      const drop = skillDropFor(state, target, card.effect.skillId);
      if (drop) return { ...action, ...drop, needsChoice: true };
    }
    return action;
  });
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
        passive: passiveOf(persona),
        isActive: player.activeUid === persona.uid,
      };
    }),
    ...player.hand
      .filter((entry) => getCard(entry.cardId).type === 'persona')
      .map((entry) => {
        const card = getPersona(entry.cardId);
        // A Persona pulled back by Traesto is still that Persona: it feeds a
        // fusion at the level it reached and offers the skills it can cast, not
        // the ones its printed level had unlocked.
        const level = handPersonaLevel(entry);
        return {
          zone: 'hand',
          uid: entry.uid,
          cardId: card.id,
          name: card.name,
          level,
          arcana: card.arcana,
          skills: entry.persona
            ? personaSkills(state, entry.persona)
            : card.skills.filter((s) => s.unlockLevel <= card.level),
          passive: entry.persona ? passiveOf(entry.persona) : printedPassive(card.id),
          persona: entry.persona ?? null,
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
  const locked = !fusionUnlocked(state);
  const spent = (state.turnState?.fusionsPerformed ?? 0) >= CONFIG.FUSIONS_PER_TURN;
  // Two separate ways to be out of fusions, and they need separate wording: the
  // ration is gone for the turn, or the action that pays for one is.
  const noAction = CONFIG.FUSION_USES_ACTION && (state.turnState?.actionsRemaining ?? 0) <= 0;

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

    // The power curve outranks every other reason: no arrangement of materials
    // makes a recipe available while the board is too small for the result, so
    // saying "Need a Death Persona" first would send the player after the wrong
    // thing entirely.
    const belowCurve = !canFuseInto(state, playerId, recipe.result);

    let reason = null;
    if (locked) {
      reason = `Fusion opens on turn ${CONFIG.FUSION_FIRST_TURN}`;
    } else if (belowCurve) {
      reason = `Needs a Lv ${getPersona(recipe.result).level - CONFIG.FUSION_LEVEL_GAP} Persona on your field`;
    } else if (pairs.length === 0) {
      if (missing.length) reason = `Need a ${missing.join(' and a ')} Persona`;
      else if (!anyArcanaPair) reason = `Need ${recipe.arcana.join(' + ')} at the same time`;
      else if (bestCombined < recipe.minCombinedLevel) reason = `Combined level ${bestCombined}/${recipe.minCombinedLevel}`;
      else if (blockedByRoom) reason = 'No room on your field for the result';
      else reason = 'No usable pair';
    } else if (spent) {
      reason = `Already fused this turn (${CONFIG.FUSIONS_PER_TURN} per turn)`;
    } else if (noAction) {
      reason = 'No action left — fusion costs your action';
    }

    return {
      recipe,
      result: getPersona(recipe.result),
      resultPassive: printedPassive(recipe.result),
      minCombinedLevel: recipe.minCombinedLevel,
      arcana: recipe.arcana,
      pairs,
      bestCombined,
      belowCurve,
      locked,
      satisfiable: pairs.length > 0 && !spent && !noAction && !belowCurve && !locked,
      usesAction: CONFIG.FUSION_USES_ACTION,
      // What the result is FOR. Deck building already uses this to decide which
      // material an archetype is dealt; surfacing it lets the player read the
      // same plan off the panel instead of working it out from the statline.
      alignment: recipe.alignment,
      reason,
    };
  });
}

/**
 * Is there at least one fusion this player could perform right now? Cheaper
 * than `describeFusions` because it stops at the first hit — used once per turn
 * to record whether a fusion went begging.
 */
export function fusionAvailable(state, playerId) {
  if (!fusionUnlocked(state)) return false;
  const candidates = fusionCandidates(state, playerId);
  for (const recipe of FUSION_RECIPES) {
    if (!canFuseInto(state, playerId, recipe.result)) continue;
    for (let i = 0; i < candidates.length; i++) {
      for (let j = i + 1; j < candidates.length; j++) {
        const a = candidates[i];
        const b = candidates[j];
        if (!pairMatchesArcana(a, b, recipe.arcana)) continue;
        if (a.level + b.level < recipe.minCombinedLevel) continue;
        if (!a.skills.length || !b.skills.length) continue;
        if (!pairFits(state, playerId, a, b)) continue;
        return true;
      }
    }
  }
  return false;
}

function fusionActions(state, playerId) {
  if (state.turnState.fusionsPerformed >= CONFIG.FUSIONS_PER_TURN) return [];
  if (CONFIG.FUSION_USES_ACTION && state.turnState.actionsRemaining <= 0) return [];
  if (!fusionUnlocked(state)) return [];
  const candidates = fusionCandidates(state, playerId);
  const out = [];
  for (const recipe of FUSION_RECIPES) {
    // The power curve applies to a fused Persona exactly as it does to one
    // played from hand: your board has to have grown into it.
    if (!canFuseInto(state, playerId, recipe.result)) continue;
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

        // Each parent offers its unlocked skills OR its passive; the result can
        // take at most one passive, and overwriting a native one needs a
        // confirmation (`replacePassive`), which is why the default choice is
        // always two skills.
        const options = [a, b].map((parent) => [
          ...parent.skills.map((s) => s.id),
          ...(parent.passive ? [`${PASSIVE_CHOICE_PREFIX}${parent.passive}`] : []),
        ]);

        out.push({
          type: 'FUSE',
          player: playerId,
          recipeId: recipe.id,
          result: recipe.result,
          sacrifices: [
            { zone: a.zone, uid: a.uid },
            { zone: b.zone, uid: b.uid },
          ],
          inherit: [a.skills[0].id, b.skills[0].id], // default choice: skills only
          inheritOptions: options,
          resultPassive: printedPassive(recipe.result),
          needsChoice: true,
          // The price, carried on the action itself, exactly as Items, Specials
          // and Gallows meals carry theirs. The UI must read this and never work
          // the rule out for itself — a label that re-derives the cost is how the
          // fusion button ended up promising a price the engine did not charge.
          usesAction: CONFIG.FUSION_USES_ACTION,
        });
      }
    }
  }
  return out;
}

/**
 * Every (eater, food) pairing the Gallows would accept right now.
 *
 * `nourishing` rides along so the UI can say which meals are worth a level and
 * which are only worth the HP, without re-deriving the rule.
 */
export function gallowsActions(state, playerId) {
  const turn = state.turnState;
  if (!turn) return [];
  // Separate rations: a nourishing meal and a junk disposal are counted apart,
  // so running out of one still leaves the other.
  const paidLeft = turn.gallowsUsed < CONFIG.GALLOWS_PER_TURN;
  const junkLeft = (turn.gallowsJunkUsed ?? 0) < CONFIG.GALLOWS_JUNK_PER_TURN;
  if (!paidLeft && !junkLeft) return [];

  const eaters = livingField(state, playerId);
  if (!eaters.length) return [];

  // With the action already spent, only the free junk tier is still on offer —
  // and junk needs food further than COMEBACK_FARM_GAP beneath its eater. Rule
  // that out on two numbers before building the cross product: this runs on
  // every getLegalActions call, and the bot makes thousands of them per match.
  const spentAction = turn.actionsRemaining <= 0 || !paidLeft;
  if (spentAction) {
    if (!junkLeft) return [];
    const tallestEater = Math.max(...eaters.map((p) => p.level));
    const smallestMeal = Math.min(
      ...eaters.map((p) => p.level),
      ...state.players[playerId].hand
        .filter((entry) => getCard(entry.cardId).type === 'persona')
        .map((entry) => getPersona(entry.cardId).level),
      Infinity
    );
    if (smallestMeal >= tallestEater - CONFIG.COMEBACK_FARM_GAP) return [];
  }

  const meals = [
    ...eaters.map((p) => ({
      zone: 'field',
      uid: p.uid,
      cardId: p.cardId,
      level: p.level,
      passive: passiveOf(p),
      persona: p,
    })),
    ...state.players[playerId].hand
      .filter((entry) => getCard(entry.cardId).type === 'persona')
      .map((entry) => ({
        zone: 'hand',
        uid: entry.uid,
        cardId: entry.cardId,
        // A Persona pulled back by Traesto is priced at the body it is, not the
        // card on its face — and it brings its own passive with it.
        level: handPersonaLevel(entry),
        passive: entry.persona ? passiveOf(entry.persona) : printedPassive(entry.cardId),
        persona: entry.persona ?? null,
      })),
  ];

  const out = [];
  for (const eater of eaters) {
    for (const meal of meals) {
      if (meal.zone === 'field' && meal.uid === eater.uid) continue;
      const worth = gallowsMeal(eater.level, meal.level, meal.passive, eater.maxHp);
      // The top two tiers cost the action, so they need one to spend AND their
      // own ration. Junk disposal is free and keeps its own.
      if (worth.usesAction && (turn.actionsRemaining <= 0 || !paidLeft)) continue;
      if (!worth.usesAction && !junkLeft) continue;
      // Passives move ONLY on the top tier, and only through this one channel.
      // The display name is filled in here because passives.js is this module's
      // dependency, not state.js's.
      const inheritOptions = worth.canInherit
        ? gallowsInheritOptions(state, meal, eater, { passives: worth.canInheritPassive }).map((option) =>
            option.kind === 'passive'
              ? { ...option, name: passiveDefinition(option.passiveId)?.name ?? option.passiveId }
              : option
          )
        : [];
      // Taking a passive over one the eater already has is a real loss, so it
      // needs the same explicit confirmation fusion demands.
      const skillOptions = inheritOptions.filter((option) => option.kind !== 'passive');
      const defaultInherit = skillOptions.length ? skillOptions[skillOptions.length - 1].id : null;
      const drop = defaultInherit ? skillDropFor(state, eater.persona ?? eater, defaultInherit) : null;
      out.push({
        type: 'GALLOWS',
        player: playerId,
        eaterUid: eater.uid,
        food: { zone: meal.zone, uid: meal.uid },
        foodCardId: meal.cardId,
        // The whole verdict rides along so neither the UI nor the bot has to
        // re-derive it — `nourishing` is kept for callers that only care whether
        // any levels are coming.
        tier: worth.tier,
        levels: worth.levels,
        heal: worth.heal,
        usesAction: worth.usesAction,
        nourishing: worth.nourishing,
        // The nourishing tiers may pass on one skill; the feast also leaves a
        // permanent mark. Both ride along so the confirm dialog can preview the
        // exact outcome without deriving any of it a second time.
        canInherit: worth.canInherit,
        canInheritPassive: worth.canInheritPassive,
        inheritOptions,
        // What the eater would be giving up if a passive is taken over the top.
        eaterPassive: passiveOf(eater),
        statBump: worth.statBump ? gallowsBumpStat(eater.cardId) : null,
        statBumpAmount: worth.statBump,
        // The default is the food's LAST unlocked SKILL — printed order climbs
        // with unlock level, so that is its strongest. Taking a skill costs
        // nothing, so "take the best one" is the sensible default. A passive is
        // never the default even when it is on offer: it can overwrite what the
        // eater already has, and that is a decision, not a freebie.
        inherit: defaultInherit,
        // If the eater is already full, taking that skill costs it another —
        // same contract as `inherit`: a default now, the alternatives attached.
        ...(drop ?? {}),
        needsChoice: inheritOptions.length > 0 || Boolean(drop),
      });
    }
  }
  return out;
}

/** Is there anything the Gallows would accept right now? */
export function gallowsAvailable(state, playerId) {
  return gallowsActions(state, playerId).length > 0;
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
      if (getCard(entry.cardId).type === 'persona' && canPlayPersonaCard(state, playerId, entry.cardId, entry)) {
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

  // Fusion costs the action (see FUSION_USES_ACTION), and fusionActions checks
  // for one itself. It still sits here rather than in the action block below,
  // because it is something the PLAYER does — a Persona that cannot act is no
  // obstacle to it.
  actions.push(...fusionActions(state, playerId));

  // The Gallows sits with fusion for the same reason, and because its bottom
  // tier costs no action at all: `gallowsActions` decides for itself which
  // meals still need one, so it cannot live inside the action block.
  actions.push(...gallowsActions(state, playerId));

  if (turn.personaChangesRemaining > 0) {
    for (const persona of benchOf(state, playerId)) {
      if (persona.knockedDown) continue;
      actions.push({ type: 'CHANGE_ACTIVE', player: playerId, targetUid: persona.uid });
    }
  }

  // --- The one action ---------------------------------------------------
  if (turn.actionsRemaining > 0) {
    const active = getActive(state, playerId);
    const canAct = active && !active.knockedDown && !active.warded && !hasAilment(active, 'shock');

    if (canAct) {
      for (const target of enemyTargets(state, playerId)) {
        actions.push({ type: 'ATTACK', player: playerId, targetUid: target.uid });
      }

      for (const skill of personaSkills(state, active)) {
        if (!canAffordSkill(active, skill)) continue;
        const isOffensive = skill.effect.kind === 'damage';
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
    }

    // Pass is always available — it is the guaranteed escape from any lock.
    actions.push({ type: 'PASS', player: playerId });
  }

  // Conceding is always available on your own turn. It is deliberately last:
  // the bot's "is there anything productive left" check works off this list,
  // and resigning is never productive.
  actions.push({ type: 'RESIGN', player: playerId, needsConfirmation: true });

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
