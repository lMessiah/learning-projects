/**
 * Shared effect primitives.
 *
 * Every rule that changes a Persona goes through exactly one function here, so
 * a Persona skill, an Item and a Special that all say "Tarukaja" behave
 * identically. These mutate the *draft* state that `applyAction` cloned — they
 * are never called on a state the caller still holds a reference to.
 */
import { CONFIG } from './config.js';
import { shuffle, rollChance } from './rng.js';
import { getPersona } from '../data/cards.js';
import { computeDamage, instakillChance, affinityOf } from './damage.js';
import { pushLog, opponentOf, livingField, totalRemainingHp } from './state.js';

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
    const cardId = player.deck.shift();
    const entry = { uid: `c${state.nextUid++}`, cardId };
    player.hand.push(entry);
    drawn.push(entry);
  }
  return drawn;
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
  persona.sp = Math.max(persona.sp, 0);
  // The KO already counted for the opponent and stays counted.
  pushLog(state, `${nameOf(persona)} was revived with ${persona.hp} HP.`, 'heal');
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
 * Deal already-computed damage. Returns { dealt, ko }.
 * `killer` gets the level-up credit if this drops the target.
 */
export function applyDamage(state, defender, amount, killer = null) {
  if (defender.ko) return { dealt: 0, ko: false };
  const dealt = Math.min(defender.hp, Math.max(0, amount));
  defender.hp -= dealt;
  if (defender.hp <= 0) {
    defender.hp = 0;
    koPersona(state, defender, killer);
    return { dealt, ko: true };
  }
  return { dealt, ko: false };
}

/**
 * Resolve a full attack: compute damage, apply it, handle weakness knockdown,
 * ailment rolls and skill/instakill specifics.
 *
 * @returns {{ amount:number, weak:boolean, resisted:boolean, ko:boolean,
 *             instakill:boolean, missed:boolean, ailment:string|null }}
 */
export function resolveAttack(state, { attacker, defender, power, damageType, category, effect = {}, consumeCharge = true }) {
  revealType(state, defender, damageType);

  // Instant-kill skills (Hama / Mudo family)
  if (effect.kind === 'instakill') {
    const { chance, affinity } = instakillChance({ defender, damageType, baseChance: effect.chance });
    const [hit, rng] = rollChance(state.rng, chance);
    state.rng = rng;
    if (!hit) {
      pushLog(state, `${nameOf(attacker)}'s instant kill missed ${nameOf(defender)}.`, 'attack');
      return { amount: 0, weak: false, resisted: affinity === 'resist', ko: false, instakill: true, missed: true, ailment: null };
    }
    pushLog(state, `${nameOf(defender)} was struck down instantly!`, 'attack');
    koPersona(state, defender, attacker);
    return {
      amount: 0,
      weak: affinity === 'weak',
      resisted: false,
      ko: true,
      instakill: true,
      missed: false,
      ailment: null,
    };
  }

  const result = computeDamage({ attacker, defender, power, damageType, category });

  // A multi-target effect resolves per target, so it opts out of consuming the
  // charge here and strips it once for the whole attack instead.
  if (result.chargeUsed && consumeCharge) {
    attacker.charges = attacker.charges.filter((c) => c !== result.chargeUsed);
  }

  const { dealt, ko } = applyDamage(state, defender, result.amount, attacker);

  let text = `${nameOf(defender)} took ${dealt} damage`;
  if (result.weak) text += ' — Weakness!';
  else if (result.resisted) text += ' — Resisted.';
  else text += '.';
  pushLog(state, text, 'attack');

  // Weakness knocks the target down (guarding prevents it).
  let knockedDown = false;
  if (result.weak && !ko) {
    if (defender.guarding) {
      pushLog(state, `${nameOf(defender)} guarded and stayed on its feet.`, 'attack');
    } else if (!defender.knockedDown) {
      defender.knockedDown = true;
      knockedDown = true;
      pushLog(state, `${nameOf(defender)} is knocked down!`, 'knockdown');
    }
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
    instakill: false,
    missed: false,
    ailment,
    chargeUsed: result.chargeUsed,
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

  if (killer && !killer.ko && killer.owner !== persona.owner) {
    const levels = persona.level >= killer.level + CONFIG.LEVEL_UP_GAP ? 2 : 1;
    levelUp(state, killer, levels);
  }

  if (owner.activeUid === persona.uid) {
    owner.activeUid = null;
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
  }

  if (player.fatigue > 0) {
    const damage = CONFIG.FATIGUE_DAMAGE * player.fatigue;
    pushLog(state, `Fatigue x${player.fatigue} bites — ${damage} damage to all of ${player.name}'s Personas.`, 'fatigue');
    for (const persona of livingField(state, playerId)) {
      applyDamage(state, persona, damage, null);
    }
  }

  for (const persona of livingField(state, playerId)) {
    restoreSpQuietly(persona, CONFIG.SP_REGEN_PER_TURN);
  }

  drawCards(state, playerId, CONFIG.DRAW_PER_TURN);
  return state;
}

function restoreSpQuietly(persona, amount) {
  persona.sp = Math.min(persona.maxSp, persona.sp + amount);
}

/** End-of-turn upkeep for the player who just acted (before passing the turn). */
export function runEndOfTurn(state, playerId) {
  const player = state.players[playerId];

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
