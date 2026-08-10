/**
 * The reducer: `applyAction(state, action) -> newState`.
 *
 * Pure and deterministic. It clones the incoming state, mutates the draft, and
 * returns it. Illegal actions throw rather than silently no-op, so bugs in the
 * UI or the bot surface immediately instead of corrupting a match.
 */
import { CONFIG, skillCategory } from './config.js';
import { getCard, getPersona, getShowtime, getSkillDefinition, FUSION_RECIPES } from '../data/cards.js';
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
  canTargetBench,
  remainingPersonaArcana,
  mimicableSkill,
  affinitiesFullyRevealed,
  affinitiesOf,
  availableShowtimes,
  bumpStat,
  gallowsMeal,
} from './state.js';
import { fusionAvailable } from './legal.js';
import {
  chainsOneMore,
  koDeficit,
  fusionLevelBonus,
  printedPassive,
  passiveOf,
  passiveDefinition,
  momentumDraw,
  PASSIVE_CHOICE_PREFIX,
} from './passives.js';
import {
  drawCards,
  discardFromHand,
  healPersona,
  restoreSp,
  fullRestore,
  revivePersona,
  cureAilments,
  applyAilment,
  applyBuff,
  dispelBuffs,
  addCharge,
  resolveAttack,
  applyDamage,
  evaluateGameEnd,
  endGame,
  runStartOfTurn,
  runEndOfTurn,
  promoteActiveIfEmpty,
  levelUp,
  revealAllTypes,
  rewriteAffinities,
  twistFate,
  twistableElements,
  canAffordBestSkill,
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
  if (active.warded) fail(`${nameOf(active)} is wrapped in a moonless gown and cannot act`);
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
 * Resolve the legal target of an offensive effect.
 *
 * Baseline targeting is active-only. Two things open up the bench: the Ambush
 * Special (whole turn) and an unspent One More — the single baseline exception,
 * so a weakness knockdown lets you reach past the wall and hit what is hiding
 * behind it.
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
  if (target.uid !== active?.uid && !canTargetBench(state)) {
    fail("only the opponent's active Persona can be targeted (a One More or Ambush opens up the bench)");
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

  bumpStat(state, playerId, 'turnsTaken');
  if (fusionAvailable(state, playerId)) bumpStat(state, playerId, 'fusionReadyTurns');

  evaluateGameEnd(state);
  return state;
}

/**
 * Grant a One More: one extra action this turn, plus one extra Persona change
 * (Baton Pass), plus the right to aim that action at any enemy Persona.
 *
 * Baseline is MAX_ONE_MORE_PER_TURN (1). The Trickster passive on the acting
 * Persona lifts the cap, so knockdowns scored during a One More keep the chain
 * going. The chain is still finite: each enemy Persona can only be knocked down
 * once while standing, so it is bounded by the enemy field.
 */
function grantOneMore(state, attacker) {
  const turn = state.turnState;
  const chains = chainsOneMore(attacker);
  if (!chains && turn.oneMoresGranted >= CONFIG.MAX_ONE_MORE_PER_TURN) {
    pushLog(state, 'One More already used this turn.', 'info');
    return false;
  }
  turn.oneMoresGranted += 1;
  turn.oneMoreUsed = true;
  bumpStat(state, attacker.owner, 'oneMores');
  turn.oneMoreActive = true;
  turn.actionsRemaining += 1;
  turn.personaChangesRemaining += 1;
  pushLog(
    state,
    chains && turn.oneMoresGranted > 1
      ? `ONE MORE! ${nameOf(attacker)} keeps the chain alive (Trickster).`
      : 'ONE MORE! Extra action, an extra Persona change (Baton Pass), and the enemy bench is open.',
    'onemore'
  );
  return true;
}

/**
 * Spend one action. Any action spends the pending One More, so the bench closes
 * again the moment it is used — whether on an attack, a Guard or a fusion.
 */
function spendAction(state) {
  state.turnState.actionsRemaining -= 1;
  state.turnState.oneMoreActive = false;
}

/**
 * Spend the action, then hand out a One More if the hit knocked a STANDING
 * Persona down with a weakness.
 *
 * DESIGN NOTE: a killing blow grants no One More. `knockedDown` is only set
 * when the target survives on its feet and is put on its back; a Persona that
 * is knocked out is off the board entirely, and the reward for that is the
 * level-up the killer already receives. This also makes the rule single-valued:
 * one flag decides it, and hitting something already down can never qualify.
 */
function consumeAction(state, result, attacker) {
  spendAction(state);
  if (result?.knockedDown && attacker) grantOneMore(state, attacker);
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

    /**
     * A Skill Card. The taught skill goes on the instance, alongside anything
     * a fusion handed down, so `personaSkills` picks it up with no unlock level
     * to satisfy — a Skill Card is exactly how you patch a hole in your board's
     * element coverage without waiting for a level.
     */
    case 'teachSkill': {
      const student = requireOwnPersona(state, playerId, action.targetUid);
      const skill = getSkillDefinition(effect.skillId) || fail(`unknown skill "${effect.skillId}"`);
      if (personaSkills(state, student).some((s) => s.id === skill.id)) {
        fail(`${nameOf(student)} already knows ${skill.name}`);
      }
      student.inheritedSkills.push(skill.id);
      pushLog(state, `${nameOf(student)} learned ${skill.name} from the card!`, 'levelup');
      return { kind: 'teachSkill' };
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

    /**
     * The rewrite Specials — one per flavour.
     *
     * They exist for two reasons. The card database is finite and memorisable,
     * so a dedicated player eventually stops reading the board and starts
     * reciting; and the Brutal bot reads that same database outright. Rewriting
     * a chart invalidates both at once.
     */
    case 'rewriteAffinities': {
      const targets = [];
      if (effect.scope === 'ownAny') {
        targets.push(requireOwnPersona(state, playerId, action.targetUid));
      } else {
        targets.push(getActive(state, playerId) || fail('you have no active Persona'));
        if (effect.scope === 'bothActive') {
          targets.push(getActive(state, foeId) || fail('the opponent has no active Persona'));
        }
      }

      const changed = targets.filter((persona) => rewriteAffinities(state, persona));
      if (!changed.length) fail('there is nothing there to rewrite');
      return { kind: 'rewriteAffinities', count: changed.length };
    }

    /**
     * Twist of Fate: the surgical version of a rewrite.
     *
     * The rewrite Specials scramble a whole chart and hand you a new problem to
     * solve. This makes one precise edit — you name the element, so it is the
     * answer to "my deck cannot hit anything they are weak to" — and pays for
     * that precision by letting the DEFENDER decide which of their weaknesses
     * they give up for it. See twistSacrifice() for how that choice is made
     * without stopping to ask.
     */
    case 'twistFate': {
      const target = getActive(state, foeId) || fail('the opponent has no active Persona');
      const allowed = twistableElements(target);
      if (!allowed.length) fail(`${nameOf(target)} has no weakness that could be twisted`);

      const element = action.element ?? allowed[0];
      if (!allowed.includes(element)) {
        // The one rule worth spelling out in the error: a resist beats a
        // weakness, so naming something they resist would be a dead card.
        const { resists } = affinitiesOf(target);
        fail(
          resists.includes(element)
            ? `${nameOf(target)} resists ${element} — you cannot make it a weakness`
            : `${sourceName} cannot name "${element}" here`
        );
      }

      const given = twistFate(state, target, element);
      if (given === null) fail('there is nothing there to twist');
      return { kind: 'twistFate', element, given };
    }

    /**
     * Lesser Theurgy: an ailment with no dice attached.
     *
     * Every other source of Burn or Shock is a percentage rider on a fire or
     * electric skill, which makes the whole Technical system something you hope
     * for rather than something you plan. This is the one card that lets you
     * decide to have a Technical next turn. The choice of which ailment is the
     * decision: Shock sets up a physical Technical *this* turn (it expires at
     * the end of their next turn), Burn sets one up for the turn after and
     * ticks in the meantime.
     */
    case 'inflict': {
      const target = getActive(state, foeId) || fail('the opponent has no active Persona');
      const wanted = action.ailment ?? effect.ailments[0];
      if (!effect.ailments.includes(wanted)) fail(`${sourceName} cannot inflict "${wanted}"`);
      applyAilment(state, target, wanted);
      return { kind: 'inflict', ailment: wanted };
    }

    /**
     * Spirit Drain: no damage, just resource warfare.
     *
     * DESIGN NOTE: the steal is capped by what the target actually has, and the
     * attacker gains as much of it as its own pool has room for. When the
     * attacker is already full the SP is still taken — denying it is half the
     * point, and a Persona that could not use it should not be able to protect
     * it either.
     */
    case 'drainSp': {
      const thief = getActive(state, playerId) || fail('you have no active Persona');
      const victim = resolveEnemyTarget(state, playerId, action.targetUid);
      const stolen = Math.max(0, Math.min(effect.amount, victim.sp));
      if (stolen <= 0) fail(`${nameOf(victim)} has no SP left to take`);

      const gained = Math.min(stolen, thief.maxSp - thief.sp);
      victim.sp -= stolen;
      thief.sp += gained;
      bumpStat(state, playerId, 'spSpent', -gained);
      pushLog(
        state,
        gained < stolen
          ? `${nameOf(thief)} drained ${stolen} SP from ${nameOf(victim)}, but could only hold ${gained}.`
          : `${nameOf(thief)} drained ${stolen} SP from ${nameOf(victim)}.`,
        'special'
      );
      return { kind: 'drainSp', stolen, gained };
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

    /* --- Strategic Specials ------------------------------------------- */

    case 'guaranteedDraw': {
      // Reserves the next draw rather than drawing now, so it stacks with the
      // card you are about to draw at the start of your next turn.
      const arcana = action.arcana ?? null;
      if (arcana && !remainingPersonaArcana(state, playerId).includes(arcana)) {
        fail(`you have no ${arcana} Persona left in your deck`);
      }
      state.players[playerId].pendingDraw = { arcana, best: Boolean(effect.best) };
      pushLog(
        state,
        `${state.players[playerId].name}'s next draw is locked to ${
          effect.best ? 'their strongest' : 'a'
        } ${arcana ?? ''} Persona.`.replace(/\s+/g, ' '),
        'special'
      );
      return { kind: 'guaranteedDraw' };
    }

    /**
     * Whims of Fate. Reserves the next draw for something that can actually
     * punish what is standing opposite you.
     *
     * DESIGN NOTE: the widened mode reads weaknesses the player has NOT
     * uncovered, which is the one place in the game where hidden information
     * leaks into a decision. It is gated behind being two knockouts down on
     * purpose — that is the comeback the card is for — and the fetch does not
     * mark anything revealed, so you get the answer without being told the
     * question. Redaction strips the resolved type list from every view, so
     * neither player can read it off the state either.
     */
    case 'fateFetch': {
      const target = getActive(state, foeId) || fail('the opponent has no active Persona to read');
      const behind = koDeficit(state, playerId) >= CONFIG.WHIMS_DEFICIT;
      const { weaknesses } = affinitiesOf(target);
      const types = behind
        ? [...weaknesses]
        : weaknesses.filter((type) => target.revealedTypes.includes(type));

      state.players[playerId].pendingDraw = { types };
      pushLog(
        state,
        types.length
          ? `Fate turns toward ${nameOf(target)}${behind ? ' — and it is not being subtle about it.' : '.'}`
          : 'Fate finds nothing to point at.',
        'special'
      );
      return { kind: 'fateFetch', types: types.length, widened: behind };
    }

    /**
     * Providence: read the top of your deck and throw away what you do not
     * want. Whatever survives stays on top, in the order it was already in.
     */
    case 'providence': {
      const player = state.players[playerId];
      const look = Math.min(effect.look ?? CONFIG.PROVIDENCE_LOOK, player.deck.length);
      if (!look) fail('your deck is empty');

      const requested = action.discardIndexes ?? [];
      if (!Array.isArray(requested)) fail('Providence needs a list of cards to discard');
      const indexes = new Set(requested);
      for (const index of indexes) {
        if (!Number.isInteger(index) || index < 0 || index >= look) fail(`pick from the top ${look} cards`);
      }

      const top = player.deck.splice(0, look);
      const kept = top.filter((_, index) => !indexes.has(index));
      const binned = top.filter((_, index) => indexes.has(index));
      player.deck.unshift(...kept);
      player.discard.push(...binned);

      pushLog(
        state,
        binned.length
          ? `${player.name} read ${look} and discarded ${binned.map((id) => getCard(id).name).join(', ')}.`
          : `${player.name} read ${look} and kept them all.`,
        'draw'
      );
      return { kind: 'providence', discarded: binned.length };
    }

    case 'growth': {
      const bench = benchOf(state, playerId);
      if (!bench.length) fail('you have no benched Personas to train');
      for (const persona of bench) levelUp(state, persona, effect.levels ?? 1);
      return { kind: 'growth', count: bench.length };
    }

    case 'forceSwitch': {
      const foe = state.players[foeId];
      const current = getActive(state, foeId) || fail('the opponent has no active Persona');
      const options = benchOf(state, foeId).filter((p) => !p.knockedDown);
      if (!options.length) fail('the opponent has nobody to switch to');

      // DESIGN NOTE: the card says the opponent chooses, and mechanically they
      // do — the engine simply plays their best interest for them (healthiest,
      // then highest level, then field order) rather than opening an interrupt
      // window mid-turn. An interrupt would mean handing the device over in
      // hot-seat and a blocking round-trip online, for a choice with an obvious
      // right answer. What matters for play is that YOU do not pick.
      const best = [...options].sort((a, b) => {
        const ratio = b.hp / b.maxHp - a.hp / a.maxHp;
        if (Math.abs(ratio) > 1e-9) return ratio;
        if (b.level !== a.level) return b.level - a.level;
        return foe.field.indexOf(a) - foe.field.indexOf(b);
      })[0];

      foe.activeUid = best.uid;
      current.guarding = false;
      pushLog(state, `${nameOf(current)} was dragged off the field — ${nameOf(best)} steps up.`, 'swap');
      return { kind: 'forceSwitch' };
    }

    case 'reveal': {
      const target = getActive(state, foeId) || fail('the opponent has no active Persona');
      revealAllTypes(state, target);
      return { kind: 'reveal' };
    }

    case 'peekHand': {
      if (!state.players[foeId].hand.length) fail('the opponent has no cards in hand');
      // A rule about what the player is allowed to KNOW, so redaction honours it
      // (see redact.js) rather than the UI quietly reading a hidden hand.
      state.turnState.peekHand = true;
      pushLog(state, `${state.players[playerId].name} is reading ${state.players[foeId].name}'s hand!`, 'special');
      return { kind: 'peekHand' };
    }

    case 'recall': {
      const player = state.players[playerId];
      const target = requireOwnPersona(state, playerId, action.targetUid, { allowKo: true });
      if (!target.ko) fail(`${nameOf(target)} is not knocked out`);
      player.field = player.field.filter((p) => p.uid !== target.uid);
      player.hand.push({ uid: `c${state.nextUid++}`, cardId: target.cardId });
      // The KO already counted for the opponent and stays counted.
      pushLog(state, `${nameOf(target)} returned to ${player.name}'s hand. The knockout still stands.`, 'special');
      return { kind: 'recall' };
    }

    case 'swapHpSp': {
      const target = getActive(state, playerId) || fail('you have no active Persona');
      const hp = target.hp;
      const sp = target.sp;
      target.hp = Math.max(1, Math.min(target.maxHp, sp));
      target.sp = Math.min(target.maxSp, hp);
      pushLog(state, `${nameOf(target)} inverted: ${hp} HP / ${sp} SP became ${target.hp} HP / ${target.sp} SP.`, 'special');
      return { kind: 'swapHpSp' };
    }

    case 'mimic': {
      const attacker = getActive(state, playerId) || fail('you have no active Persona');
      const skill = mimicableSkill(state, playerId) || fail('the opponent has not used a skill yet');
      pushLog(state, `${nameOf(attacker)} borrows ${skill.name}!`, 'skill');

      if (skill.effect.kind === 'damage') {
        const target = resolveEnemyTarget(state, playerId, action.targetUid);
        const result = resolveAttack(state, {
          attacker,
          defender: target,
          power: skill.power,
          damageType: skill.type,
          category: skillCategory(skill.type),
          effect: skill.effect,
          sourceName: skill.name,
        });
        return { kind: 'damage', ...result };
      }
      return applyEffect(state, playerId, skill.effect, action, skill.name);
    }

    /* --- Flavour-exclusive Specials ----------------------------------- */

    case 'phantomStrike': {
      // The Phantom Thieves do not improvise: you have to have read the mark
      // first. Only fires if the enemy active's whole chart is already open.
      const target = getActive(state, foeId) || fail('the opponent has no active Persona');
      if (!affinitiesFullyRevealed(target)) fail(`${nameOf(target)} has not been fully scouted yet`);
      state.turnState.phantomStrike = true;
      pushLog(state, `${sourceName}! The next weakness you strike hits from the shadows.`, 'special');
      return { kind: 'phantomStrike' };
    }

    case 'swapFree': {
      const player = state.players[playerId];
      const target = requireOwnPersona(state, playerId, action.targetUid);
      if (target.uid === player.activeUid) fail(`${nameOf(target)} is already active`);
      if (target.knockedDown) fail(`${nameOf(target)} is knocked down and cannot step up`);
      const previous = getActive(state, playerId);
      player.activeUid = target.uid;
      if (previous) previous.guarding = false;
      // Deliberately does NOT touch personaChangesRemaining — that is the card.
      pushLog(state, `Smoke and mirrors: ${nameOf(target)} steps in for free.`, 'swap');
      return { kind: 'swapFree' };
    }

    case 'shuffleTime': {
      const player = state.players[playerId];
      const look = Math.min(effect.look ?? CONFIG.SHUFFLE_TIME_LOOK, player.deck.length);
      if (!look) fail('your deck is empty');
      const index = action.keepIndex ?? 0;
      if (!Number.isInteger(index) || index < 0 || index >= look) fail(`pick one of the top ${look} cards`);

      const top = player.deck.splice(0, look);
      const [kept] = top.splice(index, 1);
      player.hand.push({ uid: `c${state.nextUid++}`, cardId: kept });
      player.deck.push(...top); // the rest go to the bottom, in the order they were
      pushLog(state, `${player.name} read the cards and took ${getCard(kept).name}.`, 'draw');
      return { kind: 'shuffleTime' };
    }

    case 'evolve': {
      const target = getActive(state, playerId) || fail('you have no active Persona');
      const card = getPersona(target.cardId);
      const known = new Set(personaSkills(state, target).map((s) => s.id));
      const next = card.skills
        .filter((s) => !known.has(s.id))
        .sort((a, b) => a.unlockLevel - b.unlockLevel)[0];
      if (!next) fail(`${nameOf(target)} already knows everything it can learn`);
      target.inheritedSkills.push(next.id);
      pushLog(state, `${nameOf(target)} broke through and learned ${next.name}!`, 'levelup');
      return { kind: 'evolve' };
    }

    case 'darkHour': {
      state.darkHour = { turnsLeft: effect.turns ?? CONFIG.DARK_HOUR_TURNS };
      pushLog(
        state,
        `The Dark Hour falls. Every skill and attack hits for x${CONFIG.DARK_HOUR_MULT} — for both sides.`,
        'special'
      );
      return { kind: 'darkHour' };
    }

    case 'ward': {
      const target = getActive(state, playerId) || fail('you have no active Persona');
      target.warded = true;
      pushLog(state, `${nameOf(target)} is wrapped in a moonless gown — untouchable, and unable to act.`, 'guard');
      return { kind: 'ward' };
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
        // A flat Special ignores Charge entirely, so it must not eat one either.
        const wantedCharge = category === 'phys' ? 'charge' : 'concentrate';
        const hadCharge = !effect.flat && attacker.charges.includes(wantedCharge);

        let anyWeak = false;
        let anyKnockedDown = false;
        for (const target of targets) {
          const result = resolveAttack(state, {
            attacker,
            defender: target,
            power: effect.amount ?? effect.power,
            damageType: effect.damageType,
            category,
            flat: effect.flat,
            effect: { kind: 'damage' },
            consumeCharge: false,
            sourceName,
          });
          anyWeak = anyWeak || result.weak;
          anyKnockedDown = anyKnockedDown || result.knockedDown;
        }
        if (hadCharge) attacker.charges = attacker.charges.filter((c) => c !== wantedCharge);
        return { kind: 'damage', weak: anyWeak, knockedDown: anyKnockedDown };
      }

      const target = resolveEnemyTarget(state, playerId, action.targetUid);
      const result = resolveAttack(state, {
        attacker,
        defender: target,
        power: effect.amount ?? effect.power,
        damageType: effect.damageType,
        category,
        flat: effect.flat,
        effect: { kind: 'damage' },
        sourceName,
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
    // Arrives at full SP, like every other Persona entering play.
    const persona = createPersonaInstance(state, card.id, action.player);
    player.field.push(persona);
    state.turnState.personasPlayed += 1;
    bumpStat(state, action.player, 'cardsPlayed');

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
    bumpStat(state, action.player, 'cardsPlayed');
    if (card.usesAction) spendAction(state);
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
    // Captured before the effect resolves: the Persona that delivered the card
    // is the one whose Trickster passive (if any) governs the One More.
    const deliveredBy = getActive(state, action.player);
    const result = applyEffect(state, action.player, card.effect, action, card.name);

    discardFromHand(state, action.player, entry.uid);
    state.turnState.specialsPlayed += 1;
    bumpStat(state, action.player, 'cardsPlayed');
    if (card.usesAction) consumeAction(state, result, deliveredBy);
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
      sourceName: 'Attack',
    });
    consumeAction(state, result, attacker);
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
    if (category === 'phys') {
      attacker.hp -= skill.hpCost;
    } else {
      attacker.sp -= skill.spCost ?? 0;
      bumpStat(state, action.player, 'spSpent', skill.spCost ?? 0);
    }

    let result = null;
    if (skill.effect.kind === 'damage') {
      const target = resolveEnemyTarget(state, action.player, action.targetUid);
      result = resolveAttack(state, {
        attacker,
        defender: target,
        power: skill.power,
        damageType: skill.type,
        category,
        effect: skill.effect,
        sourceName: skill.name,
      });
    } else {
      result = applyEffect(state, action.player, skill.effect, action, skill.name);
    }

    // The last skill each player used, so Wild Card can copy it.
    state.players[action.player].lastSkillId = skill.id;

    // Phantom Strike pays the skill back when it lands on a weakness.
    if (result?.phantom && category !== 'phys') {
      const refund = skill.spCost ?? 0;
      attacker.sp = Math.min(attacker.maxSp, attacker.sp + refund);
      bumpStat(state, action.player, 'spSpent', -refund);
      if (refund > 0) pushLog(state, `${skill.name} cost nothing — the shadows paid for it.`, 'special');
    }

    // Momentum: a cheap skill keeps the cards flowing, once a turn.
    const drawn = momentumDraw(attacker, { skill, alreadyUsed: state.turnState.momentumUsed });
    if (drawn > 0) {
      state.turnState.momentumUsed = true;
      pushLog(state, `${nameOf(attacker)} keeps the tempo — draw ${drawn}. (Momentum)`, 'draw');
      drawCards(state, action.player, drawn);
    }

    consumeAction(state, result, attacker);

    // Alacrity: a knockdown from a fast skill hands your Persona change back,
    // so a Swift board can hit, rotate and hit again inside one turn.
    if (skill.alacrity && result?.knockedDown) {
      state.turnState.personaChangesRemaining += CONFIG.ALACRITY_REFUND;
      pushLog(state, `${skill.name} was over before they could react — Persona change refunded. (Alacrity)`, 'swap');
    }
    return state;
  },

  GUARD(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const active = requireUsableActive(state, action.player);
    active.guarding = true;
    bumpStat(state, action.player, 'guards');
    pushLog(state, `${nameOf(active)} takes a defensive stance. Halved damage, cannot be knocked down.`, 'guard');
    spendAction(state);
    return state;
  },

  PASS(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    pushLog(state, `${state.players[action.player].name} passed and drew a card.`, 'pass');
    drawCards(state, action.player, CONFIG.PASS_DRAW);
    spendAction(state);
    return state;
  },

  FUSE(state, action) {
    requirePlaying(state, action);
    // Free, like playing an Item or a Special — rationed per turn instead of
    // out of the action budget, so it never has to beat an attack to happen.
    if (state.turnState.fusionsPerformed >= CONFIG.FUSIONS_PER_TURN) {
      fail(`only ${CONFIG.FUSIONS_PER_TURN} fusion per turn`);
    }
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

    // Inheritance: from EACH parent, one skill OR that parent's passive.
    // A choice is `"passive:<id>"` for the passive, otherwise a skill id.
    const inherit = action.inherit || [];
    if (inherit.length !== 2) fail('fusion inherits exactly 1 thing from each parent');
    const inheritedSkills = [];
    let inheritedPassive = null;
    parents.forEach((parent, i) => {
      const card = getPersona(parent.cardId);
      const choice = inherit[i];

      if (typeof choice === 'string' && choice.startsWith(PASSIVE_CHOICE_PREFIX)) {
        const wanted = choice.slice(PASSIVE_CHOICE_PREFIX.length);
        const owned = parent.persona ? passiveOf(parent.persona) : printedPassive(parent.cardId);
        if (!owned) fail(`${card.name} has no passive to pass on`);
        if (owned !== wanted) fail(`${card.name}'s passive is ${owned}, not "${wanted}"`);
        if (inheritedPassive) fail('a fusion result can inherit at most one passive');
        inheritedPassive = owned;
        return;
      }

      const available = parent.persona
        ? personaSkills(state, parent.persona)
        : card.skills.filter((s) => s.unlockLevel <= card.level);
      const chosen = available.find((s) => s.id === choice);
      if (!chosen) fail(`${card.name} cannot pass on "${choice}"`);
      inheritedSkills.push(chosen.id);
    });

    // Overwriting the result's own printed passive is a real loss, so it takes
    // an explicit confirmation rather than happening silently.
    const nativePassive = printedPassive(recipe.result);
    if (inheritedPassive && nativePassive && inheritedPassive !== nativePassive && !action.replacePassive) {
      fail(
        `${getPersona(recipe.result).name} already has ${passiveDefinition(nativePassive)?.name ?? nativePassive}; ` +
          'confirm the replacement to inherit a passive over it'
      );
    }

    // Sacrificial Lamb: a material that would rather be fed than fielded hands
    // the result extra levels. Read before the parents leave the board.
    const bonusLevels = fusionLevelBonus(
      parents.map((parent) => parent.persona ?? { cardId: parent.cardId, passive: printedPassive(parent.cardId) })
    );

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

    const result = createPersonaInstance(state, recipe.result, action.player, {
      inheritedSkills,
      passive: inheritedPassive ?? nativePassive,
    });
    player.field.push(result);
    const parentNames = parents.map((p) => getPersona(p.cardId).name);
    const skillNames = inheritedSkills.map((id) => personaSkills(state, result).find((s) => s.id === id)?.name);
    const passiveName = inheritedPassive ? passiveDefinition(inheritedPassive)?.name ?? inheritedPassive : null;

    pushLog(
      state,
      `${parentNames.join(' + ')} fused into ${nameOf(result)} (Lv ${result.level})!`,
      'fusion',
      // The cast list, so the Velvet Room animation does not have to read the
      // sentence above back apart.
      {
        parents: parentNames,
        result: nameOf(result),
        level: result.level,
        arcana: getPersona(result.cardId).arcana,
        passive: passiveName,
        skills: skillNames.filter(Boolean),
      }
    );
    const inheritedNames = [...skillNames];
    if (passiveName) inheritedNames.push(`the ${passiveName} passive`);
    pushLog(state, `${nameOf(result)} inherited ${inheritedNames.filter(Boolean).join(' and ')}.`, 'fusion');
    if (bonusLevels > 0) levelUp(state, result, bonusLevels);
    bumpStat(state, action.player, 'fusions');

    // If the fusion consumed your active Persona, the result steps into the
    // slot it vacated rather than letting an arbitrary bench Persona take it.
    if (sacrificedActive) {
      player.activeUid = result.uid;
      pushLog(state, `${nameOf(result)} takes the active slot.`, 'swap');
    } else {
      promoteActiveIfEmpty(state, action.player);
    }

    state.turnState.fusionsPerformed += 1;
    return state;
  },

  /**
   * A Showtime: both halves of a duo, on the board and on their feet, hitting
   * at once. Costs your action and is gone for the rest of the match.
   */
  SHOWTIME(state, action) {
    requirePlaying(state, action);
    requireAction(state);
    const player = state.players[action.player];
    const showtime = getShowtime(action.showtimeId) || fail(`unknown Showtime "${action.showtimeId}"`);
    if (player.showtimesUsed.includes(showtime.id)) fail(`${showtime.name} has already been used this match`);
    if (!availableShowtimes(state, action.player).some((s) => s.id === showtime.id)) {
      fail(`${showtime.name} needs ${showtime.pair.map((id) => getPersona(id).name).join(' and ')} standing on your field`);
    }

    // The active Persona leads, so its Trickster passive (if any) governs the
    // One More — exactly as it does for a Special.
    const deliveredBy = getActive(state, action.player);
    pushLog(state, `SHOWTIME! ${showtime.name} — ${showtime.pair.map((id) => getPersona(id).name).join(' & ')}!`, 'showtime');
    const result = applyEffect(state, action.player, showtime.effect, action, showtime.name);

    player.showtimesUsed.push(showtime.id);
    bumpStat(state, action.player, 'showtimes');
    consumeAction(state, result, deliveredBy);
    return state;
  },

  /**
   * The Gallows: feed one of your Personas to another.
   *
   * Fusion answers "these two are worth more as one body"; the Gallows answers
   * "this one is worth more as fuel". Food within COMEBACK_FARM_GAP of the
   * eater teaches it a level — the same lesson a knockout would — and anything
   * further below that is junk food, worth a meal's HP and nothing more, so a
   * high-level Persona can't be farmed out of your own opening hand.
   *
   * Sacrificed Personas are never knockouts: this costs you a card, not a pip
   * on your opponent's tally.
   */
  GALLOWS(state, action) {
    requirePlaying(state, action);
    const player = state.players[action.player];
    if (state.turnState.gallowsUsed >= CONFIG.GALLOWS_PER_TURN) {
      fail(`only ${CONFIG.GALLOWS_PER_TURN} Gallows sacrifice per turn`);
    }

    const eater = requireOwnPersona(state, action.player, action.eaterUid);
    const food = action.food;
    if (!food || (food.zone !== 'field' && food.zone !== 'hand')) fail('the Gallows needs a Persona to feed it');

    // Work out what the meal is worth BEFORE consuming anything: the top two
    // tiers cost the action, and refusing a play is only honest if nothing has
    // been eaten yet.
    let level;
    let passive;
    let name;
    if (food.zone === 'hand') {
      const { card } = requireHandCard(state, action.player, food.uid, 'persona');
      ({ level, name } = card);
      passive = printedPassive(card.id);
    } else {
      if (food.uid === eater.uid) fail('a Persona cannot feed itself');
      const victim = requireOwnPersona(state, action.player, food.uid);
      level = victim.level;
      passive = passiveOf(victim);
      name = nameOf(victim);
    }

    const meal = gallowsMeal(eater.level, level, passive, eater.maxHp);
    if (meal.usesAction) requireAction(state);

    // Committed: take the food off the board or out of the hand.
    if (food.zone === 'hand') {
      discardFromHand(state, action.player, food.uid);
    } else {
      const victim = requireOwnPersona(state, action.player, food.uid);
      player.field = player.field.filter((p) => p.uid !== victim.uid);
      player.discard.push(victim.cardId);
      if (player.activeUid === victim.uid) player.activeUid = null;
    }

    pushLog(state, `${name} is sent to the Gallows to feed ${nameOf(eater)}.`, 'gallows', {
      food: name,
      eater: nameOf(eater),
      eaterUid: eater.uid,
      tier: meal.tier,
      levels: meal.levels,
    });

    if (meal.nourishing) {
      // Sacrificial Lamb would rather be eaten than fielded, and pays extra for it.
      if (meal.tier === 'feast') {
        pushLog(state, `${name} was its equal — ${nameOf(eater)} feasts.`, 'gallows');
      }
      levelUp(state, eater, meal.levels);
    } else {
      pushLog(
        state,
        `${name} was ${eater.level - level} levels too far beneath ${nameOf(eater)} to teach it anything — ` +
          'but a meal is a meal, and scraping the plate costs no action.',
        'gallows'
      );
      healPersona(state, eater, meal.heal);
    }

    bumpStat(state, action.player, 'gallows');
    promoteActiveIfEmpty(state, action.player);
    // The once-per-turn cap covers all three tiers, so a free junk meal still
    // closes the Gallows for the turn — it is tempo, not an engine.
    state.turnState.gallowsUsed += 1;
    if (meal.usesAction) spendAction(state);
    return state;
  },

  /**
   * Resign. The one action deliberately NOT gated on whose turn it is.
   *
   * DESIGN NOTE: `getLegalActions` only offers this on your own turn, because
   * that is the list the bot and the auto-end logic read and neither should
   * ever consider quitting. The handler is looser on purpose: giving up is not
   * a move in the game, and a player who has decided a match is over should not
   * have to wait for their opponent to finish a turn to say so. The UI offers
   * it at any time, and online it arrives as an ordinary action message.
   */
  RESIGN(state, action) {
    if (state.phase === 'gameOver') fail('the match is already over');
    const player = state.players[action.player];
    if (!player) fail(`no such player "${action.player}"`);
    pushLog(state, `${player.name} resigned.`, 'resign');
    endGame(state, opponentOf(action.player), 'resign');
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

    // Ending a turn with the active Persona's SP untouched, every turn, is the
    // clearest sign a player is only using basic attacks.
    const active = getActive(state, action.player);
    if (active) {
      if (active.sp >= active.maxSp) bumpStat(state, action.player, 'turnsEndedFullSp');
      bumpStat(state, action.player, 'spUnspentAtTurnEnd', active.sp);
      // Was the strongest thing this Persona knows actually out of reach? This
      // is the SP-pressure number: at zero, SP is not a constraint at all.
      if (!canAffordBestSkill(state, active)) bumpStat(state, action.player, 'turnsBestSkillUnaffordable');
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
