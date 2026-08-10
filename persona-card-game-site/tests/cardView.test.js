/**
 * @vitest-environment jsdom
 *
 * Smoke tests for the placeholder-art card renderer: every card in the database
 * must render without throwing, and hidden-affinity masking must actually mask.
 */
import { describe, it, expect } from 'vitest';
import { ALL_CARDS, getCard } from '../src/data/cards.js';
import { renderCard } from '../src/ui/cardView.js';

describe('card renderer', () => {
  it('renders every card in the database', () => {
    for (const card of ALL_CARDS) {
      const node = renderCard(card, { showAllHidden: true });
      expect(node.querySelector('.card__name').textContent).toBe(card.name);
    }
  });

  it('shows printed stats and skills on a Persona card', () => {
    const node = renderCard(getCard('jack-frost'), { showAllHidden: true });
    expect(node.querySelector('.card__level').textContent).toBe('Lv 6');
    expect(node.querySelectorAll('.skill')).toHaveLength(5);
    // Bufula unlocks at 13, so it is locked on a level 6 card.
    expect(node.querySelectorAll('.skill--locked').length).toBeGreaterThan(0);
    expect(node.textContent).toContain('Fire');
  });

  it('masks unrevealed weaknesses as "?"', () => {
    const hidden = renderCard(getCard('jack-frost'), { revealed: [] });
    const weakChips = hidden.querySelectorAll('.affinity--weak .chip');
    expect([...weakChips].every((c) => c.textContent === '?')).toBe(true);

    const revealed = renderCard(getCard('jack-frost'), { revealed: ['fire'] });
    expect(revealed.querySelector('.affinity--weak .chip').textContent).toContain('Fire');
  });

  it('renders live instance values over printed ones', () => {
    const node = renderCard(getCard('pixie'), {
      showAllHidden: true,
      instance: { level: 9, hp: 12, maxHp: 58, sp: 4, maxSp: 30, strength: 4, magic: 14, endurance: 10 },
    });
    expect(node.querySelector('.card__level').textContent).toBe('Lv 9');
    expect(node.querySelector('.bar--hp .bar__value').textContent).toBe('12/58');
    // Media unlocks at 6, so it is available at level 9.
    const media = [...node.querySelectorAll('.skill')].find((n) => n.textContent.includes('Media'));
    expect(media.classList.contains('skill--locked')).toBe(false);
  });

  it('labels whether an Item/Special uses up your action', () => {
    expect(renderCard(getCard('medicine'), {}).textContent).toContain("Doesn't use your action");
    expect(renderCard(getCard('theurgy'), {}).textContent).toContain('Uses up your action');
  });
});

describe('the gallery', () => {
  it('renders the whole reference view, pools and all', async () => {
    const { renderGallery } = await import('../src/ui/gallery.js');
    const root = document.createElement('div');
    renderGallery(root);

    // No validation errors, and the deck pools rendered for every flavour.
    expect(root.querySelector('.notice--error')).toBe(null);
    expect(root.querySelector('.notice--ok')).toBeTruthy();
    expect(root.querySelectorAll('.ref-grid .ref-card').length).toBeGreaterThanOrEqual(3);
    // The play styles panel is there too.
    expect(root.textContent).toContain('Play styles');
  });

  it('prints the passive on the cards that have one', () => {
    const node = renderCard(getCard('pixie'), { showAllHidden: true });
    expect(node.querySelector('.card__passive-name').textContent).toBe('Trickster');
    expect(renderCard(getCard('silky'), { showAllHidden: true }).querySelector('.card__passive')).toBe(null);
  });
});
