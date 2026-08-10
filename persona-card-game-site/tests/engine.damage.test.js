import { describe, it, expect } from 'vitest';
import { computeDamage, executeMultiplier, affinityOf, CONFIG } from '../src/engine/index.js';
import { SKILLS } from '../src/data/cards.js';
import { fakePersona } from './helpers.js';

// Jack Frost: weak to fire, resists ice. Used as the defender throughout.
const defender = () => fakePersona('jack-frost', { endurance: 10 });
const attacker = () => fakePersona('pixie', { magic: 10, strength: 10 });

describe('damage formula', () => {
  it('uses the diminishing ratio power x atk / (atk + end)', () => {
    // 40 * 10 / (10 + 10) = 20
    expect(computeDamage({ attacker: attacker(), defender: defender(), power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(20);
  });

  it('never divides damage to zero as endurance climbs', () => {
    const tank = fakePersona('jack-frost', { endurance: 200 });
    const result = computeDamage({ attacker: attacker(), defender: tank, power: 40, damageType: 'elec', category: 'magic' });
    expect(result.amount).toBeGreaterThan(0);
    expect(result.amount).toBeLessThan(5);
  });

  it('uses magic for magic skills and strength for physical ones', () => {
    const mage = fakePersona('pixie', { magic: 30, strength: 5 });
    const magic = computeDamage({ attacker: mage, defender: defender(), power: 40, damageType: 'elec', category: 'magic' });
    const phys = computeDamage({ attacker: mage, defender: defender(), power: 40, damageType: 'phys', category: 'phys' });
    expect(magic.amount).toBeGreaterThan(phys.amount);
    expect(magic.amount).toBe(30); // 40 * 30 / 40
    expect(phys.amount).toBe(13); // 40 * 5 / 15 = 13.33
  });
});

describe('weakness and resistance', () => {
  it('doubles damage on a weakness', () => {
    const result = computeDamage({ attacker: attacker(), defender: defender(), power: 40, damageType: 'fire', category: 'magic' });
    expect(result.weak).toBe(true);
    expect(result.amount).toBe(40); // 20 * 2
  });

  it('halves damage on a resist', () => {
    const result = computeDamage({ attacker: attacker(), defender: defender(), power: 40, damageType: 'ice', category: 'magic' });
    expect(result.resisted).toBe(true);
    expect(result.amount).toBe(10); // 20 * 0.5
  });

  it('treats almighty as neither weak nor resisted, ever', () => {
    for (const cardId of ['jack-frost', 'pixie', 'thanatos']) {
      expect(affinityOf(fakePersona(cardId), 'almighty')).toBe('neutral');
    }
    const result = computeDamage({ attacker: attacker(), defender: defender(), power: 40, damageType: 'almighty', category: 'magic' });
    expect(result.amount).toBe(20);
  });

  it('reports neutral for a type the Persona has no affinity to', () => {
    expect(affinityOf(defender(), 'wind')).toBe('neutral');
  });
});

describe('multipliers', () => {
  const base = 20;

  it('halves damage against a guarding target', () => {
    const guard = defender();
    guard.guarding = true;
    expect(computeDamage({ attacker: attacker(), defender: guard, power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(base * CONFIG.GUARD_MULT);
  });

  it('applies x1.4 for an attack buff and /1.4 for an attack debuff', () => {
    const buffed = attacker();
    buffed.buffs = [{ stat: 'atk', direction: 'up', turnsLeft: 3 }];
    expect(computeDamage({ attacker: buffed, defender: defender(), power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(28); // 20 * 1.4

    const debuffed = attacker();
    debuffed.buffs = [{ stat: 'atk', direction: 'down', turnsLeft: 3 }];
    expect(computeDamage({ attacker: debuffed, defender: defender(), power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(14); // 20 / 1.4
  });

  it('applies /1.4 for a defense buff and x1.4 for a defense debuff', () => {
    const tanky = defender();
    tanky.buffs = [{ stat: 'def', direction: 'up', turnsLeft: 3 }];
    expect(computeDamage({ attacker: attacker(), defender: tanky, power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(14);

    const soft = defender();
    soft.buffs = [{ stat: 'def', direction: 'down', turnsLeft: 3 }];
    expect(computeDamage({ attacker: attacker(), defender: soft, power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(28);
  });

  it('applies x2.5 for Concentrate on magic and Charge on physical', () => {
    const concentrating = attacker();
    concentrating.charges = ['concentrate'];
    const magic = computeDamage({ attacker: concentrating, defender: defender(), power: 40, damageType: 'elec', category: 'magic' });
    expect(magic.amount).toBe(50);
    expect(magic.chargeUsed).toBe('concentrate');

    // Concentrate does nothing for a physical hit.
    const phys = computeDamage({ attacker: concentrating, defender: defender(), power: 40, damageType: 'phys', category: 'phys' });
    expect(phys.chargeUsed).toBe(null);

    const charged = attacker();
    charged.charges = ['charge'];
    expect(computeDamage({ attacker: charged, defender: defender(), power: 40, damageType: 'phys', category: 'phys' }).chargeUsed).toBe('charge');
  });

  it('increases damage taken by 50% while shocked', () => {
    const shocked = defender();
    shocked.ailments = [{ type: 'shock', turnsLeft: 1 }];
    expect(computeDamage({ attacker: attacker(), defender: shocked, power: 40, damageType: 'elec', category: 'magic' }).amount).toBe(30);
  });

  it('stacks multipliers together', () => {
    // weakness x2, attack buff x1.4, defense debuff x1.4, guard x0.5
    const atk = attacker();
    atk.buffs = [{ stat: 'atk', direction: 'up', turnsLeft: 3 }];
    const def = defender();
    def.buffs = [{ stat: 'def', direction: 'down', turnsLeft: 3 }];
    def.guarding = true;
    const result = computeDamage({ attacker: atk, defender: def, power: 40, damageType: 'fire', category: 'magic' });
    expect(result.amount).toBe(Math.round(20 * 2 * 1.4 * 1.4 * 0.5)); // 39
  });
});

describe('execute riders', () => {
  const KNOCKDOWN = { when: 'knockedDown' };
  const LOW_HP = { when: 'lowHp', threshold: 0.4 };

  it('is inert without a rider', () => {
    expect(executeMultiplier(fakePersona('angel', { knockedDown: true }), undefined)).toBe(1);
    expect(executeMultiplier(fakePersona('angel'), null)).toBe(1);
  });

  it('pays out against a knocked-down target and nothing else', () => {
    expect(executeMultiplier(fakePersona('angel'), KNOCKDOWN)).toBe(1);
    expect(executeMultiplier(fakePersona('angel', { knockedDown: true }), KNOCKDOWN)).toBe(CONFIG.EXECUTE_MULT);
  });

  it('pays out strictly below the HP threshold', () => {
    const angel = fakePersona('angel');
    const at = (hp) => executeMultiplier({ ...angel, hp, maxHp: 100 }, LOW_HP);
    expect(at(41)).toBe(1);
    expect(at(40)).toBe(1); // exactly 40% is not below it
    expect(at(39)).toBe(CONFIG.EXECUTE_MULT);
    expect(at(1)).toBe(CONFIG.EXECUTE_MULT);
  });

  it('leaves the two conditions independent', () => {
    // A knocked-down but healthy target is nothing to Mudo, and a dying but
    // standing one is nothing to Hama.
    const downed = fakePersona('angel', { knockedDown: true, hp: 100, maxHp: 100 });
    const dying = fakePersona('angel', { hp: 5, maxHp: 100 });
    expect(executeMultiplier(downed, LOW_HP)).toBe(1);
    expect(executeMultiplier(dying, KNOCKDOWN)).toBe(1);
  });

  it('leaves no skill in the database with a random chance to KO', () => {
    for (const [id, skill] of Object.entries(SKILLS)) {
      expect(skill.effect.kind, `${id} is still an instakill`).not.toBe('instakill');
      expect(skill.effect.chance, `${id} still carries a bare chance roll`).toBeUndefined();
    }
  });

  it('prints the odds of every ailment rider on the card', () => {
    for (const [id, skill] of Object.entries(SKILLS)) {
      if (!skill.effect.ailmentChance) continue;
      const printed = `${Math.round(skill.effect.ailmentChance * 100)}%`;
      expect(skill.description, `${id} does not state its ailment chance`).toContain(printed);
    }
  });
});
