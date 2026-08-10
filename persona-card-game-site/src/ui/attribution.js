/**
 * Site attribution.
 *
 * This used to be a badge fixed to the corner of every screen, which meant the
 * board had to give up a strip of height so it could not sit on top of the
 * battle log. It lives in the Settings credits section now: same link, same
 * styling, no claim on the viewport and nothing for the board to work around.
 */
import { animationScale } from './settings.js';

export const ATTRIBUTION_URL = 'https://home.shcherbakov.co';
export const ATTRIBUTION_TEXT = 'This site was developed by shcherbakov.co';

/**
 * The attribution link: a silver plate inside a rainbow gradient outline.
 *
 * The outline spins unless animations are switched off, in which case it is
 * painted as a static gradient instead. That is decided here rather than
 * through a class on `<body>` — one element's decoration has no business
 * setting global state.
 */
export function renderAttributionLink() {
  const link = document.createElement('a');
  link.className = `attribution${animationScale() === 0 ? ' attribution--static' : ''}`;
  link.href = ATTRIBUTION_URL;
  link.target = '_blank';
  // noopener is the one that matters (the new tab must not get window.opener);
  // noreferrer is added because there is no reason to send the referrer either.
  link.rel = 'noopener noreferrer';
  link.title = ATTRIBUTION_TEXT;

  // The label is a separate element so the text never inherits the gradient.
  const label = document.createElement('span');
  label.className = 'attribution__label';
  label.textContent = ATTRIBUTION_TEXT;
  link.appendChild(label);

  return link;
}
