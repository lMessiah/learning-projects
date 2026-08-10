/**
 * @vitest-environment jsdom
 *
 * The selection & highlight system.
 *
 * Two halves. The first reads styles/select.css and themes.css directly and
 * asserts the *contract*: one file owns every state, nothing paints with a
 * border width, and each theme's two selection hues are distinct and actually
 * contrast against that theme's panel colour. The second drives the real
 * screens and checks the classes land where a player would expect them.
 *
 * jsdom applies no stylesheets, so the visual half has to be asserted against
 * the CSS source. That is a feature here: the bug this file exists to prevent
 * was `card--selected` being emitted by cardView.js and styled nowhere at all,
 * which no amount of DOM inspection would ever have caught.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderCard } from '../src/ui/cardView.js';
import { resetSettings } from '../src/ui/settings.js';

const read = (file) => readFileSync(resolve(process.cwd(), file), 'utf8');
const select = read('src/styles/select.css');
const themes = read('src/styles/themes.css');
const board = read('src/styles/board.css');
const cards = read('src/styles/cards.css');
const main = read('src/main.js');

/* ------------------------------------------------------------------ *
 * Contrast maths — WCAG relative luminance.
 * ------------------------------------------------------------------ */

function luminance(hex) {
  const n = hex.replace('#', '');
  const channels = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Hue in degrees, for telling two equally-bright rings apart. */
function hue(hex) {
  const n = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

const hueGap = (a, b) => {
  const raw = Math.abs(hue(a) - hue(b));
  return Math.min(raw, 360 - raw);
};

/** Pull `--token: value;` out of a `.theme-xx { ... }` block. */
function themeToken(theme, token) {
  const block = themes.match(new RegExp(`\\.theme-${theme}\\s*\\{([^}]*)\\}`, 's'));
  const found = block?.[1].match(new RegExp(`${token}:\\s*([^;]+);`));
  return found?.[1].trim() ?? null;
}

const THEMES = ['p3', 'p4', 'p5'];

/* ------------------------------------------------------------------ *
 * The contract
 * ------------------------------------------------------------------ */

describe('one system, in one file', () => {
  it('is loaded last so it wins over the component sheets', () => {
    const order = ['base.css', 'cards.css', 'themes.css', 'board.css', 'select.css']
      .map((file) => main.indexOf(file))
      .filter((i) => i >= 0);
    expect(order).toHaveLength(5);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(main).toMatch(/styles\/select\.css/);
  });

  it('defines all four states', () => {
    // hoverable
    expect(select).toMatch(/\.card--clickable:hover/);
    // selected
    expect(select).toMatch(/\.card--selected[^{]*\{[^}]*box-shadow[^}]*var\(--sel-on\)/s);
    // valid target
    expect(select).toMatch(/\.card--targetable[^{]*\{[^}]*animation: select-pulse/s);
    expect(select).toMatch(/@keyframes select-pulse/);
    // invalid
    expect(select).toMatch(/\.card--disabled[^{]*\{[^}]*opacity/s);
  });

  it('covers every selectable thing in the game', () => {
    for (const selector of [
      '.card--selected', // discard picker, starter pick
      '.card--targetable',
      '.card--disabled',
      '.card--discarding', // Providence
      '.tile--targetable', // board targeting
      '.tile--dimmed',
      '.hand-tile--disabled',
      '.setup-card--on', // deck / archetype / difficulty
      '.setting-card--on', // settings
      '.btn--on', // Gallows eater
      '.fusion-recipe--ready',
      '.fusion-recipe--blocked',
    ]) {
      expect(select, `${selector} is not part of the system`).toContain(selector);
    }
  });

  it('never paints a state with a border width, which would move the layout', () => {
    // `border-color` is fine — it cannot resize a box. `border` / `border-width`
    // in a state rule would shove every neighbouring card sideways.
    expect(select).not.toMatch(/border-width\s*:/);
    expect(select).not.toMatch(/border\s*:\s*\d/);
    // Nor may a state change padding or size.
    expect(select).not.toMatch(/^\s*(padding|margin|width|height)\s*:/m);
  });

  it('leaves no competing highlight behind in the component sheets', () => {
    // These used to each invent their own ring; the system owns them now.
    expect(board).not.toMatch(/@keyframes target-pulse/);
    expect(board).not.toMatch(/\.setting-card--on\s*\{/);
    expect(board).not.toMatch(/\.card--discarding\s*\{/);
    expect(board).not.toMatch(/\.fusion-recipe--blocked\s*\{/);
    // Card states that were emitted but styled nowhere now exist.
    expect(cards).toMatch(/\.card--ko\b/);
  });

  it('keeps the highlight when animations are off, and only drops the movement', () => {
    expect(select).toMatch(/\.board-screen--no-anim \.tile--targetable[^}]*animation: none/s);
    expect(select).toMatch(/prefers-reduced-motion: reduce/);
    // ...and still paints a ring in that branch rather than nothing.
    const off = select.match(/@media \(prefers-reduced-motion: reduce\) \{(.*?)\n\}/s)[1];
    expect(off).toMatch(/box-shadow[^;]*var\(--sel-target\)/);
  });

  it('does not divide by an --anim-scale that is missing off the board', () => {
    // The setup and settings screens are not inside `.board-screen`, so the
    // variable is simply not there — every use needs a fallback.
    for (const use of select.match(/var\(--anim-scale[^)]*\)/g) ?? []) {
      expect(use, `${use} has no fallback`).toMatch(/,\s*1\)/);
    }
  });
});

describe('the themed colours', () => {
  it('gives every theme its own selected and target hue', () => {
    for (const theme of THEMES) {
      expect(themeToken(theme, '--sel-on'), `${theme} --sel-on`).toMatch(/^#[0-9a-f]{6}$/i);
      expect(themeToken(theme, '--sel-target'), `${theme} --sel-target`).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('never lets "chosen" and "you may choose this" be the same colour', () => {
    for (const theme of THEMES) {
      const on = themeToken(theme, '--sel-on');
      const target = themeToken(theme, '--sel-target');
      expect(on, theme).not.toBe(target);
      // Tellable apart by hue OR by brightness — either is enough on its own.
      // P4 goes yellow vs cyan (hue); P5 goes red vs gold (brightness).
      const apart = hueGap(on, target) >= 60 || contrast(on, target) >= 2.5;
      expect(apart, `${theme}: ${on} and ${target} look alike`).toBe(true);
    }
  });

  it('is clearly visible against every theme background', () => {
    for (const theme of THEMES) {
      for (const ground of ['--panel', '--bg']) {
        const bg = themeToken(theme, ground);
        for (const token of ['--sel-on', '--sel-target']) {
          const ratio = contrast(themeToken(theme, token), bg);
          // 3:1 is the WCAG floor for a non-text UI indicator.
          expect(ratio, `${theme} ${token} on ${ground} is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(3);
        }
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * The screens
 * ------------------------------------------------------------------ */

describe('cardView emits the state classes', () => {
  it('marks selected, targetable and disabled on a Persona card', () => {
    const persona = { id: 'x', type: 'persona', name: 'X', arcana: 'Fool', level: 5, hp: 10, sp: 10,
      strength: 1, magic: 1, endurance: 1, weaknesses: [], resists: [], skills: [],
      statGrowth: { strength: 1, magic: 1, endurance: 1, hp: 1, sp: 1 } };
    expect(renderCard(persona, { selected: true }).className).toContain('card--selected');
    expect(renderCard(persona, { targetable: true }).className).toContain('card--targetable');
    // This one was accepted by support cards only, so a Persona picker could
    // never dim an option it was refusing.
    expect(renderCard(persona, { disabled: true }).className).toContain('card--disabled');
  });
});

describe('the screens that pick things', () => {
  let root;
  let mount;

  beforeEach(async () => {
    vi.useRealTimers();
    resetSettings();
    document.body.innerHTML = '';
    root = document.createElement('div');
    document.body.appendChild(root);
    ({ mountBoard: mount } = await import('../src/ui/game/board.js'));
  });

  afterEach(() => {
    document.body.innerHTML = '';
    resetSettings();
  });

  const $$ = (sel) => [...document.querySelectorAll(sel)];

  it('pulses all three starter options, then marks the one you took', async () => {
    const { createMatch } = await import('../src/engine/index.js');
    const { createController } = await import('../src/ui/game/controller.js');

    const state = createMatch({
      seed: 7,
      players: [
        { name: 'You', deckId: 'p5', controller: 'human' },
        { name: 'Bot', deckId: 'p3', controller: 'bot', difficulty: 'medium' },
      ],
    });
    const controller = createController({ state, botPlayer: 1, difficulty: 'medium', botSeed: 8 });
    mount(root, { controller, viewer: 0, onExit: () => {} });

    const before = $$('.starter-select__row .card');
    expect(before).toHaveLength(3);
    expect(before.every((c) => c.classList.contains('card--targetable'))).toBe(true);
    expect(before.some((c) => c.classList.contains('card--selected'))).toBe(false);

    const takenId = before[1].dataset.cardId;
    before[1].click();

    const after = $$('.starter-select__row .card');
    const selected = after.filter((c) => c.classList.contains('card--selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0].dataset.cardId).toBe(takenId);
    // The two you passed on are dimmed, and nothing is still pulsing.
    expect(after.filter((c) => c.classList.contains('card--disabled'))).toHaveLength(2);
    expect(after.some((c) => c.classList.contains('card--targetable'))).toBe(false);
  });
});
