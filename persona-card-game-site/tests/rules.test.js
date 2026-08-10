/**
 * @vitest-environment jsdom
 *
 * The Rules screen is the only place a player can find out how any of this
 * works, so it is treated as part of the feature rather than as documentation.
 * Every mechanic below is asserted to be explained, and every number it quotes
 * is asserted to come from the config rather than being typed out — otherwise
 * retuning a constant would quietly make the rules wrong.
 */
import { describe, it, expect } from 'vitest';
import { renderRulesContent } from '../src/ui/rules.js';
import { CONFIG, PASSIVE_LIST } from '../src/engine/index.js';
import { SPECIALS, SKILLS } from '../src/data/cards.js';

const rules = () => renderRulesContent().textContent;

describe('every mechanic is explained', () => {
  const topics = {
    'One More': /One More/,
    Technicals: /Technical/,
    'where ailments come from': /can inflict Burn/,
    'Lesser Theurgy': /Lesser Theurgy/,
    'no random knockouts': /random chance to knock a Persona out/,
    'the execute rider': /Hama/,
    Gallows: /Gallows/,
    'fusion being free': /no action/,
    'affinity rewrites': /rewrites/,
    'the Brutal counter': /Brutal/,
    drains: /Life Drain/,
    'Spirit Drain': /Spirit Drain/,
    'comeback mechanics': /Momentum Draw/,
    Traesto: /Traesto/,
    'the empty-field clock': /empty-field clock|empty field/i,
    'passive transfer': /Moving a passive/,
  };

  for (const [topic, pattern] of Object.entries(topics)) {
    it(`covers ${topic}`, () => {
      expect(rules()).toMatch(pattern);
    });
  }

  it('lists every passive, including the new ones', () => {
    const text = rules();
    for (const passive of PASSIVE_LIST) expect(text, passive.name).toContain(passive.name);
    expect(PASSIVE_LIST.map((p) => p.id)).toContain('endure');
  });

  it('names all three rewrite Specials', () => {
    const text = rules();
    for (const card of SPECIALS.filter((s) => s.effect.kind === 'rewriteAffinities')) {
      expect(text, card.name).toContain(card.name);
    }
  });
});

describe('the numbers come from the config', () => {
  it('quotes the tunables rather than hard-coding them', () => {
    const text = rules();
    const quoted = {
      'knockout target': `${CONFIG.KO_TARGET} of your opponent's Personas`,
      'SP regen': `${CONFIG.SP_REGEN_PER_TURN} SP`,
      'hand limit': `${CONFIG.HAND_LIMIT} cards`,
      'fusions per turn': `${CONFIG.FUSIONS_PER_TURN} fusion`,
      'technical multiplier': `×${CONFIG.TECHNICAL_MULT}`,
      'execute threshold': `${Math.round(CONFIG.EXECUTE_HP_THRESHOLD * 100)}% HP`,
      'gallows junk heal': `${Math.round(CONFIG.GALLOWS_JUNK_HEAL * 100)}% HP`,
      'farm gap': `${CONFIG.COMEBACK_FARM_GAP} levels`,
      'burn duration': `${CONFIG.BURN_DURATION} turns`,
    };
    for (const [what, value] of Object.entries(quoted)) {
      expect(text, `${what} is not quoted from the config`).toContain(value);
    }
  });

  it('prints the real ailment odds, matching the cards', () => {
    const text = rules();
    for (const id of ['agi', 'agidyne', 'ragnarok']) {
      const chance = `${Math.round(SKILLS[id].effect.ailmentChance * 100)}%`;
      expect(text, `${id} at ${chance}`).toContain(chance);
    }
  });
});

describe('the FAQ answers the questions the changes raise', () => {
  const questions = [
    /How do I actually land a Technical\?/,
    /Their weaknesses changed\. What happened\?/,
    /Does fusion still cost my turn\?/,
    /Why can't I summon my Persona\?/,
    /How does fusion work/,
  ];

  it('asks each of them', () => {
    const text = rules();
    for (const question of questions) expect(text).toMatch(question);
  });

  it('renders them as collapsible entries, not a wall of text', () => {
    const node = renderRulesContent();
    const faqs = node.querySelectorAll('details.faq');
    expect(faqs.length).toBeGreaterThanOrEqual(questions.length);
    for (const entry of faqs) expect(entry.querySelector('summary')).toBeTruthy();
  });
});
