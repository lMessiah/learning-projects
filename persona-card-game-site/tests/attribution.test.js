/**
 * @vitest-environment jsdom
 *
 * The site attribution link, and the Settings credits section it lives in.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderAttributionLink, ATTRIBUTION_URL, ATTRIBUTION_TEXT } from '../src/ui/attribution.js';
import { renderSettings } from '../src/ui/settingsView.js';
import { setSetting, resetSettings } from '../src/ui/settings.js';

const css = readFileSync(resolve(process.cwd(), 'src/styles/base.css'), 'utf8');
const boardCss = readFileSync(resolve(process.cwd(), 'src/styles/board.css'), 'utf8');

let root;

beforeEach(() => {
  resetSettings();
  document.body.innerHTML = '';
  root = document.createElement('div');
  root.id = 'app';
  document.body.appendChild(root);
});

afterEach(() => {
  resetSettings();
});

const sectionTitled = (title) =>
  [...root.querySelectorAll('.settings-section')].find(
    (s) => s.querySelector('.settings-section__title')?.textContent === title
  );

describe('the link', () => {
  it('says who built the site and opens their home page in a new tab', () => {
    const link = renderAttributionLink();
    expect(link.textContent).toBe(ATTRIBUTION_TEXT);
    expect(ATTRIBUTION_TEXT).toBe('This site was developed by shcherbakov.co');
    expect(link.getAttribute('href')).toBe(ATTRIBUTION_URL);
    expect(ATTRIBUTION_URL).toBe('https://home.shcherbakov.co');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});

describe('where it lives', () => {
  it('sits in a Credits section on the Settings screen', () => {
    renderSettings(root);
    const credits = sectionTitled('Credits');
    expect(credits).toBeTruthy();

    const link = credits.querySelector('a.attribution');
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toBe(ATTRIBUTION_URL);
    expect(credits.textContent).toMatch(/not affiliated with or endorsed by ATLUS or SEGA/);
    expect(credits.textContent).toMatch(/placeholder CSS art/);
  });

  it('appears exactly once, and nowhere outside Settings', () => {
    renderSettings(root);
    expect(document.querySelectorAll('.attribution')).toHaveLength(1);
    // Nothing is fixed to the document any more.
    expect(document.body.querySelector(':scope > .attribution')).toBe(null);
    expect(document.querySelector('#site-attribution')).toBe(null);
  });

  it('is gone from the router entry point', () => {
    const main = readFileSync(resolve(process.cwd(), 'src/main.js'), 'utf8');
    expect(main).not.toMatch(/attribution/i);
  });
});

describe('the animation', () => {
  it('is a spinning conic gradient, in CSS alone', () => {
    expect(css).toMatch(/\.attribution\b[^}]*conic-gradient/s);
    expect(css).toMatch(/@keyframes attribution-spin/);
    // The angle has to be registered or it is not interpolatable at all.
    expect(css).toMatch(/@property --attribution-angle/);
  });

  it('renders static when animations are switched off', () => {
    expect(renderAttributionLink().className).not.toContain('attribution--static');

    setSetting('animationSpeed', 'off');
    expect(renderAttributionLink().className).toContain('attribution--static');

    setSetting('animationSpeed', 'normal');
    expect(renderAttributionLink().className).not.toContain('attribution--static');
  });

  it('re-renders static when the setting is changed on the Settings screen itself', () => {
    setSetting('animationSpeed', 'off');
    renderSettings(root);
    expect(root.querySelector('.attribution').className).toContain('attribution--static');
  });

  it('has a static rule for both ways of switching it off', () => {
    expect(css).toMatch(/\.attribution--static[^{]*\{[^}]*animation: none/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.attribution \{[^}]*animation: none/s);
  });

  it('sets no global state to do it', () => {
    // The old badge toggled a class on <body>; one element's decoration has no
    // business doing that, and nothing should be left reading it.
    renderSettings(root);
    expect(document.body.classList.contains('anim-off')).toBe(false);
    expect(css).not.toMatch(/body\.anim-off/);
  });
});

describe('it no longer costs the board anything', () => {
  it('claims no fixed position on any screen', () => {
    expect(css).not.toMatch(/\.attribution\s*\{[^}]*position: fixed/s);
  });

  it('gives the board back the strip it used to reserve', () => {
    expect(boardCss).not.toMatch(/attribution-gutter/);
    expect(boardCss).toMatch(/height: calc\(100vh - 20px\)/);
  });
});
