/**
 * @vitest-environment jsdom
 *
 * The admin unlock: name yourself `n--admin` and everything opens.
 *
 * The two things worth being careful about are the edges, not the happy path:
 *
 *   1. It must not trigger by accident. A name that merely contains the string,
 *      or a player called "admin", must be an ordinary player.
 *   2. It must be *permanent* in the way the feature claims — renaming back to
 *      something else keeps the unlocks, because a grant that evaporates when
 *      you change your name is a costume, not an unlock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  ADMIN_NAME,
  isAdminName,
  isAdminUnlocked,
  activateAdmin,
  deactivateAdmin,
  syncAdmin,
  reloadAdmin,
} from '../src/ui/admin.js';
import { getProfileName, setProfileName, resetProfile } from '../src/ui/profile.js';
import { ADMIN_THEME, THEMES, visibleThemes, applyThemeFor } from '../src/ui/theme.js';
import { getSettings, resetSettings } from '../src/ui/settings.js';
import { BATTLE_COUNT, BATTLES } from '../src/ui/story/campaign.js';
import { getStoryProgress, isBattleUnlocked, reloadStoryProgress, resetStoryProgress } from '../src/ui/story/progress.js';
import { TROPHY_IDS } from '../src/ui/story/trophies.js';
import { getEarnedTrophies, isShelfUnlocked, reloadTrophies, resetTrophies } from '../src/ui/story/trophyStore.js';
import { renderMenu } from '../src/ui/menu.js';
import { renderSettings } from '../src/ui/settingsView.js';
import { renderStory } from '../src/ui/story/index.js';

let root;

beforeEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
  window.location.hash = '';
  localStorage.clear();
  reloadAdmin();
  resetSettings();
  resetStoryProgress();
  resetTrophies();
  root = document.createElement('div');
  document.body.appendChild(root);
});

afterEach(() => {
  document.body.innerHTML = '';
  document.documentElement.className = '';
});

const $$ = (sel) => [...root.querySelectorAll(sel)];
const click = (node) => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

/* ------------------------------------------------------------------ *
 * The trigger
 * ------------------------------------------------------------------ */

describe('the name that opens it', () => {
  it('recognises the exact name, ignoring case and surrounding space', () => {
    expect(isAdminName('n--admin')).toBe(true);
    expect(isAdminName('N--Admin')).toBe(true);
    expect(isAdminName('  n--admin  ')).toBe(true);
    expect(ADMIN_NAME).toBe('n--admin');
  });

  it('is not triggered by anything near it', () => {
    // The important half. A player who picks a name like this is a player, and
    // silently handing them a finished campaign would be a bug they cannot undo
    // without knowing the feature exists.
    for (const name of ['admin', 'n-admin', 'n--administrator', 'xn--admin', 'n--admin!', 'Wild Card', '']) {
      expect(isAdminName(name), name).toBe(false);
    }
  });

  it('does nothing at all for an ordinary name', () => {
    setProfileName('Wild Card');
    expect(isAdminUnlocked()).toBe(false);
    expect(isBattleUnlocked(BATTLE_COUNT)).toBe(false);
    expect(getEarnedTrophies()).toEqual({});
  });
});

/* ------------------------------------------------------------------ *
 * What it grants
 * ------------------------------------------------------------------ */

describe('what the unlock grants', () => {
  beforeEach(() => setProfileName('n--admin'));

  it('opens every battle without claiming any of them were beaten', () => {
    for (const battle of BATTLES) expect(isBattleUnlocked(battle.number), `battle ${battle.number}`).toBe(true);
    // Unlocked is not the same as cleared: a faked clear list would make an
    // admin save indistinguishable from a finished campaign.
    expect(getStoryProgress().cleared).toEqual([]);
  });

  it('awards every trophy and reveals the shelf', () => {
    expect(Object.keys(getEarnedTrophies()).sort()).toEqual([...TROPHY_IDS].sort());
    expect(isShelfUnlocked()).toBe(true);
  });

  it('grants and applies the Persona 1 colour scheme', () => {
    expect(getSettings().theme).toBe(ADMIN_THEME);
    expect(document.documentElement.classList.contains(`theme-${ADMIN_THEME}`)).toBe(true);

    const p1 = THEMES.find((t) => t.id === ADMIN_THEME);
    expect(p1.name).toBe('Persona 1');
    expect(p1.admin).toBe(true);
  });

  it('persists all of it across a reload', () => {
    expect(reloadAdmin()).toBe(true);
    expect(reloadStoryProgress().currentBattle).toBe(BATTLE_COUNT);
    expect(Object.keys(reloadTrophies())).toHaveLength(TROPHY_IDS.length);
  });

  it('re-grants on a later activation, so resetting progress does not half-lock it', () => {
    resetStoryProgress();
    resetTrophies();
    expect(isBattleUnlocked(BATTLE_COUNT)).toBe(false);

    setProfileName('n--admin');
    expect(isBattleUnlocked(BATTLE_COUNT)).toBe(true);
    expect(isShelfUnlocked()).toBe(true);
  });

  it('reports whether it was this call that activated it', () => {
    expect(syncAdmin('n--admin')).toBe(false); // already on from beforeEach
    deactivateAdmin();
    expect(syncAdmin('n--admin')).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Permanence
 * ------------------------------------------------------------------ */

describe('it stays unlocked', () => {
  it('survives renaming back to an ordinary name', () => {
    setProfileName('n--admin');
    setProfileName('Wild Card');

    expect(getProfileName()).toBe('Wild Card');
    expect(isAdminUnlocked()).toBe(true);
    expect(isBattleUnlocked(BATTLE_COUNT)).toBe(true);
    expect(isShelfUnlocked()).toBe(true);
    expect(visibleThemes({ admin: isAdminUnlocked() }).some((t) => t.id === ADMIN_THEME)).toBe(true);
  });

  it('can be turned off, and gives the theme back when it is', () => {
    setProfileName('n--admin');
    deactivateAdmin();

    expect(isAdminUnlocked()).toBe(false);
    expect(getSettings().theme).toBeNull();
    expect(document.documentElement.classList.contains(`theme-${ADMIN_THEME}`)).toBe(false);

    // Progress earned along the way is the player's and stays.
    expect(isBattleUnlocked(BATTLE_COUNT)).toBe(true);
    expect(isShelfUnlocked()).toBe(true);
  });

  it('survives storage being unavailable, without crashing', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    expect(() => activateAdmin()).not.toThrow();
    setItem.mockRestore();
  });
});

/* ------------------------------------------------------------------ *
 * What it looks like
 * ------------------------------------------------------------------ */

describe('the screens', () => {
  it('shows no sign of it before it is unlocked', () => {
    renderMenu(root);
    expect(root.querySelector('.admin-badge')).toBeNull();

    renderSettings(root);
    expect(root.textContent).not.toMatch(/admin/i);
    expect($$('.setting-card[data-theme]').map((n) => n.dataset.theme)).not.toContain(ADMIN_THEME);
  });

  it('badges the menu and offers the theme once unlocked', () => {
    setProfileName('n--admin');

    renderMenu(root);
    expect(root.querySelector('.admin-badge').textContent).toBe('ADMIN');

    renderSettings(root);
    expect($$('.setting-card[data-theme]').map((n) => n.dataset.theme)).toContain(ADMIN_THEME);
    expect(root.textContent).toContain('Admin unlock');
  });

  it('offers a way back out from Settings', () => {
    setProfileName('n--admin');
    renderSettings(root);

    const off = $$('.btn').find((b) => b.textContent.includes('Turn off admin unlock'));
    expect(off).toBeTruthy();
    click(off);

    expect(isAdminUnlocked()).toBe(false);
    expect(root.textContent).not.toContain('Admin unlock');
  });

  it('opens the whole campaign map', () => {
    setProfileName('n--admin');
    renderStory(root, {});
    expect($$('.story-card').filter((n) => n.disabled)).toEqual([]);
    expect($$('.story-card--locked')).toEqual([]);
  });

  it('lets a locked-away battle actually be entered', () => {
    setProfileName('n--admin');
    renderStory(root, { battleNumber: BATTLE_COUNT });
    // The finale is PLAYER_CHOICE, so it opens on deck select rather than a board.
    expect(window.location.hash).not.toBe('#/story');
    expect(root.querySelector('.setup__start')).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ *
 * Resetting
 * ------------------------------------------------------------------ */

describe('resetting the profile', () => {
  it('does not silently re-arm the unlock from a stale name', () => {
    setProfileName('n--admin');
    deactivateAdmin();
    resetProfile();
    expect(getProfileName()).not.toBe('n--admin');
    expect(isAdminUnlocked()).toBe(false);
  });
});
