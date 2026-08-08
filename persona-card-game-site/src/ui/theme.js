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
]);

export const DEFAULT_THEME = 'p5';

const THEME_IDS = new Set(THEMES.map((t) => t.id));

/** Decks are named after their game, so the mapping is direct. */
export function themeForDeck(deckId) {
  return THEME_IDS.has(deckId) ? deckId : DEFAULT_THEME;
}

/** The theme that should be showing, given an optional deck context. */
export function resolveTheme({ deckId = null } = {}) {
  const override = getSettings().theme;
  if (override && THEME_IDS.has(override)) return override;
  if (deckId) return themeForDeck(deckId);
  return DEFAULT_THEME;
}

/** Paint a theme onto the document. Safe to call repeatedly. */
export function applyTheme(themeId) {
  const id = THEME_IDS.has(themeId) ? themeId : DEFAULT_THEME;
  const root = document.documentElement;
  for (const theme of THEMES) root.classList.remove(`theme-${theme.id}`);
  root.classList.add(`theme-${id}`);
  root.dataset.theme = id;
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
