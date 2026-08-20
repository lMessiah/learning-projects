/**
 * Theme selection.
 *
 * A theme is only a class on <html>; all the colour lives in themes.css as CSS
 * variables, so switching one never touches component logic.
 *
 * Precedence: the Settings override, else the deck the player picked, else P5.
 */
import { getSettings, setSetting } from './settings.js';

export const THEMES = Object.freeze([
  { id: 'p3', label: 'P3', name: 'Moonlit Blue', blurb: 'Cool blues over dark navy, moon and water.', swatch: ['#050a18', '#3d8bff', '#9fd8ff'] },
  { id: 'p4', label: 'P4', name: 'Midnight Channel', blurb: 'Warm gold on black with TV static.', swatch: ['#080604', '#f5c518', '#fff08a'] },
  { id: 'p5', label: 'P5', name: 'Take Your Heart', blurb: 'Aggressive red, black and white, sharp angles.', swatch: ['#0b0b0d', '#e01b32', '#ffffff'] },
  // Not in the deck mapping and not offered in Settings unless the admin unlock
  // has been used — there is no P1 deck, so nothing can select it by accident.
  {
    id: 'p1',
    label: 'P1',
    name: 'Persona 1',
    blurb: 'Deep violet over black. The oldest night of all.',
    swatch: ['#07060c', '#8b5cf6', '#e9d5ff'],
    admin: true,
  },
]);

export const DEFAULT_THEME = 'p5';

/** The theme the admin unlock grants. */
export const ADMIN_THEME = 'p1';

const THEME_IDS = new Set(THEMES.map((t) => t.id));

/**
 * The themes a picker should offer.
 *
 * `admin` is passed in rather than read here on purpose: theme.js knowing about
 * ui/admin.js would be a circular import, since admin.js applies a theme. The
 * caller already knows whether it is unlocked.
 */
export function visibleThemes({ admin = false } = {}) {
  return THEMES.filter((theme) => !theme.admin || admin);
}

/**
 * Decks are named after their game, so the mapping is direct.
 *
 * Admin-only themes are excluded: they are not a deck's theme, and a deck id
 * could otherwise resolve to one if the two ever shared a name.
 */
export function themeForDeck(deckId) {
  const theme = THEMES.find((t) => t.id === deckId);
  return theme && !theme.admin ? theme.id : DEFAULT_THEME;
}

/** The theme that should be showing, given an optional deck context. */
export function resolveTheme({ deckId = null } = {}) {
  const override = getSettings().theme;
  if (override && THEME_IDS.has(override)) return override;
  if (deckId) return themeForDeck(deckId);
  return DEFAULT_THEME;
}

/**
 * Keep the browser chrome in step with the theme.
 *
 * On mobile this is the colour of the address bar and the task-switcher card,
 * so leaving it fixed makes a themed page look like it belongs to some other
 * site. The value is the theme's own background — the first swatch.
 */
function applyThemeColor(themeId) {
  const theme = THEMES.find((t) => t.id === themeId);
  if (!theme || typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme.swatch[0]);
}

/** Paint a theme onto the document. Safe to call repeatedly. */
export function applyTheme(themeId) {
  const id = THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME;
  const root = document.documentElement;
  for (const theme of THEMES) root.classList.remove(`theme-${theme.id}`);
  root.classList.add(`theme-${id}`);
  root.dataset.theme = id;
  applyThemeColor(id);
  return id;
}

/** Apply the theme for a match context (deck-derived unless overridden). */
export function applyThemeFor(context) {
  return applyTheme(resolveTheme(context));
}

export function getThemeOverride() {
  return getSettings().theme;
}

/** `null` restores "follow my deck". */
export function setThemeOverride(themeId) {
  setSetting('theme', themeId && THEME_IDS.has(themeId) ? themeId : null);
  return applyThemeFor({});
}
