import { describe, it, expect } from 'vitest';
import {
  PERSONAS,
  ITEMS,
  SPECIALS,
  DECKS,
  FUSION_RECIPES,
  STARTER_POOL,
  expandDeck,
  getCard,
  skillsAtLevel,
  validateDatabase,
} from '../src/data/cards.js';
import { CONFIG } from '../src/engine/config.js';

describe('card database', () => {
  it('passes structural validation', () => {
    expect(validateDatabase()).toEqual([]);
  });

  it('has the expected card counts', () => {
    expect(PERSONAS.length).toBeGreaterThanOrEqual(30);
    expect(ITEMS.length).toBeGreaterThanOrEqual(10);
    expect(SPECIALS.length).toBeGreaterThanOrEqual(8);
    // One recipe per fusion-only Persona: a mid-tier rung (levels 28-40) and a
    // high tier (46-64), so fusion is a ladder rather than one huge leap.
    expect(FUSION_RECIPES.length).toBe(PERSONAS.filter((p) => p.fusionOnly).length);
  });

  it('keeps every deck under the level cap, with the strong Personas fusion-only', () => {
    for (const deck of DECKS) {
      for (const entry of deck.cards) {
        const card = getCard(entry.id);
        if (card.type !== 'persona') continue;
        expect(card.fusionOnly).toBe(false);
        expect(card.level).toBeLessThanOrEqual(CONFIG.DECK_MAX_PERSONA_LEVEL);
      }
    }
  });

  it('makes every fusion-only Persona reachable through some recipe', () => {
    const results = new Set(FUSION_RECIPES.map((r) => r.result));
    for (const persona of PERSONAS.filter((p) => p.fusionOnly)) {
      expect(results.has(persona.id)).toBe(true);
    }
  });

  it('builds three 30-card decks', () => {
    expect(DECKS.map((d) => d.id).sort()).toEqual(['p3', 'p4', 'p5']);
    for (const deck of DECKS) {
      expect(expandDeck(deck.id)).toHaveLength(30);
    }
  });

  it('resolves skill references into full skill objects', () => {
    const pixie = getCard('pixie');
    const zio = pixie.skills.find((s) => s.name === 'Zio');
    expect(zio).toMatchObject({ type: 'elec', power: 38, spCost: 4, unlockLevel: 1 });
    expect(zio.description).toBeTruthy();
    expect(zio.effect.kind).toBe('damage');
  });

  it('gates skills behind unlock levels', () => {
    const pixie = getCard('pixie');
    expect(skillsAtLevel(pixie, 3).map((s) => s.name)).toEqual(['Dia', 'Zio']);
    expect(skillsAtLevel(pixie, 14).map((s) => s.name)).toContain('Zionga');
  });

  it('gives every fusion recipe a fusion-only result', () => {
    for (const recipe of FUSION_RECIPES) {
      expect(getCard(recipe.result).fusionOnly).toBe(true);
    }
  });

  it('offers only low-level starters', () => {
    for (const id of STARTER_POOL) {
      expect(getCard(id).level).toBeLessThanOrEqual(10);
    }
    expect(STARTER_POOL.length).toBeGreaterThanOrEqual(3);
  });

  it('never marks almighty as a weakness or resist', () => {
    for (const persona of PERSONAS) {
      expect(persona.weaknesses).not.toContain('almighty');
      expect(persona.resists).not.toContain('almighty');
    }
  });

  it('freezes card data against accidental mutation', () => {
    expect(Object.isFrozen(getCard('pixie'))).toBe(true);
  });
});
