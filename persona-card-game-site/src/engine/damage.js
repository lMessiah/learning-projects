/**
 * The damage formula, in one place.
 *
 *   base = power x attackerStat / (attackerStat + defenderEndurance)
 *
 * A diminishing-returns ratio: endurance never reduces damage to zero, and
 * stacking power has smooth falloff. Multipliers are applied to `base`, and the
 * result is rounded once at the very end.
 *
 * DESIGN NOTE: the spec writes `round(...)` before the multipliers. Rounding
 * once at the end avoids compounding rounding error (e.g. weakness x2 on a .5
 * value); the ordering of the multipliers themselves is unchanged.
 *
 * DESIGN NOTE: buff/debuff multipliers are applied to the resulting damage
 * rather than to the raw stat inside the ratio. Applying x1.4 inside the ratio
 * would be partly cancelled by the denominator, making Tarukaja far weaker than
 * the stated "x1.4".
 */
import { CONFIG, skillCategory } from './config.js';
import { buffOf, hasAilment, affinitiesOf } from './state.js';

/** Attack stat used by a damage category. */
export function attackStatOf(persona, category) {
  return category === 'phys' ? persona.strength : persona.magic;
}

/**
 * How a Persona reacts to a damage type.
 * @returns {'weak'|'resist'|'neutral'}
 */
export function affinityOf(persona, damageType) {
  if (damageType === 'almighty') return 'neutral'; // almighty is never weak/resisted
  const { weaknesses, resists } = affinitiesOf(persona);
  if (weaknesses.includes(damageType)) return 'weak';
  if (resists.includes(damageType)) return 'resist';
  return 'neutral';
}

/**
 * Compute a damage result. Pure — reads Personas, mutates nothing.
 *
 * @returns {{ amount:number, affinity:string, weak:boolean, resisted:boolean,
 *             critMultiplier:number, chargeUsed:string|null, breakdown:object }}
 */
export function computeDamage({
  attacker,
  defender,
  power,
  damageType,
  category,
  ignoreGuard = false,
  flat = false,
  passiveMult = 1,
  // The knockdown combo: +COMBO_DAMAGE_STEP per Persona this attacker's side has
  // put on its back so far this turn. A separate parameter rather than another
  // factor folded into passiveMult so it shows up in the breakdown on its own —
  // the board explains where a number came from, and "combo" is the part a
  // player is most likely to be surprised by.
  comboMult = 1,
  ignoreShockBonus = false,
}) {
  const cat = category || skillCategory(damageType);
  const atkStat = Math.max(1, attackStatOf(attacker, cat));
  const defStat = Math.max(0, defender.endurance);

  const affinity = affinityOf(defender, damageType);
  const affinityMult = affinity === 'weak' ? CONFIG.WEAK_MULT : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;

  // FLAT damage: a card that prints "deal 60 damage" deals 60, full stop —
  // modified only by weakness, resist and guard. Nothing else touches it, so
  // the number on the card is always the number the player can plan around.
  // That already excludes Dark Hour, Bloodlust and the execute rider, and the
  // knockdown combo is no different: it rides the pipeline, and a flat card is
  // not in the pipeline.
  if (flat) {
    const guardOnly = defender.guarding && !ignoreGuard ? CONFIG.GUARD_MULT : 1;
    const flatRaw = power * affinityMult * guardOnly;
    return {
      amount: Math.max(0, Math.round(flatRaw)),
      affinity,
      weak: affinity === 'weak',
      resisted: affinity === 'resist',
      chargeUsed: null,
      flat: true,
      breakdown: { base: power, affinityMult, guardMult: guardOnly },
    };
  }

  const base = (power * atkStat) / (atkStat + defStat);

  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;

  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;

  const guardMult = defender.guarding && !ignoreGuard ? CONFIG.GUARD_MULT : 1;
  // A Shock Technical supplies its own multiplier, so the plain Shock damage
  // bonus stands down rather than stacking on top of it.
  const shockMult = !ignoreShockBonus && hasAilment(defender, 'shock') ? CONFIG.SHOCK_TAKEN_MULT : 1;

  // Concentrate boosts magic, Charge boosts physical. Only one applies.
  const wantedCharge = cat === 'phys' ? 'charge' : 'concentrate';
  const chargeUsed = attacker.charges.includes(wantedCharge) ? wantedCharge : null;
  const chargeMult = chargeUsed ? CONFIG.CHARGE_MULT : 1;

  // Order reads as the rules read: stats, then buffs, then the combo the turn
  // has built up, then the defender's affinity and everything situational.
  // Multiplication is commutative, so this is documentation rather than
  // arithmetic — but it is the documentation the spec asks for.
  const raw =
    base * attackMult * defenseMult * comboMult * affinityMult * guardMult * shockMult * chargeMult * passiveMult;
  const amount = Math.max(0, Math.round(raw));

  return {
    amount,
    affinity,
    weak: affinity === 'weak',
    resisted: affinity === 'resist',
    chargeUsed,
    flat: false,
    breakdown: { base, affinityMult, attackMult, defenseMult, comboMult, guardMult, shockMult, chargeMult, passiveMult },
  };
}

/**
 * The power a percentage skill has against this defender, or null when the
 * skill has no percentage at all.
 *
 * DESIGN NOTE: a share of what is LEFT, not of the maximum. That makes Life
 * Drain an opener rather than a finisher — it hits hardest against a full-health
 * wall and can never itself reduce anything to zero — and it means a percentage
 * skill needs a partner to close, which is what the execute skills are for.
 */
export function percentPowerAgainst(effect, defender) {
  const share = effect?.percentOfTargetHp;
  if (!share || !defender) return null;
  return Math.max(1, Math.round(defender.hp * share));
}

/**
 * Which ailment on the defender this damage type combos with, or null.
 *
 * A Technical is the follow-up half of a two-part play: one action puts an
 * ailment on something, the next cashes it in. Both halves are visible on the
 * board, so it rewards reading rather than luck.
 *
 *   Burn  + physical or wind  — you fan the flames
 *   Shock + physical          — and it also puts them on the floor
 */
export function technicalFor(defender, damageType) {
  if (!defender || defender.ko) return null;
  if (hasAilment(defender, 'burn') && (damageType === 'phys' || damageType === 'wind')) return 'burn';
  if (hasAilment(defender, 'shock') && damageType === 'phys') return 'shock';
  return null;
}

/**
 * The execute rider, which replaced the old instant-kill roll.
 *
 * DESIGN NOTE: Hama and Mudo used to be a dice throw that either removed a
 * Persona outright or did nothing at all — the single least plannable thing in
 * the game. They are now ordinary Light and Dark damage skills that hit harder
 * against a target already in trouble: Hama finishes what a knockdown started,
 * Mudo finishes what everything else started. Both conditions are readable off
 * the board before you commit the action, which is the whole point.
 *
 * @returns {number} the multiplier, or 1 when the condition is not met
 */
export function executeMultiplier(defender, execute) {
  if (!execute || !defender) return 1;
  if (execute.when === 'knockedDown') {
    return defender.knockedDown ? execute.mult ?? CONFIG.EXECUTE_MULT : 1;
  }
  if (execute.when === 'lowHp') {
    const threshold = execute.threshold ?? CONFIG.EXECUTE_HP_THRESHOLD;
    const ratio = defender.maxHp > 0 ? defender.hp / defender.maxHp : 0;
    return ratio < threshold ? execute.mult ?? CONFIG.EXECUTE_MULT : 1;
  }
  return 1;
}
