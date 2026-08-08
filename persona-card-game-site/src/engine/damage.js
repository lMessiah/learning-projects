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
import { getPersona } from '../data/cards.js';
import { buffOf, hasAilment } from './state.js';

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
  const card = getPersona(persona.cardId);
  if (card.weaknesses.includes(damageType)) return 'weak';
  if (card.resists.includes(damageType)) return 'resist';
  return 'neutral';
}

/**
 * Compute a damage result. Pure — reads Personas, mutates nothing.
 *
 * @returns {{ amount:number, affinity:string, weak:boolean, resisted:boolean,
 *             critMultiplier:number, chargeUsed:string|null, breakdown:object }}
 */
export function computeDamage({ attacker, defender, power, damageType, category, ignoreGuard = false }) {
  const cat = category || skillCategory(damageType);
  const atkStat = Math.max(1, attackStatOf(attacker, cat));
  const defStat = Math.max(0, defender.endurance);

  const base = (power * atkStat) / (atkStat + defStat);

  const affinity = affinityOf(defender, damageType);
  const affinityMult = affinity === 'weak' ? CONFIG.WEAK_MULT : affinity === 'resist' ? CONFIG.RESIST_MULT : 1;

  const atkBuff = buffOf(attacker, 'atk');
  const attackMult = !atkBuff ? 1 : atkBuff.direction === 'up' ? CONFIG.BUFF_MULT : 1 / CONFIG.BUFF_MULT;

  const defBuff = buffOf(defender, 'def');
  const defenseMult = !defBuff ? 1 : defBuff.direction === 'up' ? 1 / CONFIG.BUFF_MULT : CONFIG.BUFF_MULT;

  const guardMult = defender.guarding && !ignoreGuard ? CONFIG.GUARD_MULT : 1;
  const shockMult = hasAilment(defender, 'shock') ? CONFIG.SHOCK_TAKEN_MULT : 1;

  // Concentrate boosts magic, Charge boosts physical. Only one applies.
  const wantedCharge = cat === 'phys' ? 'charge' : 'concentrate';
  const chargeUsed = attacker.charges.includes(wantedCharge) ? wantedCharge : null;
  const chargeMult = chargeUsed ? CONFIG.CHARGE_MULT : 1;

  const raw = base * affinityMult * attackMult * defenseMult * guardMult * shockMult * chargeMult;
  const amount = Math.max(0, Math.round(raw));

  return {
    amount,
    affinity,
    weak: affinity === 'weak',
    resisted: affinity === 'resist',
    chargeUsed,
    breakdown: { base, affinityMult, attackMult, defenseMult, guardMult, shockMult, chargeMult },
  };
}

/**
 * Instant-kill chance (Hama / Mudo), adjusted by affinity and guarding.
 * DESIGN NOTE: instakills aren't damage, so weakness doubles the chance rather
 * than the damage, resist halves it, and guarding halves it too.
 */
export function instakillChance({ defender, damageType, baseChance }) {
  const affinity = affinityOf(defender, damageType);
  let chance = baseChance;
  if (affinity === 'weak') chance *= 2;
  if (affinity === 'resist') chance *= 0.5;
  if (defender.guarding) chance *= 0.5;
  return { chance: Math.max(0, Math.min(1, chance)), affinity };
}
