/**
 * @vitest-environment jsdom
 *
 * Themes, persisted settings, and the play assists that read them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMatch, CONFIG } from '../src/engine/index.js';
import { createController } from '../src/ui/game/controller.js';
import { mountBoard } from '../src/ui/game/board.js';
import {
  getSettings,
  setSetting,
  resetSettings,
  animationScale,
  autoEndDelay,
  DEFAULTS,
  ANIMATION_SPEEDS,
} from '../src/ui/settings.js';
import { THEMES, visibleThemes, applyTheme, applyThemeFor, themeForDeck, resolveTheme, setThemeOverride } from '../src/ui/theme.js';
import { renderSettings } from '../src/ui/settingsView.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getProfileName, setProfileName } from '../src/ui/profile.js';

let root;
let unmount;
let controller;

const $ = (sel) => root.querySelector(sel);
const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetSettings();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  unmount?.();
  controller?.destroy();
  unmount = null;
  controller = null;
  root.remove();
  localStorage.clear();
  resetSettings();
  document.documentElement.className = '';
  document.body.classList.remove('board-mode');
  vi.useRealTimers();
});

describe('tab identity', () => {
  // Paths from the project root: under jsdom `import.meta.url` is not a file URL.
  const fromRoot = (relative) => resolve(process.cwd(), relative);
  const html = readFileSync(fromRoot('index.html'), 'utf8');

  it('names the game and marks it as a fan project', () => {
    expect(html).toMatch(/<title>Velvet Duel/);
    expect(html).toMatch(/Unofficial/i);
  });

  it('ships an SVG favicon with a PNG fallback and a theme colour', () => {
    expect(html).toMatch(/rel="icon"[^>]*type="image\/svg\+xml"/);
    expect(html).toMatch(/rel="icon"[^>]*type="image\/png"[^>]*sizes="32x32"/);
    expect(html).toMatch(/name="theme-color"/);
    for (const file of ['favicon.svg', 'favicon-32.png', 'apple-touch-icon.png']) {
      expect(existsSync(fromRoot(`public/${file}`)), file).toBe(true);
    }
  });

  it('draws the icon from primitives — no embedded or external artwork', () => {
    const svg = readFileSync(fromRoot('public/favicon.svg'), 'utf8');
    expect(svg).not.toMatch(/<image|xlink:href|data:image|url\(/i);
    expect(svg).toMatch(/<rect|<path|<circle/);
  });

  it('keeps theme-color in step with the theme', () => {
    const meta = document.createElement('meta');
    meta.setAttribute('name', 'theme-color');
    meta.setAttribute('content', '#000000');
    document.head.appendChild(meta);

    for (const theme of THEMES) {
      applyTheme(theme.id);
      expect(meta.getAttribute('content')).toBe(theme.swatch[0]);
    }
    meta.remove();
  });
});


describe('settings storage', () => {
  it('starts from the documented defaults', () => {
    expect(getSettings()).toEqual(DEFAULTS);
    expect(DEFAULTS.autoEndTurn).toBe(false);
    expect(DEFAULTS.autoSkipChoices).toBe(true);
    expect(DEFAULTS.theme).toBe(null);
    expect(DEFAULTS.animationSpeed).toBe('normal');
  });

  it('persists a change to localStorage and reads it back', () => {
    setSetting('autoEndTurn', true);
    expect(getSettings().autoEndTurn).toBe(true);
    expect(JSON.parse(localStorage.getItem('pcg.settings')).autoEndTurn).toBe(true);
  });

  it('survives a corrupt store without throwing', () => {
    localStorage.setItem('pcg.settings', 'not json');
    resetSettings();
    localStorage.setItem('pcg.settings', 'not json');
    expect(() => getSettings()).not.toThrow();
  });

  it('maps animation speed to a scale, and off removes the auto-end delay', () => {
    expect(animationScale({ animationSpeed: 'normal' })).toBe(1);
    expect(animationScale({ animationSpeed: 'fast' })).toBeGreaterThan(1);
    expect(animationScale({ animationSpeed: 'off' })).toBe(0);

    expect(autoEndDelay({ animationSpeed: 'normal' })).toBeGreaterThan(0);
    expect(autoEndDelay({ animationSpeed: 'off' })).toBe(0);
    expect(ANIMATION_SPEEDS.map((s) => s.id)).toEqual(['off', 'fast', 'normal']);
  });
});

describe('themes', () => {
  it('exposes one selectable theme per game, and hides the admin-only one', () => {
    // P1 exists but is not offered: there is no P1 deck, and it is granted by
    // the admin unlock rather than chosen. See ui/admin.js.
    expect(visibleThemes().map((t) => t.id)).toEqual(['p3', 'p4', 'p5']);
    expect(visibleThemes({ admin: true }).map((t) => t.id)).toEqual(['p3', 'p4', 'p5', 'p1']);
    expect(THEMES.filter((t) => t.admin).map((t) => t.id)).toEqual(['p1']);
  });

  it('never resolves an admin theme from a deck', () => {
    expect(themeForDeck('p1')).not.toBe('p1');
  });

  it('applies exactly one theme class to the document root', () => {
    applyTheme('p3');
    expect(document.documentElement.classList.contains('theme-p3')).toBe(true);
    expect(document.documentElement.dataset.theme).toBe('p3');

    applyTheme('p4');
    expect(document.documentElement.classList.contains('theme-p4')).toBe(true);
    expect(document.documentElement.classList.contains('theme-p3')).toBe(false);
  });

  it('falls back to the default theme for an unknown id', () => {
    applyTheme('nonsense');
    expect(document.documentElement.classList.contains('theme-p5')).toBe(true);
  });

  it('follows the deck when no override is set', () => {
    expect(themeForDeck('p4')).toBe('p4');
    expect(resolveTheme({ deckId: 'p3' })).toBe('p3');
    expect(applyThemeFor({ deckId: 'p4' })).toBe('p4');
  });

  it('lets the Settings override beat the deck, and persists it', () => {
    setThemeOverride('p3');
    expect(resolveTheme({ deckId: 'p4' })).toBe('p3'); // override wins
    expect(getSettings().theme).toBe('p3');
    expect(JSON.parse(localStorage.getItem('pcg.settings')).theme).toBe('p3');

    setThemeOverride(null); // back to following the deck
    expect(resolveTheme({ deckId: 'p4' })).toBe('p4');
  });
});

describe('settings screen', () => {
  it('renders every control and applies a theme immediately on click', () => {
    renderSettings(root);
    expect($$('.setting-card[data-theme]').length).toBe(visibleThemes().length + 1); // + "follow my deck"
    expect($$('.setting-card[data-speed]').length).toBe(ANIMATION_SPEEDS.length);
    expect($$('.setting-toggle').length).toBe(2);

    click($('.setting-card[data-theme="p3"]'));
    expect(document.documentElement.classList.contains('theme-p3')).toBe(true);
    expect(getSettings().theme).toBe('p3');
    expect($('.setting-card[data-theme="p3"]').classList.contains('setting-card--on')).toBe(true);
  });

  it('toggles the play assists', () => {
    renderSettings(root);
    const [autoEnd, autoSkip] = $$('.setting-toggle');
    expect(autoEnd.checked).toBe(false);
    expect(autoSkip.checked).toBe(true);

    autoEnd.checked = true;
    autoEnd.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(getSettings().autoEndTurn).toBe(true);
  });

  it('changes the animation speed', () => {
    renderSettings(root);
    click($('.setting-card[data-speed="off"]'));
    expect(getSettings().animationSpeed).toBe('off');
  });

  it('does not offer a sound toggle while there is no sound', () => {
    renderSettings(root);
    const soundSection = $$('.settings-section').find((s) => s.textContent.includes('Sound'));
    expect(soundSection).toBeTruthy();
    expect(soundSection.querySelector('.setting-toggle')).toBe(null);
  });

  it('resets the profile: name, theme and settings', () => {
    setProfileName('Nick');
    setSetting('autoEndTurn', true);
    setThemeOverride('p4');
    renderSettings(root);

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    click($('.btn--danger'));

    expect(getSettings()).toEqual(DEFAULTS);
    expect(getProfileName()).not.toBe('Nick');
    expect(localStorage.getItem('pcg.settings')).toBe(null);
    expect(document.documentElement.classList.contains('theme-p5')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Play assists on the board
 * ------------------------------------------------------------------ */

function boot() {
  const state = createMatch({
    seed: 42,
    players: [
      { name: 'You', deckId: 'p3', controller: 'human' },
      { name: 'Bot', deckId: 'p4', controller: 'bot', difficulty: 'medium' },
    ],
  });
  controller = createController({ state, botPlayer: 1, difficulty: 'medium', botSeed: 43 });
  unmount = mountBoard(root, { controller, viewer: 0, title: 'test', onExit() {} });
  click($$('.starter-select .card')[0]);
  vi.advanceTimersByTime(5000);
  return controller;
}

/**
 * Strip the player down to where END_TURN is the only legal move. Everything is
 * mutated BEFORE the dispatch, because the board only re-renders (and only then
 * evaluates auto-end) in response to an action.
 */
function exhaustTurn(mutate = null) {
  const state = controller.getState();
  const player = state.players[0];
  player.hand = [];
  player.deck = []; // so the Pass draw finds nothing
  player.discard = [];

  const active = player.field[0];
  active.sp = 0;
  active.hp = 1; // no HP-cost skills either
  player.field = [active];
  player.activeUid = active.uid;

  mutate?.(state);
  controller.dispatch({ type: 'PASS', player: 0 }); // spends the action
  return controller.getState();
}

describe('auto-end turn', () => {
  it('is off by default: the turn waits, but End Turn is highlighted', () => {
    boot();
    exhaustTurn();

    const endTurn = $$('.action-bar .btn').find((b) => b.textContent.includes('End turn'));
    expect(endTurn.classList.contains('btn--suggested')).toBe(true);

    vi.advanceTimersByTime(5000);
    expect(controller.getState().activePlayer).toBe(0); // still ours
  });

  it('ends the turn automatically when switched on', () => {
    setSetting('autoEndTurn', true);
    boot();
    exhaustTurn();

    expect(controller.getState().activePlayer).toBe(0);
    vi.advanceTimersByTime(1200);
    expect(controller.getState().activePlayer).not.toBe(0); // handed over
  });

  it('never auto-ends while a One More is still unspent', () => {
    setSetting('autoEndTurn', true);
    boot();
    // A pending One More leaves an action in hand, so the turn is never spent.
    exhaustTurn((state) => {
      state.turnState.oneMoreUsed = true;
      state.turnState.actionsRemaining = 2; // one is consumed by the Pass below
    });

    expect(controller.getState().turnState.actionsRemaining).toBe(1);
    expect(controller.getState().turnState.oneMoreUsed).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(controller.getState().activePlayer).toBe(0);
  });

  it('never auto-ends while an extra Baton Pass change is unspent', () => {
    setSetting('autoEndTurn', true);
    boot();
    // Baton Pass granted a second change and it has not been used.
    exhaustTurn((state) => {
      state.turnState.personaChangesRemaining = 2;
    });

    expect(controller.getState().turnState.personaChangesRemaining).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(controller.getState().activePlayer).toBe(0);
  });

  it('skips the delay entirely when animations are off', () => {
    setSetting('autoEndTurn', true);
    setSetting('animationSpeed', 'off');
    boot();
    exhaustTurn();

    vi.advanceTimersByTime(1); // no 1s pause to wait through
    expect(controller.getState().activePlayer).not.toBe(0);
  });
});

describe('auto-skip impossible choices', () => {
  /** One damaged Persona + a Medicine: exactly one legal target. */
  function singleTargetItem() {
    const state = controller.getState();
    state.players[0].field = [state.players[0].field[0]];
    state.players[0].activeUid = state.players[0].field[0].uid;
    state.players[0].field[0].hp = 5;
    state.players[0].hand = [{ uid: 'med-1', cardId: 'medicine' }];
    controller.dispatch({ type: 'PASS', player: 0 });
    controller.getState().players[0].hand = [{ uid: 'med-1', cardId: 'medicine' }];
  }

  it('picks the only legal target automatically when on (default)', () => {
    boot();
    singleTargetItem();

    const medicine = $$('.hand-tile').find((t) => t.dataset.cardId === 'medicine');
    click(medicine);
    click([...document.querySelectorAll('.card-detail-overlay button')].find((b) => /Play/.test(b.textContent)));

    expect($('.prompt')).toBe(null); // no targeting step
    expect(controller.getState().turnState.itemsPlayed).toBe(1);
  });

  it('asks for confirmation when switched off', () => {
    setSetting('autoSkipChoices', false);
    boot();
    singleTargetItem();

    const medicine = $$('.hand-tile').find((t) => t.dataset.cardId === 'medicine');
    click(medicine);
    click([...document.querySelectorAll('.card-detail-overlay button')].find((b) => /Play/.test(b.textContent)));

    expect($('.prompt')).toBeTruthy(); // targeting mode, even with one option
    expect(controller.getState().turnState.itemsPlayed).toBe(0);

    click($('.tile--targetable'));
    expect(controller.getState().turnState.itemsPlayed).toBe(1);
  });
});

describe('animation speed on the board', () => {
  it('sets the CSS scale and disables effects when off', () => {
    setSetting('animationSpeed', 'off');
    boot();
    expect($('.board-screen') || root.querySelector('.board-screen')).toBeTruthy();

    const screen = root.querySelector('.board-screen');
    expect(screen.classList.contains('board-screen--no-anim')).toBe(true);

    const attack = $$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled);
    click(attack);
    // No floating numbers or splashes are produced at all.
    expect(root.querySelector('.float-num')).toBe(null);
    expect(root.querySelector('.splash')).toBe(null);
  });

  it('produces effects at normal speed', () => {
    setSetting('animationSpeed', 'normal');
    boot();
    const screen = root.querySelector('.board-screen');
    expect(screen.classList.contains('board-screen--no-anim')).toBe(false);
    expect(screen.style.getPropertyValue('--anim-scale')).toBe('1');

    click($$('.skill-btn').find((b) => b.textContent.includes('Attack') && !b.disabled));
    expect(root.querySelector('.float-num--damage')).toBeTruthy();
  });
});

describe('rules and FAQ', () => {
  it('appears as a Rules section in Settings', () => {
    renderSettings(root);
    const rules = $$('.settings-section').find((s) => s.querySelector('.settings-section__title')?.textContent === 'Rules');
    expect(rules).toBeTruthy();
    expect(rules.querySelector('.rules')).toBeTruthy();
  });

  it('summarises the goal and the shape of a turn', () => {
    renderSettings(root);
    const text = $('.rules').textContent;
    expect(text).toContain(`Knock out ${CONFIG.KO_TARGET} of your opponent's Personas`);
    expect(text).toContain('One More');
    expect(text).toContain('Guard');
    expect($$('.rules__heading').map((h) => h.textContent)).toEqual(
      expect.arrayContaining(['The goal', 'Your turn, step by step', 'Winning fights', 'Growing stronger'])
    );
  });

  it('answers the questions that actually come up', () => {
    renderSettings(root);
    const questions = $$('.faq__q').map((q) => q.textContent);

    expect(questions).toContain("Why can't I summon my Persona?");
    expect(questions).toContain('How do I get more cards?');
    expect(questions).toContain('How long does a match last?');
    expect(questions.length).toBeGreaterThanOrEqual(8);
  });

  it('explains the summon block with the real level rule', () => {
    renderSettings(root);
    const answer = $$('.faq').find((f) => /summon my Persona/.test(f.querySelector('.faq__q').textContent));
    const text = answer.textContent;
    expect(text).toContain(`the highest level on your field + ${CONFIG.PLAY_LEVEL_GAP}`);
    expect(text).toContain('Play ≤ Lv N');
    expect(text).toContain(`cap ${CONFIG.FIELD_CAP} living Personas`);
  });

  it('starts every FAQ entry collapsed', () => {
    renderSettings(root);
    expect($$('.faq').every((f) => !f.open)).toBe(true);
  });

  it('reads its numbers from the engine config rather than hard-coding them', () => {
    renderSettings(root);
    const text = $('.rules').textContent;
    // A retune of any of these updates the rules text automatically.
    expect(text).toContain(`${CONFIG.ITEMS_PER_TURN} Item`);
    expect(text).toContain(`${CONFIG.SPECIALS_PER_TURN} Special`);
    expect(text).toContain(`${CONFIG.HAND_LIMIT} cards`);
    expect(text).toContain(`${CONFIG.SP_REGEN_PER_TURN} SP`);
    expect(text).toContain(`×${CONFIG.WEAK_MULT} damage`);
    expect(text).toContain(`${CONFIG.FATIGUE_DAMAGE} damage per stack`);
  });

  it('is reachable mid-match without abandoning the match', () => {
    boot();
    const turnBefore = controller.getState().turn;

    click($$('.topbar .btn').find((b) => b.textContent.includes('Menu')));
    click($$('.menu-list .btn').find((b) => b.textContent.includes('Rules')));

    expect($('.modal__head h3').textContent).toBe('Rules & FAQ');
    expect($('.rules .faq')).toBeTruthy();
    // The board is still mounted underneath and the match untouched.
    expect($('.board-play')).toBeTruthy();
    expect(controller.getState().turn).toBe(turnBefore);
  });

  it('no longer offers an in-match Settings link that would drop the match', () => {
    boot();
    click($$('.topbar .btn').find((b) => b.textContent.includes('Menu')));
    const labels = $$('.menu-list .btn').map((b) => b.textContent);
    expect(labels.some((l) => l.includes('Rules'))).toBe(true);
    expect(labels.some((l) => l.includes('Fusion recipes'))).toBe(true);
    expect(labels.some((l) => l.includes('Settings'))).toBe(false);
  });
});

describe('collapsible rules and contact', () => {
  const rulesSection = () =>
    $$('.settings-section').find((s) => s.querySelector('.settings-section__title')?.textContent === 'Rules');

  it('folds the rules away by default so the settings stay reachable', () => {
    renderSettings(root);
    const rules = rulesSection();
    expect(rules.tagName).toBe('DETAILS');
    expect(rules.open).toBe(false);
    expect(rules.querySelector('.settings-section__summary')).toBeTruthy();
  });

  it('still holds the full rules content, ready to open', () => {
    renderSettings(root);
    const rules = rulesSection();
    expect(rules.querySelector('.rules')).toBeTruthy();
    expect(rules.querySelectorAll('.faq').length).toBeGreaterThanOrEqual(8);

    rules.open = true;
    expect(rules.querySelector('.faq__q').textContent).toBeTruthy();
  });

  it('leaves the in-match rules modal expanded — it is already a dedicated view', () => {
    boot();
    click($$('.topbar .btn').find((b) => b.textContent.includes('Menu')));
    click($$('.menu-list .btn').find((b) => b.textContent.includes('Rules')));
    expect($('.modal .rules')).toBeTruthy();
    expect($('.modal .settings-section--collapsible')).toBe(null);
  });

  it('offers a Contact us! section with a working mailto link', () => {
    renderSettings(root);
    const contact = $$('.settings-section').find(
      (s) => s.querySelector('.settings-section__title')?.textContent === 'Contact us!'
    );
    expect(contact).toBeTruthy();

    const link = contact.querySelector('.contact-link');
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toMatch(/^mailto:shcherbakovco@gmail\.com/);
    expect(link.textContent).toContain('shcherbakovco@gmail.com');
  });
});

describe('online play documentation', () => {
  it('explains the connection handshake in the FAQ', () => {
    renderSettings(root);
    const entry = $$('.faq').find((f) => /online/i.test(f.querySelector('.faq__q').textContent));
    expect(entry).toBeTruthy();

    const text = entry.textContent;
    expect(text).toContain('Online Match');
    expect(text).toMatch(/One of you hosts/);
    expect(text).toMatch(/The other joins/);
    // It is honest about both the privacy guarantee and its limit.
    expect(text).toContain("you cannot read your opponent's hand");
    expect(text).toMatch(/friendly game rather than tournament security/);
    // ...and distinguishes the rendezvous server from a TURN relay.
    expect(text).toMatch(/firewall/);
    expect(text).toContain('TURN relay');
  });
});

describe('online settings', () => {
  it('offers a rendezvous server field, empty by default', () => {
    renderSettings(root);
    const section = $$('.settings-section').find(
      (s) => s.querySelector('.settings-section__title')?.textContent === 'Online match codes'
    );
    expect(section).toBeTruthy();

    const input = section.querySelector('input[type="url"]');
    expect(input.value).toBe(''); // serverless by default
    expect(getSettings().rendezvousUrl).toBe('');

    input.value = 'http://localhost:8787/';
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(getSettings().rendezvousUrl).toBe('http://localhost:8787/');
  });

  it('explains both code lengths in the FAQ', () => {
    renderSettings(root);
    const entry = $$('.faq').find((f) => /online/i.test(f.querySelector('.faq__q').textContent));
    const text = entry.textContent;
    expect(text).toContain('six-character code');
    expect(text).toContain('node server/rendezvous.js');
    expect(text).toMatch(/irreducible/); // honest about why the default is long
  });
});
