/**
 * @vitest-environment jsdom
 *
 * An absolutely-positioned element anchors to its nearest POSITIONED ancestor,
 * never simply to its parent. That is how the Gallows badge ended up floating
 * in the corner of the screen: `.fusion-btn` was `position: relative` and
 * `.gallows-btn` was not, so the same badge markup escaped all the way up to
 * `.board-screen`.
 *
 * These tests hold the fix in place two ways: a structural one (every badge
 * carries its anchor class) and a stylesheet audit (every absolutely-positioned
 * rule on a rendered board must have an ancestor that declares an anchor).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import { setupMatch, setField, setHand } from './helpers.js';

const STYLES = ['base.css', 'board.css', 'cards.css', 'select.css'];
const cssText = (name) => readFileSync(resolve(process.cwd(), 'src/styles', name), 'utf8');

let root;
let unmount;
let controller;

function boot(prepare, { viewer = 0 } = {}) {
  const state = setupMatch({ seed: 11 });
  prepare?.(state);
  controller = createController({ state, botPlayer: null });
  unmount = mountBoard(root, { controller, viewer, title: 'Test', onExit() {} });
  return controller;
}

/** A board where both Gallows and Fusion have something worth flagging. */
function readyForBoth(state) {
  // Two Personas of the same level: feeding one to the other is a feast, which
  // is what lights the Gallows badge.
  setField(state, 0, [
    { cardId: 'pixie', level: 3, active: true },
    { cardId: 'jack-frost', level: 3 },
  ]);
  setHand(state, 0, ['medicine']);
}

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];

beforeEach(() => {
  vi.useFakeTimers();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  root?.remove();
  unmount = null;
  controller = null;
  root = null;
  vi.useRealTimers();
});

describe('action-bar badges', () => {
  it('renders the Gallows badge inside the Gallows button, not loose on the board', () => {
    boot(readyForBoth);
    const gallows = $('.gallows-btn');
    expect(gallows).toBeTruthy();
    const badge = gallows.querySelector('.btn__badge');
    expect(badge).toBeTruthy();
    // The badge is a child of the button, and the button is inside the bar.
    expect(badge.parentElement).toBe(gallows);
    expect(gallows.closest('.action-bar')).toBeTruthy();
  });

  it('marks every badged button as its badge\'s positioning anchor', () => {
    boot(readyForBoth);
    const badges = $$('.btn__badge');
    expect(badges.length).toBeGreaterThan(0);
    for (const badge of badges) {
      expect(badge.parentElement.classList.contains('btn--badged')).toBe(true);
    }
  });

  it('has no badge left addressed to the fusion button alone', () => {
    boot(readyForBoth);
    expect($$('.fusion-btn__badge').length).toBe(0);
    expect(cssText('board.css')).not.toContain('.fusion-btn__badge');
  });

  it('declares the anchor rule in the stylesheet the badge relies on', () => {
    expect(cssText('board.css')).toMatch(/\.btn--badged\s*\{[^}]*position:\s*relative/);
  });

  it('drops the badge when the Gallows has nothing worth a level', () => {
    boot((state) => {
      // A lone high-level eater and a scrap card in hand: junk tier only. (Two
      // Personas on the field can never be junk-only — the smaller one eating
      // the bigger is always a feast.)
      setField(state, 0, [{ cardId: 'jack-frost', level: 12, active: true }]);
      setHand(state, 0, ['pixie']);
    });
    expect($('.gallows-btn .btn__badge')).toBe(null);
  });

  it('keeps the badge anchored on the opponent\'s board layout too', () => {
    // Hot-seat: seat 1 looks at the same action bar from the other side.
    boot((state) => {
      readyForBoth(state);
      setField(state, 1, [
        { cardId: 'pixie', level: 3, active: true },
        { cardId: 'jack-frost', level: 3 },
      ]);
      state.activePlayer = 1;
    }, { viewer: 1 });
    const badge = $('.gallows-btn .btn__badge');
    expect(badge).toBeTruthy();
    expect(badge.parentElement.classList.contains('btn--badged')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * The audit: every action icon, not just the Gallows one
 * ------------------------------------------------------------------ */

/**
 * jsdom's CSS parser gives up on the real stylesheets (it rejects modern
 * syntax and then drops the whole sheet), so getComputedStyle is no use here.
 * Read the rules out of the files instead: innermost `selector { body }`
 * blocks, which skips @media/@supports preludes for free because a selector
 * can never contain a brace.
 */
function rulesDeclaring(css, re) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = [];
  for (const [, selectors, body] of clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!re.test(body)) continue;
    for (const sel of selectors.split(',')) {
      const trimmed = sel.trim();
      if (trimmed && !trimmed.startsWith('@') && !/^\d|^from$|^to$/.test(trimmed)) out.push(trimmed);
    }
  }
  return out;
}

const ALL_CSS = STYLES.map(cssText).join('\n');
// A pseudo-element is positioned against its own element, so `.card::after`
// means `.card` itself must be the anchor.
const ABSOLUTE_SELECTORS = rulesDeclaring(ALL_CSS, /position:\s*absolute/);
const POSITIONED_SELECTORS = rulesDeclaring(ALL_CSS, /position:\s*(relative|absolute|fixed|sticky)/);

const matchesAny = (node, selectors) => selectors.some((sel) => {
  try {
    return node.matches(sel.replace(/::?(before|after)\b/g, ''));
  } catch {
    return false; // a selector jsdom cannot parse tells us nothing either way
  }
});

describe('positioning audit — every absolute element has a positioned parent', () => {
  it('reads real rules out of the stylesheets', () => {
    // Guards the parser above: if the regex ever stops matching, the audit
    // silently passes on an empty list.
    expect(ABSOLUTE_SELECTORS.length).toBeGreaterThan(10);
    expect(ABSOLUTE_SELECTORS).toContain('.btn__badge');
    expect(POSITIONED_SELECTORS).toContain('.btn--badged');
  });

  it('finds no detached absolutely-positioned node anywhere on a live board', () => {
    boot(readyForBoth);

    const offenders = [];
    for (const node of $$('*')) {
      const own = matchesAny(node, ABSOLUTE_SELECTORS);
      // A pseudo-element counts as absolute content owned by this node.
      const pseudo = ABSOLUTE_SELECTORS.some((sel) => {
        if (!/::?(before|after)\b/.test(sel)) return false;
        try { return node.matches(sel.replace(/::?(before|after)\b/g, '')); } catch { return false; }
      });
      if (!own && !pseudo) continue;

      // A pseudo-element anchors to its own box; a child anchors to an ancestor.
      let anchor = pseudo && matchesAny(node, POSITIONED_SELECTORS) ? node : null;
      let parent = node.parentElement;
      while (!anchor && parent && parent !== root.parentElement) {
        if (matchesAny(parent, POSITIONED_SELECTORS)) anchor = parent;
        parent = parent.parentElement;
      }
      if (!anchor) offenders.push(`${node.className || node.tagName}: no positioned ancestor`);
    }

    expect(offenders).toEqual([]);
  });

  it('would have caught the original bug', () => {
    // Proof the audit is not vacuous: the pre-fix markup — an absolutely
    // positioned badge on a button with no anchor class — is reported.
    boot(readyForBoth);
    const gallows = $('.gallows-btn');
    gallows.classList.remove('btn--badged');
    const badge = gallows.querySelector('.btn__badge');

    expect(matchesAny(badge, ABSOLUTE_SELECTORS)).toBe(true);
    expect(matchesAny(gallows, POSITIONED_SELECTORS)).toBe(false);
  });
});
