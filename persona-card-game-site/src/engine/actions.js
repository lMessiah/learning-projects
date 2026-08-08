/**
 * The reducer: `applyAction(state, action) -> newState`.
 *
 * Pure and deterministic. It clones the incoming state, mutates the draft, and
 * returns it. Illegal actions throw rather than silently no-op, so bugs in the
 * UI or the bot surface immediately instead of corrupting a match.
 */
import { CONFIG, skillCategory } from './config.js';
import { getCard, getPersona, FUSION_RECIPES } from '../data/cards.js';
import {
  cloneState,
  createPersonaInstance,
  createTurnState,
  pushLog,
  opponentOf,
  getActive,
  livingField,
  benchOf,
  koedField,
  hasFieldRoom,
  playableLevelCap,
  personaSkills,
  getSkill,
  hasAilment,
  handCard,
} from './state.js';
import {
  drawCards,
  discardFromHand,
  healPersona,
  restoreSp,
  fullRestore,
  revivePersona,
  cureAilments,
  applyBuff,
  dispelBuffs,
  addCharge,
  resolveAttack,
  applyDamage,
  evaluateGameEnd,
  runStartOfTurn,
  runEndOfTurn,
  promoteActiveIfEmpty,
  nameOf,
} from './effects.js';

/* ------------------------------------------------------------------ *
 * Guards
 * ------------------------------------------------------------------ */

function fail(message) {
  throw new Error(`Illegal action: ${message}`);
}

function requirePlaying(state, action) {
  if (state.phase !== 'playing') fail(`game is in phase "${state.phase}"`);
  if (action.player !== state.activePlayer) fail(`it is not ${state.players[action.player]?.name}'s turn`);
}

function requireAction(state) {
  if (state.turnState.actionsRemaining <= 0) fail('no actions remaining this turn');
}

function requireUsableActive(state, playerId) {
  const active = getActive(state, playerId);
  if (!active) fail('no active Persona');
  if (active.knockedDown) fail(`${nameOf(active)} is knocked down and cannot act`);
  if (hasAilment(active, 'shock')) fail(`${nameOf(active)} is shocked and cannot act this turn`);
  return active;
}

function requireHandCard(state, playerId, handUid, type) {
  const entry = handCard(state, playerId, handUid);
  if (!entry) fail(`card "${handUid}" is not in hand`);
  const card = getCard(entry.cardId);
  if (type && card.type !== type) fail(`${card.name} is not ${type === 'item' ? 'an Item' : `a ${type}`}`);
  return { entry, card };
}

function requireOwnPersona(state, playerId, uid, { allowKo = false } = {}) {
  const persona = state.players[playerId].field.find((p) => p.uid === uid);
  if (!persona) fail(`Persona "${uid}" is not on your field`);
  if (!allowKo && persona.ko) fail(`${nameOf(persona)} is knocked out`);
  return persona;
}

/**
 * Resolve the legal target of an offensive effect. Only the opponent's active
 * Persona may be hit, unless a Special (Ambush) opened up the bench this turn.
 */
function resolveEnemyTarget(state, playerId, targetUid) {
  const foeId = opponentOf(playerId);
  const active = getActive(state, foeId);
  if (!targetUid) {
    if (!active) fail('the opponent has no active Persona to target');
    return active;
  }
  const target = state.players[foeId].field.find((p) => p.uid === targetUid && !p.ko);
  if (!target) fail(`"${targetUid}" is not a living enemy Persona`);
  if (target.uid !== active?.uid && !state.turnState.canTargetBench) {
    fail('only the opponent\'s active Persona can be targeted');
  }
  return target;
}

/* ------------------------------------------------------------------ *
 * Turn flow
 * ------------------------------------------------------------------ */

function beginTurn(state, playerId) {
  state.activePlayer = playerId;
  state.turn += 1;
  state.turnState = createTurnState();
  pushLog(state, `— Turn ${state.turn}: ${state.players[playerId].name} —`, 'turn');
  runStartOfTurn(state, playerId);
  promoteActiveIfEmpty(state, playerId);
  evaluateGameEnd(state);
  return state;
}

/**
 * Grant a One More: one extra action this turn, plus one extra Persona change
 * (Baton Pass). Capped at one per turn so weakness chains can't loop forever.
 */
function grantOneMore(state) {
  if (state.turnState.oneMoreUsed) {
    pushLog(state, 'One More already used this turn.', 'info');
    return false;
  }
  state.turnState.oneMoreUsed = true;
  state.turnState.actionsRemaining += 1;
  state.turnState.personaChangesRemaining += 1;
  pushLog(state, 'ONE MORE! Extra action and an extra Persona change (Baton Pass).', 'onemore');
  return true;
}

/** Spend the action, and hand out a One More when a weakness was struck. */
function consumeAction(state, result) {
  state.turnState.actionsRemaining -= 1;
  if (result?.weak && !result.missed) grantOneMore(state);
}

/* ------------------------------------------------------------------ *
 * Effect dispatch — shared by skills, Items and Specials
 * ------------------------------------------------------------------ */

function applyEffect(state, playerId, effect, action, sourceName) {
  const foeId = opponentOf(playerId);

  switch (effect.kind) {
    case 'heal': {
      if (effect.target === 'ownAll') {
        for (const persona of livingField(state, playerId)) healPersona(state, persona, effect.amount);
        if (effect.cureAilments) for (const p of livingField(state, playerId)) cureAilments(state, p);
      } else {
        const target = requireOwnPersona(state, playerId, action.targetUid);
        healPersona(state, target, effect.amount);
        if (effect.cureAilments) cureAilments(state, target);
      }
      return { kind: 'heal' };
    }

    case 'restoreSp': {
      const target = requireOwnPersona(state, playerId, action.targetUid);
      restoreSp(state, target, effect.amount);
      return { kind: 'restoreSp' };
    }

    case 'fullRestore': {
      const target = requireOwnPersona(state, playerId, action.targetUid);
      fullRestore(state, target);
      if (effect.cureAilments) cureAilments(state, target);
      return { kind: 'fullRestore' };
    }

    case 'cureAilments': {
      const target = requireOwnPersona(state, playerId, action.targetUid);
      cureAilments(state, target);
      return { kind: 'cureAilments' };
    }

    case 'revive': {
      const target = requireOwnPersona(state, playerId, action.targetUid, { allowKo: true });
      if (!target.ko) fail(`${nameOf(target)} is not knocked out`);
      revivePersona(state, target, effect.hpPercent);
      return { kind: 'revive' };
    }

    case 'buff': {
      const target =
        effect.target === 'enemyActive'
          ? getActive(state, foeId) || fail('the opponent has no active Persona')
          : getActive(state, playerId) || fail('you have no active Persona');
      applyBuff(state, target, effect.stat, effect.direction, effect.duration ?? CONFIG.BUFF_DURATION);
      return { kind: 'buff' };
    }

    case 'dispel': {
      const target =
        effect.target === 'enemyActive'
          ? getActive(state, foeId) || fail('the opponent has no active Persona')
          : getActive(state, playerId) || fail('you have no active Persona');
      dispelBuffs(state, target, effect.remove);
      return { kind: 'dispel' };
    }

    case 'charge': {
      const target = getActive(state, playerId) || fail('you have no active Persona');
      addCharge(state, target, effect.charge);
      return { kind: 'charge' };
    }

    case 'grant': {
      if (effect.grant === 'targetBench') {
        state.turnState.canTargetBench = true;
        pushLog(state, `${sourceName}! Enemy benched Personas can be targeted this turn.`, 'special');
      } else if (effect.grant === 'extraPersonaChange') {
        state.turnState.personaChangesRemaining += effect.amount ?? 1;
        pushLog(state, `${sourceName}! You may change Persona ${effect.amount ?? 1} extra time(s) this turn.`, 'special');
      }
      return { kind: 'grant' };
    }

    case 'transferSp': {
      const from = requireOwnPersona(state, playerId, action.fromUid);
      const to = requireOwnPersona(state, playerId, action.toUid);
      if (from.uid === to.uid) fail('SP Transfer needs two different Personas');
      const requested = Math.min(action.amount ?? effect.amount, effect.amount);
      const moved = Math.max(0, Math.min(requested, from.sp, to.maxSp - to.sp));
      if (moved <= 0) fail('no SP could be transferred');
      from.sp -= moved;
      to.sp += moved;
      pushLog(state, `${moved} SP moved from ${nameOf(from)} to ${nameOf(to)}.`, 'special');
      return { kind: 'transferSp', moved };
    }

    case 'damage': {
      const attacker = getActive(state, playerId) || fail('you have no active Persona');
      const category = effect.statSource === 'magic'
        ? 'magic'
        : effect.statSource === 'phys'
          ? 'phys'
          : attacker.magic >= attacker.strength
            ? 'magic'
            : 'phys';

      if (effect.target === 'enemyAll') {
        // The only way to hit non-active Personas. A Concentrate/Charge boosts
        // the WHOLE attack, so it is spent once rather than on the first target.
        const targets = livingField(state, foeId);
        if (!targets.length) fail('the opponent has no Personas on the field');
        const wantedCharge = category === 'phys' ? 'charge' : 'concentrate';
        const hadCharge = attacker.charges.includes(wantedCharge);

        let anyWeak = false;
        for (const target of targets) {
          const result = resolveAttack(state, {
            attacker,
            defender: target,
            power: effect.power,
            damageType: effect.damageType,
            category,
            effect: { kind: 'damage' },
            consumeCharge: false,
          });
          anyWeak = anyWeak || result.weak;
        }
        if (hadCharge) attacker.charges = attacker.charges.filter((c) => c !== wantedCharge);
        return { kind: 'damage', weak: anyWeak };
      }

      const target = resolveEnemyTarget(state, playerId, action.targetUid);
      const result = resolveAttack(state, {
        attacker,
        defender: target,
        power: effect.power,
        damageType: effect.damageType,
        category,
        effect: { kind: 'damage' },
      });
      return { kind: 'damage', ...result };
    }

    default:
      fail(`unsupported effect "${effect.kind}"`);
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Handlers
 * ------------------------------------------------------------------ */

const handlers = {
  CHOOSE_STARTER(state, action) {
    if (state.phase !== 'starterSelect') fail('starters have already been chosen');
    const player = state.players[action.player];
    if (player.field.length > 0) fail(`${player.name} already chose a starter`);
    if (!state.starterOptions[action.player].includes(action.cardId)) {
      fail(`${action.cardId} was not offered to ${player.name}`);
    }

    const persona = createPersonaInstance(state, action.cardId, action.player);
    player.field.push(persona);
    player.activeUid = persona.uid;
    pushLog(state, `${player.name} chose ${nameOf(persona)} as their starting Persona.`, 'system');

    if (state.players.every((p) => p.field.length > 0)) {
      for (const p of state.players) drawCards(state, p.id, CONFIG.OPENING_HAND);
      state.phase = 'playing';
      state.turn = 0;
      pushLog(state, 'Both Personas are ready. Battle start!', 'system');
      beginTurn(state, 0);
    }
    return state;
  },

  PLAY_PERSONA(state, action) {
    requirePlaying(state, action);
    const { entry, card } = requireHandCard(state, action.player, action.handUid, 'persona');
    if (!hasFieldRoom(state, action.player)) fail(`field is full (max ${CONFIG.FIELD_CAP})`);

    const cap = playableLevelCap(state, action.player);
    if (card.level > cap) {
      fail(
        `${card.name} is level ${card.level}; you cannot play above level ${cap} yet ` +
          `(highest Persona on your field + ${CONFIG.PLAY_LEVEL_GAP})`
      );
    }

    const player = state.players[action.player];
    player.hand = player.hand.filter((c) => c.uid !== entry.uid);
    const persona = createPersonaInstance(state, card.id, action.player);
    player.field.push(persona);
    state.turnState.personasPlayed += 1;

    if (!player.activeUid) {
      player.activeUid = persona.uid;
      pushLog(state, `${player.name} sent out ${card.name} as their active Persona.`, 'play');
    } else {
      pushLog(state, `${player.name} put ${card.name} on the bench.`, 'play');
    }
    return state;
  },

  PLAY_ITEM(state, action) {
    requirePlaying(state, action);
    const { entry, card } = requireHandCard(state, action.player, action.handUid, 'item');
    if (state.turnState.itemsPlayed >= CONFIG.ITEMS_PER_TURN) {
      fail(`only ${CONFIG.ITEMS_PER_TURN} Item card may be played per turn`);
    }
    if (card.usesAction) requireAction(state);

    pushLog(state, `${state.players[action.player].name} used ${card.name}.`, 'play');
    applyEffect(state, action.player, card.effect, action, card.name);

    discardFromHand(state, action.player, entry.uid);
    state.turnState.itemsPlayed += 1;
    if (card.usesAction) state.turnState.actionsRemaining -= 1;
    return state;
  },

  PLAY_SPECIAL(state, action) {
    requirePlaying(state, action);
    const { entry, card } = requireHandCard(state, action.player, action.handUid, 'special');
    if (state.turnState.specialsPlayed >= CONFIG.SPECIALS_PER_TURN) {
      fail(`only ${CONFIG.SPECIALS_PER_TURN} Special card may be played per turn`);
    }
    if (card.usesAction) requireAction(state);

    pushLog(state, `${state.players[action.player].name} played ${card.name}!`, 'special');
    const result = applyEffect(state, action.player, card.effect, action, card.name);

    discardFromHand(state, action.player, entry.uid);
    state.turnState.specialsPlayed += 1;
    if (card.usesAction) consumeAction(state, result);
    return state;
  },

  CHANGE_ACTIVE(state, action) {
    requirePlaying(state, action);
    const player = state.players[action.player];
    if (state.turnState.personaChangesRemaining <= 0) fail('you have already changed Persona this turn');
    const target = requireOwnPersona(state, action.player, action.targetUid);
    if (target.uid === player.activeUid) fail(`${nameOf(target)} is already active`);
    if (target.knockedDown) fail(`${nameOf(target)} is knocked down and cannot step up`);

    const previous = getActive(state, action.player);
    player.activeUid = target.uid;
    state.turnState.personaChangesRemaining -= 1;
    if (previous) previous.guarding = false;
    pushLog(
      state,
      `${player.name} switched to ${nameOf(target)}${previous ? ` (${nameOf(previous)} to the bench)` : ''}.`,
      'swap'
    );
    return state;
  },

  ATTACK(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const attacker = requireUsableActive(state, action.player);
    const target = resolveEnemyTarget(state, action.player, action.targetUid);

    pushLog(state, `${nameOf(attacker)} attacks ${nameOf(target)}!`, 'attack');
    const result = resolveAttack(state, {
      attacker,
      defender: target,
      power: CONFIG.BASIC_ATTACK_POWER,
      damageType: 'phys',
      category: 'phys',
      effect: { kind: 'damage' },
    });
    consumeAction(state, result);
    return state;
  },

  USE_SKILL(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const attacker = requireUsableActive(state, action.player);
    const skill = getSkill(state, attacker, action.skillId);
    if (!skill) fail(`${nameOf(attacker)} does not know "${action.skillId}"`);

    const category = skillCategory(skill.type);
    if (category === 'phys') {
      // DESIGN NOTE: HP-cost skills can never kill their own user, matching the games.
      if (attacker.hp <= skill.hpCost) fail(`${nameOf(attacker)} does not have enough HP for ${skill.name}`);
    } else if ((skill.spCost ?? 0) > attacker.sp) {
      fail(`${nameOf(attacker)} does not have enough SP for ${skill.name}`);
    }

    pushLog(state, `${nameOf(attacker)} used ${skill.name}!`, 'skill');
    if (category === 'phys') attacker.hp -= skill.hpCost;
    else attacker.sp -= skill.spCost ?? 0;

    let result = null;
    if (skill.effect.kind === 'damage' || skill.effect.kind === 'instakill') {
      const target = resolveEnemyTarget(state, action.player, action.targetUid);
      result = resolveAttack(state, {
        attacker,
        defender: target,
        power: skill.power,
        damageType: skill.type,
        category,
        effect: skill.effect,
      });
    } else {
      result = applyEffect(state, action.player, skill.effect, action, skill.name);
    }

    consumeAction(state, result);
    return state;
  },

  GUARD(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const active = requireUsableActive(state, action.player);
    active.guarding = true;
    pushLog(state, `${nameOf(active)} takes a defensive stance. Halved damage, cannot be knocked down.`, 'guard');
    state.turnState.actionsRemaining -= 1;
    return state;
  },

  PASS(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    pushLog(state, `${state.players[action.player].name} passed and drew a card.`, 'pass');
    drawCards(state, action.player, CONFIG.PASS_DRAW);
    state.turnState.actionsRemaining -= 1;
    return state;
  },

  FUSE(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const player = state.players[action.player];
    const recipe = FUSION_RECIPES.find((r) => r.id === action.recipeId);
    if (!recipe) fail(`unknown fusion recipe "${action.recipeId}"`);
    if (!Array.isArray(action.sacrifices) || action.sacrifices.length !== 2) {
      fail('fusion needs exactly 2 sacrifices');
    }
    if (action.sacrifices[0].uid === action.sacrifices[1].uid) fail('fusion needs two different Personas');

    const parents = action.sacrifices.map((sac) => {
      if (sac.zone === 'hand') {
        const { entry, card } = requireHandCard(state, action.player, sac.uid, 'persona');
        return { zone: 'hand', uid: entry.uid, cardId: card.id, level: card.level, arcana: card.arcana };
      }
      const persona = requireOwnPersona(state, action.player, sac.uid);
      const card = getPersona(persona.cardId);
      return { zone: 'field', uid: persona.uid, cardId: card.id, level: persona.level, arcana: card.arcana, persona };
    });

    const wanted = [...recipe.arcana].sort();
    const got = parents.map((p) => p.arcana).sort();
    if (wanted[0] !== got[0] || wanted[1] !== got[1]) {
      fail(`${recipe.description} — got ${got.join(' + ')}`);
    }
    const combined = parents.reduce((sum, p) => sum + p.level, 0);
    if (combined < recipe.minCombinedLevel) {
      fail(`combined level ${combined} is below the required ${recipe.minCombinedLevel}`);
    }

    // Inherited skills: one chosen from each parent, in sacrifice order.
    const inherit = action.inherit || [];
    if (inherit.length !== 2) fail('fusion inherits exactly 1 skill from each parent');
    const inheritedSkills = [];
    parents.forEach((parent, i) => {
      const card = getPersona(parent.cardId);
      const available = parent.persona
        ? personaSkills(state, parent.persona)
        : card.skills.filter((s) => s.unlockLevel <= card.level);
      const chosen = available.find((s) => s.id === inherit[i]);
      if (!chosen) fail(`${card.name} cannot pass on "${inherit[i]}"`);
      inheritedSkills.push(chosen.id);
    });

    // Remove the parents (sacrifices never count as KOs).
    let sacrificedActive = false;
    for (const parent of parents) {
      if (parent.zone === 'hand') {
        discardFromHand(state, action.player, parent.uid);
      } else {
        player.field = player.field.filter((p) => p.uid !== parent.uid);
        player.discard.push(parent.cardId);
        if (player.activeUid === parent.uid) {
          player.activeUid = null;
          sacrificedActive = true;
        }
      }
    }

    if (!hasFieldRoom(state, action.player)) fail(`field is full (max ${CONFIG.FIELD_CAP})`);

    const result = createPersonaInstance(state, recipe.result, action.player, { inheritedSkills });
    player.field.push(result);
    pushLog(
      state,
      `${parents.map((p) => getPersona(p.cardId).name).join(' + ')} fused into ${nameOf(result)} (Lv ${result.level})!`,
      'fusion'
    );
    const inheritedNames = inheritedSkills.map((id) => personaSkills(state, result).find((s) => s.id === id)?.name);
    pushLog(state, `${nameOf(result)} inherited ${inheritedNames.filter(Boolean).join(' and ')}.`, 'fusion');

    // If the fusion consumed your active Persona, the result steps into the
    // slot it vacated rather than letting an arbitrary bench Persona take it.
    if (sacrificedActive) {
      player.activeUid = result.uid;
      pushLog(state, `${nameOf(result)} takes the active slot.`, 'swap');
    } else {
      promoteActiveIfEmpty(state, action.player);
    }

    state.turnState.actionsRemaining -= 1;
    return state;
  },

  END_TURN(state, action) {
    requirePlaying(state, action);
    const player = state.players[action.player];
    const overflow = Math.max(0, player.hand.length - CONFIG.HAND_LIMIT);
    const discards = action.discard || [];
    if (discards.length !== overflow) {
      fail(`you must discard exactly ${overflow} card(s) to reach the hand limit of ${CONFIG.HAND_LIMIT}`);
    }
    for (const uid of discards) {
      const entry = discardFromHand(state, action.player, uid);
      pushLog(state, `${player.name} discarded ${getCard(entry.cardId).name}.`, 'discard');
    }

    runEndOfTurn(state, action.player);
    evaluateGameEnd(state);
    if (state.winner !== null) return state;

    beginTurn(state, opponentOf(action.player));
    return state;
  },
};

/* ------------------------------------------------------------------ *
 * Public reducer
 * ------------------------------------------------------------------ */

export function applyAction(state, action) {
  if (!action || !handlers[action.type]) throw new Error(`Unknown action type "${action?.type}"`);
  if (state.winner !== null) fail('the match is already over');

  const draft = cloneState(state);
  handlers[action.type](draft, action);
  evaluateGameEnd(draft);
  return draft;
}

export { grantOneMore, beginTurn };
