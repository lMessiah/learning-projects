/**
 * @vitest-environment jsdom
 *
 * The animation layer.
 *
 * Two contracts matter and both are testable without a layout engine:
 *
 *  1. the diff spots the right things, including the before/after bar ratios
 *     that the ghost drain has to be rebuilt from;
 *  2. nothing it builds can move the board — every node it adds is absolutely
 *     or fixed positioned, and the CSS only ever animates transform, opacity,
 *     filter or the width of a fill inside a fixed-height track.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyAction, applyAilment, getLegalActions } from '../src/engine/index.js';
import { diffStates, playEffects, statusTokens, DURATIONS, cssDurationVars } from '../src/ui/game/anim.js';
import { ANIMATION_SPEEDS } from '../src/ui/settings.js';
import { setupMatch, setField, setHand, activeOf, uidOf, handUidOf, endTurn } from './helpers.js';

const css = readFileSync(resolve(process.cwd(), 'src/styles/board.css'), 'utf8');

let host;

/** A board screen with tiles the diff can find by uid. */
function screenFor(state) {
  const node = document.createElement('div');
  node.className = 'board-screen';
  node.style.setProperty('--anim-scale', '1');
  for (const player of state.players) {
    for (const persona of player.field) {
      const tile = document.createElement('div');
      tile.className = 'tile';
      tile.dataset.uid = persona.uid;
      for (const kind of ['hp', 'sp']) {
        const bar = document.createElement('div');
        bar.className = `tile__bar tile__bar--${kind}`;
        const fill = document.createElement('div');
        fill.className = 'tile__fill';
        bar.appendChild(fill);
        tile.appendChild(bar);
      }
      node.appendChild(tile);
    }
  }
  document.body.appendChild(node);
  return node;
}

function duel() {
  const state = setupMatch({ seed: 4321 });
  setField(state, 0, [
    { cardId: 'hua-po', level: 16, active: true },
    { cardId: 'jack-frost', level: 12 },
  ]);
  setField(state, 1, [{ cardId: 'jack-frost', level: 6, maxHp: 400, hp: 400, active: true }]);
  state.players[0].hand = [];
  state.players[1].hand = [];
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
});

afterEach(() => {
  host?.remove();
  host = null;
  vi.useRealTimers();
});

describe('the diff', () => {
  it('reports a hit, its ghost-bar ratios and the weakness that caused it', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'agi',
      targetUid: uidOf(before, 1, 'jack-frost'),
    });

    const effects = diffStates(before, after);
    expect(effects.hits).toHaveLength(1);
    expect(effects.hits[0].amount).toBeGreaterThan(0);
    expect(effects.weakness).toBe(true);
    expect(effects.oneMore).toBe(true);
    expect(effects.knockdowns).toHaveLength(1);

    // Two bars moved: the target's HP and the caster's SP.
    const hp = effects.bars.find((b) => b.kind === 'hp');
    const sp = effects.bars.find((b) => b.kind === 'sp');
    expect(hp.from).toBeGreaterThan(hp.to);
    expect(sp.from).toBeGreaterThan(sp.to);
    for (const bar of effects.bars) {
      expect(bar.from).toBeGreaterThanOrEqual(0);
      expect(bar.from).toBeLessThanOrEqual(1);
    }
  });

  it('spots a Technical', () => {
    const before = duel();
    applyAilment(before, activeOf(before, 1), 'burn');
    const after = applyAction(before, { type: 'ATTACK', player: 0, targetUid: uidOf(before, 1, 'jack-frost') });
    expect(diffStates(before, after).technical).toBe(true);
  });

  it('spots a Persona standing back up at the start of a turn', () => {
    let state = duel();
    state.players[1].field[0].knockedDown = true;
    const before = endTurn(state, 0); // still down, waiting for their turn
    expect(before.players[1].field[0].knockedDown).toBe(false);
    // The stand-up happened during that same transition.
    expect(diffStates(state, before).standUps).toHaveLength(1);
  });

  it('carries the whole fusion cast, not a sentence to parse', () => {
    const before = duel();
    const fuse = getLegalActions(before, 0).find((a) => a.type === 'FUSE');
    if (!fuse) return; // this board cannot fuse; the shape is covered below
    const effects = diffStates(before, applyAction(before, fuse));
    expect(effects.fusion.parents).toHaveLength(2);
    expect(typeof effects.fusion.result).toBe('string');
    expect(typeof effects.fusion.level).toBe('number');
  });

  it('carries the Gallows cast', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(before, 0).uid,
      food: { zone: 'field', uid: uidOf(before, 0, 'jack-frost') },
    });

    const effects = diffStates(before, after);
    expect(effects.gallows).toBeTruthy();
    expect(effects.gallows.food).toBe('Jack Frost');
    expect(effects.gallows.eater).toBe('Hua Po');
    expect(effects.gallows.levels).toBe(1);
  });

  it('spots an Endure', () => {
    const before = setupMatch({ seed: 3 });
    setField(before, 0, [{ cardId: 'ippon-datara', level: 22, active: true }]);
    setField(before, 1, [{ cardId: 'kaiwan', level: 14, hp: 5, active: true }]);
    before.players[0].hand = [];

    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'heat-wave',
      targetUid: uidOf(before, 1, 'kaiwan'),
    });
    expect(diffStates(before, after).endures).toHaveLength(1);
  });

  it('reports nothing at all for an unchanged state', () => {
    const state = duel();
    const effects = diffStates(state, state);
    expect(effects.hits).toEqual([]);
    expect(effects.bars).toEqual([]);
    expect(effects.fusion).toBe(null);
  });
});

describe('playback', () => {
  it('builds nothing whatsoever when animations are off', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'agi',
      targetUid: uidOf(before, 1, 'jack-frost'),
    });
    host = screenFor(after);
    const nodes = host.querySelectorAll('*').length;

    playEffects(host, diffStates(before, after), 0);
    expect(host.querySelectorAll('*').length).toBe(nodes);
    expect(host.querySelector('.float-num')).toBe(null);
    expect(host.querySelector('.splash')).toBe(null);
  });

  it('counts a damage number up rather than showing it whole', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'agi',
      targetUid: uidOf(before, 1, 'jack-frost'),
    });
    const effects = diffStates(before, after);
    host = screenFor(after);
    playEffects(host, effects, 1);

    const number = host.querySelector('.float-num--damage');
    expect(number).toBeTruthy();
    expect(number.textContent).toBe('-0'); // starts at nothing

    vi.advanceTimersByTime(DURATIONS.countUp);
    expect(number.textContent).toBe(`-${effects.hits[0].amount}`); // and arrives
  });

  it('finishes counting before the number floats away, at every speed', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'agi',
      targetUid: uidOf(before, 1, 'jack-frost'),
    });
    const effects = diffStates(before, after);

    for (const scale of [1, 2]) {
      document.body.innerHTML = '';
      const screen = screenFor(after);
      playEffects(screen, effects, scale);
      const number = screen.querySelector('.float-num--damage');

      // Just before the number is removed, it must already read its full value.
      vi.advanceTimersByTime(Math.round(DURATIONS.floatNum / scale) - 1);
      expect(number.textContent, `scale ${scale}`).toBe(`-${effects.hits[0].amount}`);
      vi.advanceTimersByTime(2000);
      screen.remove();
    }
  });

  it('leaves a ghost segment over the chunk that was lost, then clears it', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'USE_SKILL',
      player: 0,
      skillId: 'agi',
      targetUid: uidOf(before, 1, 'jack-frost'),
    });
    const effects = diffStates(before, after);
    host = screenFor(after);
    playEffects(host, effects, 1);

    const ghost = host.querySelector('.tile__bar--hp .tile__ghost');
    expect(ghost).toBeTruthy();
    const bar = effects.bars.find((b) => b.kind === 'hp');
    expect(ghost.style.left).toBe(`${bar.to * 100}%`);
    expect(ghost.style.width).toBe(`${(bar.from - bar.to) * 100}%`);

    vi.advanceTimersByTime(2000);
    expect(host.querySelector('.tile__ghost')).toBe(null);
  });

  it('lights the chunk a heal added, in green, and floats a green number', () => {
    const before = duel();
    const wounded = activeOf(before, 0);
    wounded.hp = 10;
    const after = applyAction(before, { type: 'USE_SKILL', player: 0, skillId: 'dia', targetUid: wounded.uid });

    const effects = diffStates(before, after);
    host = screenFor(after);
    playEffects(host, effects, 1);

    const tile = host.querySelector(`[data-uid="${wounded.uid}"]`);
    const gain = tile.querySelector('.tile__bar--hp .tile__ghost--gain');
    expect(gain).toBeTruthy();
    const bar = effects.bars.find((b) => b.kind === 'hp');
    expect(bar.to).toBeGreaterThan(bar.from);
    expect(gain.style.left).toBe(`${bar.from * 100}%`); // starts where the fill was
    expect(host.querySelector('.float-num--heal')).toBeTruthy();
  });

  it('fades an expired pip out where it stood, without adding to the row', () => {
    // Guard is on, then the turn passes and it is gone.
    const before = duel();
    const guard = applyAction(before, { type: 'GUARD', player: 0 });
    const uid = activeOf(guard, 0).uid;
    expect(statusTokens(activeOf(guard, 0)).some((t) => t.key === 'guard')).toBe(true);

    const after = endTurn(endTurn(guard, 0), 1); // back round to us: guard has lapsed
    expect(statusTokens(after.players[0].field.find((p) => p.uid === uid)).some((t) => t.key === 'guard')).toBe(false);

    const effects = diffStates(guard, after);
    const expired = effects.statusExpired.find((e) => e.uid === uid);
    expect(expired).toBeTruthy();
    expect(expired.lost).toContain('guard');

    host = screenFor(after);
    const tile = host.querySelector(`[data-uid="${uid}"]`);
    const row = document.createElement('div');
    row.className = 'tile__status';
    tile.appendChild(row);

    playEffects(host, effects, 1);
    const ghostRow = row.querySelector('.tile__status--ghost');
    expect(ghostRow).toBeTruthy();
    // Everything the row used to hold is redrawn; only the departed pip is lit.
    expect(ghostRow.children).toHaveLength(expired.before.length);
    expect(ghostRow.querySelectorAll('.dot--expiring')).toHaveLength(expired.lost.length);
    for (const dot of ghostRow.children) {
      if (!dot.classList.contains('dot--expiring')) expect(dot.style.visibility).toBe('hidden');
    }

    vi.advanceTimersByTime(2000);
    expect(row.querySelector('.tile__status--ghost')).toBe(null);
  });

  it('shakes the board on a weakness and shouts about a Technical', () => {
    const before = duel();
    applyAilment(before, activeOf(before, 1), 'burn');
    const after = applyAction(before, { type: 'ATTACK', player: 0, targetUid: uidOf(before, 1, 'jack-frost') });
    host = screenFor(after);
    playEffects(host, diffStates(before, after), 1);

    expect(host.classList.contains('is-shaking')).toBe(true);
    expect(host.querySelector('.splash--technical')).toBeTruthy();

    vi.advanceTimersByTime(3000);
    expect(host.classList.contains('is-shaking')).toBe(false);
    expect(host.querySelector('.splash')).toBe(null);
  });

  it('plays the Velvet Room sequence for a Gallows, then tidies it away', () => {
    const before = duel();
    const after = applyAction(before, {
      type: 'GALLOWS',
      player: 0,
      eaterUid: activeOf(before, 0).uid,
      food: { zone: 'field', uid: uidOf(before, 0, 'jack-frost') },
    });
    host = screenFor(after);
    playEffects(host, diffStates(before, after), 1);

    const stage = host.querySelector('.velvet--gallows');
    expect(stage).toBeTruthy();
    expect(stage.textContent).toContain('Jack Frost');
    expect(stage.textContent).toContain('Hua Po');
    expect(stage.textContent).toContain('+1 LEVEL');
    expect(stage.querySelectorAll('.velvet__particle').length).toBeGreaterThan(0);

    vi.advanceTimersByTime(3000);
    expect(host.querySelector('.velvet')).toBe(null);
  });

  it('shows the fusion result with the passive and skills it inherited', () => {
    const before = duel();
    host = screenFor(before);
    playEffects(
      host,
      {
        ...diffStates(before, before),
        fusion: { parents: ['Pixie', 'Jack Frost'], result: 'Black Frost', level: 38, passive: 'Trickster', skills: ['Bufu'] },
      },
      1
    );

    const stage = host.querySelector('.velvet--fusion');
    expect(stage.querySelectorAll('.velvet__parent')).toHaveLength(2);
    expect(stage.querySelector('.velvet__result-name').textContent).toBe('Black Frost');
    expect(stage.querySelector('.velvet__gain--passive').textContent).toBe('Trickster');
    expect([...stage.querySelectorAll('.velvet__gain')].map((n) => n.textContent)).toContain('Bufu');
  });
});

describe('nothing it adds can move the board', () => {
  const ruleFor = (selector) => {
    const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`, 's'));
    return match ? match[1] : '';
  };

  it('positions every overlay out of flow', () => {
    expect(ruleFor('.float-num')).toMatch(/position: absolute/);
    expect(ruleFor('.splash')).toMatch(/position: absolute/);
    expect(ruleFor('.tile__ghost')).toMatch(/position: absolute/);
    expect(ruleFor('.velvet')).toMatch(/position: fixed/);
    expect(ruleFor('.peek')).toMatch(/position: absolute/);
  });

  it('keeps the whole Velvet Room sequence un-clickable', () => {
    expect(ruleFor('.velvet')).toMatch(/pointer-events: none/);
    expect(ruleFor('.float-num')).toMatch(/pointer-events: none/);
  });

  it('animates only transform, opacity, filter and a fill width', () => {
    const forbidden = /^\s*(?:0%|100%|from|to|[\d.]+%)[^{]*\{[^}]*\b(?:margin|padding|top|left|right|bottom|height|gap|font-size)\s*:/m;
    for (const block of css.matchAll(/@keyframes\s+([\w-]+)\s*\{([\s\S]*?)\n\}/g)) {
      const [, name, body] = block;
      // The bar fills are the one exception, and their track has a fixed height.
      if (name === 'ghost-fade') continue;
      expect(body, `@keyframes ${name} animates a layout property`).not.toMatch(forbidden);
    }
  });

  it('scales every battle-feedback animation by the speed setting', () => {
    // Only the classes this module puts on the board are in scope. Screens
    // mounted outside the board — the hot-seat pass gate, the error toast —
    // have no --anim-scale ancestor to read in the first place.
    const driven = [
      '.is-acting',
      '.is-hit',
      '.tile--down.is-hit',
      '.is-healed',
      '.is-going-down',
      '.is-standing-up',
      '.is-enduring',
      '.is-shaking',
      '.is-ko',
      '.is-status-changed .dot',
      '.float-num',
      '.splash--weak',
      '.splash--technical',
      '.splash--onemore',
      '.tile__ghost',
      '.velvet',
      '.velvet__glow',
      '.velvet__particle',
      '.velvet__result',
      '.velvet__gain',
      '.allowance--onemore',
    ];
    for (const selector of driven) {
      const rule = ruleFor(selector);
      expect(rule, `${selector} has no rule`).not.toBe('');
      expect(rule, `${selector} ignores --anim-scale`).toMatch(/var\(--anim-scale[,)]/);
    }
  });

  it('takes every base duration from the one table, not from the stylesheet', () => {
    // Each rule reads `var(--dur-x, <fallback>)`, and board.js stamps the real
    // value from DURATIONS. The fallback exists so the sheet still reads
    // correctly on its own — but it must not be allowed to drift.
    const kebab = (k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    let checked = 0;
    for (const [key, expected] of Object.entries(DURATIONS)) {
      const name = `--dur-${kebab(key)}`;
      for (const [, fallback] of css.matchAll(new RegExp(`var\\(\\${name},\\s*(\\d+)ms\\)`, 'g'))) {
        expect(Number(fallback), `${name} fallback disagrees with DURATIONS.${key}`).toBe(expected);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(15);
  });

  it('publishes every CSS-facing duration and nothing else', () => {
    const vars = cssDurationVars();
    // countUp is counted in JS, so it has no business being a CSS variable.
    expect(vars['--dur-count-up']).toBeUndefined();
    for (const name of Object.keys(vars)) {
      expect(css, `${name} is published but never used`).toContain(`var(${name},`);
    }
  });

  it('is paced so a human can follow it', () => {
    // The four the retiming was actually about.
    expect(DURATIONS.barFill).toBe(600);
    expect(DURATIONS.countUp).toBe(500);
    expect(DURATIONS.knockdown).toBe(400);
    expect(DURATIONS.standUp).toBe(400);
    expect(DURATIONS.fusion).toBeGreaterThanOrEqual(2500);
    expect(DURATIONS.fusion).toBeLessThanOrEqual(3000);
    // Fast halves the lot; off means off.
    const scaleOf = (id) => ANIMATION_SPEEDS.find((s) => s.id === id).scale;
    expect(scaleOf('normal')).toBe(1);
    expect(scaleOf('fast')).toBe(2);
    expect(scaleOf('off')).toBe(0);
  });

  it('lets you cut the fusion ceremony short with a click', () => {
    const before = duel();
    host = screenFor(before);
    playEffects(
      host,
      { ...diffStates(before, before), fusion: { parents: ['Pixie', 'Jack Frost'], result: 'Black Frost', level: 38 } },
      1
    );
    expect(host.querySelector('.velvet--fusion')).toBeTruthy();

    // A press anywhere ends it — the overlay itself never intercepts anything.
    document.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }));
    expect(host.querySelector('.velvet')).toBe(null);

    // ...and the listener is gone, so the next press does nothing untoward.
    expect(() => document.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true }))).not.toThrow();
  });

  it('lets go of the skip listeners even when nobody skips', () => {
    // A bot match plays dozens of ceremonies that nobody interrupts. If the
    // listener only came off on a click, every one of them would leak a closure
    // over a removed DOM node for the life of the page.
    const before = duel();
    host = screenFor(before);
    const added = [];
    const removed = [];
    const origAdd = document.addEventListener.bind(document);
    const origRemove = document.removeEventListener.bind(document);
    document.addEventListener = (type, fn, opts) => { added.push(type); origAdd(type, fn, opts); };
    document.removeEventListener = (type, fn, opts) => { removed.push(type); origRemove(type, fn, opts); };

    try {
      playEffects(host, { ...diffStates(before, before), fusion: { parents: ['A', 'B'], result: 'C', level: 1 } }, 1);
      expect(added.length).toBeGreaterThan(0);
      expect(removed).toHaveLength(0);

      vi.advanceTimersByTime(DURATIONS.fusion + 50);
      expect(removed.sort()).toEqual(added.sort());
    } finally {
      document.addEventListener = origAdd;
      document.removeEventListener = origRemove;
    }
  });

  it('turns the whole lot off for prefers-reduced-motion', () => {
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
    for (const cls of ['.is-hit', '.is-standing-up', '.is-enduring', '.is-shaking', '.velvet', '.tile__ghost']) {
      expect(reduced).toContain(cls);
    }
  });
});
