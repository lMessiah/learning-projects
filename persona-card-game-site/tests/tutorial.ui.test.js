/**
 * @vitest-environment jsdom
 *
 * The How to Play screens, driven with a mouse.
 *
 * `tutorial.test.js` proves the lessons are *true and completable*. This proves
 * they are *reachable*: that the menu box goes somewhere, that the picker lists
 * five lessons, that clicking one mounts a real board with a coach on it, that
 * Next moves the coach along, and that an objective finishes itself when the
 * board satisfies it rather than needing a button.
 *
 * Also covers the new bot playstyle row, for the same reason — a playstyle you
 * cannot select is not a feature.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderMenu } from '../src/ui/menu.js';
import { renderHowTo } from '../src/ui/tutorial/index.js';
import { renderBotSetup } from '../src/ui/game/setup.js';
import { LESSONS } from '../src/ui/tutorial/lessons.js';
import { PLAYSTYLES } from '../src/engine/playstyles.js';

let root;

beforeEach(() => {
  document.body.innerHTML = '';
  document.body.className = '';
  window.location.hash = '';
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  // The tutorial route mounts a live controller; leaving the route tears it
  // down. Without this a lesson's bot keeps stepping into later tests.
  renderHowTo(root, {});
  document.body.innerHTML = '';
  document.body.className = '';
});

const text = (node) => node.textContent ?? '';
const coach = () => document.querySelector('.coach');

describe('getting to the lessons', () => {
  it('puts How to Play on the main menu, first', () => {
    renderMenu(root);
    const boxes = [...root.querySelectorAll('.menu__box')];
    expect(boxes.length).toBeGreaterThan(0);
    expect(text(boxes[0])).toContain('How to Play');
  });

  it('routes the menu box to the picker', () => {
    renderMenu(root);
    const box = [...root.querySelectorAll('.menu__box')].find((b) => text(b).includes('How to Play'));
    box.click();
    expect(window.location.hash).toBe('#/howto');
  });

  it('lists every lesson, all of them pressable', () => {
    renderHowTo(root, {});
    const cards = [...root.querySelectorAll('.lesson-card')];
    expect(cards).toHaveLength(LESSONS.length);
    for (const [i, card] of cards.entries()) {
      expect(card.disabled, `${LESSONS[i].id} is not pressable`).toBe(false);
      expect(text(card)).toContain(LESSONS[i].title);
      expect(card.dataset.lesson).toBe(LESSONS[i].id);
    }
  });

  it('routes a lesson card to that lesson', () => {
    renderHowTo(root, {});
    root.querySelector('.lesson-card[data-lesson="velvet"]').click();
    expect(window.location.hash).toBe('#/howto/velvet');
  });
});

describe('a lesson battle', () => {
  it('mounts a real board with a coach on it', () => {
    renderHowTo(root, { lessonId: 'basics' });
    expect(root.querySelector('.board-screen'), 'no board').toBeTruthy();
    expect(coach(), 'no coach').toBeTruthy();
    expect(document.querySelector('.action-bar'), 'no action bar').toBeTruthy();
  });

  it('shrinks the board for the coach rather than covering it', () => {
    renderHowTo(root, { lessonId: 'basics' });
    expect(document.body.classList.contains('coach-active')).toBe(true);
  });

  it('opens on step 1 and says so', () => {
    renderHowTo(root, { lessonId: 'basics' });
    expect(text(coach())).toContain('step 1 of');
    expect(text(coach())).toContain(LESSONS[0].steps[0].title);
  });

  it('advances a say-step on Next', () => {
    renderHowTo(root, { lessonId: 'basics' });
    const next = [...coach().querySelectorAll('button')].find((b) => text(b).startsWith('Next'));
    expect(next).toBeTruthy();
    next.click();
    expect(text(coach())).toContain('step 2 of');
  });

  it('shows an objective with no Next button, but always an escape hatch', () => {
    renderHowTo(root, { lessonId: 'basics' });
    // Step 2 of First Blood is the first objective.
    [...coach().querySelectorAll('button')].find((b) => text(b).startsWith('Next')).click();

    expect(coach().classList.contains('coach--objective')).toBe(true);
    expect(coach().querySelector('.coach__objective')).toBeTruthy();
    const buttons = [...coach().querySelectorAll('button')].map(text);
    expect(buttons.some((t) => t.startsWith('Next'))).toBe(false);
    // A player who wanders somewhere the objective can no longer be met from
    // must never be trapped in the lesson.
    expect(buttons.some((t) => t.includes('Skip'))).toBe(true);
  });

  it('rings the control the step is pointing at', () => {
    renderHowTo(root, { lessonId: 'basics' });
    [...coach().querySelectorAll('button')].find((b) => text(b).startsWith('Next')).click();
    // The ring lands on a rAF after the board finishes re-rendering; drive it
    // directly rather than sleeping.
    const target = document.querySelector('.hand-tile[data-card-id="pixie"]');
    expect(target, 'the card the step points at is not on the board').toBeTruthy();
  });

  it('finishes an objective by PLAYING, with no button involved', () => {
    renderHowTo(root, { lessonId: 'basics' });
    [...coach().querySelectorAll('button')].find((b) => text(b).startsWith('Next')).click();
    expect(text(coach())).toContain('step 2 of');

    // Play the Pixie the step asks for, by the same two clicks a player makes:
    // the hand tile opens the card, and the card carries the play button.
    const pixie = document.querySelector('.hand-tile[data-card-id="pixie"]');
    expect(pixie).toBeTruthy();
    pixie.click();

    const play = [...document.querySelectorAll('button')].find((b) => text(b) === 'Play to the field');
    expect(play, 'the card detail did not offer a way to play it').toBeTruthy();
    play.click();

    expect(text(coach()), 'the objective did not notice the board changing').toContain('step 3 of');
  });

  it('leaves the lesson when the coach is closed, and cleans up after itself', () => {
    renderHowTo(root, { lessonId: 'basics' });
    coach().querySelector('.coach__quit').click();
    expect(window.location.hash).toBe('#/howto');

    // Re-entering the route is what the router does next; nothing should linger.
    renderHowTo(root, {});
    expect(document.querySelector('.coach')).toBe(null);
    expect(document.body.classList.contains('coach-active')).toBe(false);
    expect(document.querySelectorAll('.coach-point')).toHaveLength(0);
  });

  it('sends an unknown lesson id back to the picker instead of erroring', () => {
    expect(() => renderHowTo(root, { lessonId: 'not-a-lesson' })).not.toThrow();
    expect(window.location.hash).toBe('#/howto');
  });

  it('mounts every lesson without throwing', () => {
    for (const lesson of LESSONS) {
      expect(() => renderHowTo(root, { lessonId: lesson.id }), lesson.id).not.toThrow();
      expect(coach(), lesson.id).toBeTruthy();
      expect(root.querySelector('.board-screen'), lesson.id).toBeTruthy();
    }
  });
});

describe('the bot playstyle row', () => {
  it('offers every playstyle, with Normal selected by default', () => {
    renderBotSetup(root, { onStart: () => {}, onExit: () => {} });
    const cards = [...root.querySelectorAll('.setup-card--playstyle')];
    expect(cards).toHaveLength(PLAYSTYLES.length);
    expect(cards.map((c) => c.dataset.playstyle)).toEqual(PLAYSTYLES.map((p) => p.id));

    const on = cards.filter((c) => c.classList.contains('setup-card--on'));
    expect(on).toHaveLength(1);
    expect(on[0].dataset.playstyle).toBe('normal');
  });

  it('passes the chosen playstyle to the match', () => {
    let started = null;
    renderBotSetup(root, { onStart: (choice) => { started = choice; }, onExit: () => {} });

    root.querySelector('.setup-card--playstyle[data-playstyle="combo"]').click();
    [...root.querySelectorAll('button')].find((b) => text(b) === 'Start match').click();

    expect(started.playstyle).toBe('combo');
  });

  it('keeps the selection to one, and moves it when you change your mind', () => {
    renderBotSetup(root, { onStart: () => {}, onExit: () => {} });
    const cards = [...root.querySelectorAll('.setup-card--playstyle')];

    root.querySelector('[data-playstyle="defensive"]').click();
    root.querySelector('[data-playstyle="random"]').click();

    const on = cards.filter((c) => c.classList.contains('setup-card--on'));
    expect(on).toHaveLength(1);
    expect(on[0].dataset.playstyle).toBe('random');
  });

  it('does not call two different things a "play style" on one screen', () => {
    // The deck archetype row and the bot playstyle row are different axes and
    // sat under near-identical headings before this patch.
    renderBotSetup(root, { onStart: () => {}, onExit: () => {} });
    const headings = [...root.querySelectorAll('.setup__heading')].map(text);
    const ambiguous = headings.filter((h) => /play\s*style/i.test(h));
    expect(ambiguous).toHaveLength(2);
    expect(new Set(ambiguous).size, `ambiguous headings: ${ambiguous.join(' / ')}`).toBe(2);
    expect(ambiguous.some((h) => /your deck/i.test(h))).toBe(true);
    expect(ambiguous.some((h) => /bot/i.test(h))).toBe(true);
  });
});
