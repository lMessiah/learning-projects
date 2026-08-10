/**
 * Settings screen. Everything here writes straight to localStorage and takes
 * effect immediately — no reload, no "apply" button.
 */
import { getSettings, setSetting, resetSettings, ANIMATION_SPEEDS, DEFAULT_RENDEZVOUS } from './settings.js';
import { THEMES, applyThemeFor, setThemeOverride } from './theme.js';
import { getProfileName, setProfileName, resetProfile } from './profile.js';
import { renderRulesContent } from './rules.js';
import { renderAttributionLink } from './attribution.js';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = el('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function section(title, hint) {
  const wrap = el('section', 'settings-section');
  wrap.appendChild(el('h2', 'settings-section__title', title));
  if (hint) wrap.appendChild(el('p', 'settings-section__hint', hint));
  return wrap;
}

/**
 * Same thing, but folded away behind a summary. Used for the rules, which are
 * long enough to bury the actual settings if left open.
 */
function collapsibleSection(title, hint, { open = false } = {}) {
  const wrap = el('details', 'settings-section settings-section--collapsible');
  wrap.open = open;

  const head = el('summary', 'settings-section__summary');
  const titles = el('div');
  titles.appendChild(el('h2', 'settings-section__title', title));
  if (hint) titles.appendChild(el('p', 'settings-section__hint', hint));
  head.appendChild(titles);
  wrap.appendChild(head);

  return wrap;
}

/** A labelled on/off switch. */
function toggle({ label, hint, value, onChange }) {
  const row = el('label', 'setting-row');
  const text = el('div', 'setting-row__text');
  text.appendChild(el('span', 'setting-row__label', label));
  if (hint) text.appendChild(el('span', 'setting-row__hint', hint));
  row.appendChild(text);

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'setting-toggle';
  input.checked = Boolean(value);
  input.addEventListener('change', () => onChange(input.checked));
  row.appendChild(input);
  return row;
}

export function renderSettings(root) {
  applyThemeFor({});
  root.innerHTML = '';

  const rerender = () => renderSettings(root);
  const settings = getSettings();

  const topbar = el('div', 'topbar');
  topbar.appendChild(button('← Menu', 'btn btn--ghost', () => {
    window.location.hash = '#/';
  }));
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'Settings'));
  titles.appendChild(el('div', 'topbar__sub', 'Saved locally · applied immediately'));
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('div', 'settings');

  /* ---------- Rules ---------- */
  const rules = collapsibleSection('Rules', 'How the game works, and the questions that come up most.');
  rules.appendChild(renderRulesContent());
  wrap.appendChild(rules);

  /* ---------- Profile ---------- */
  const profile = section('Profile', 'A display name kept in this browser. No account, no server.');
  const nameRow = el('label', 'seat-name');
  nameRow.appendChild(el('span', null, 'Display name'));
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 20;
  nameInput.value = getProfileName();
  nameInput.addEventListener('change', () => {
    nameInput.value = setProfileName(nameInput.value);
  });
  nameRow.appendChild(nameInput);
  profile.appendChild(nameRow);
  wrap.appendChild(profile);

  /* ---------- Theme ---------- */
  const theme = section(
    'Board theme',
    'Defaults to the game your chosen deck comes from. Pick one here to lock it for every match.'
  );
  const themeRow = el('div', 'settings__row');

  const autoCard = el('button', `setting-card${settings.theme === null ? ' setting-card--on' : ''}`);
  autoCard.type = 'button';
  autoCard.dataset.theme = 'auto';
  autoCard.appendChild(el('span', 'setting-card__title', 'Follow my deck'));
  autoCard.appendChild(el('span', 'setting-card__desc', 'P4 deck → P4 theme, and so on.'));
  autoCard.addEventListener('click', () => {
    setThemeOverride(null);
    rerender();
  });
  themeRow.appendChild(autoCard);

  for (const entry of THEMES) {
    const card = el('button', `setting-card${settings.theme === entry.id ? ' setting-card--on' : ''}`);
    card.type = 'button';
    card.dataset.theme = entry.id;
    card.appendChild(el('span', 'setting-card__title', `${entry.label} — ${entry.name}`));
    card.appendChild(el('span', 'setting-card__desc', entry.blurb));
    const swatch = el('div', 'theme-swatch');
    for (const colour of entry.swatch) {
      const chip = el('span');
      chip.style.background = colour;
      swatch.appendChild(chip);
    }
    card.appendChild(swatch);
    card.addEventListener('click', () => {
      setThemeOverride(entry.id);
      rerender();
    });
    themeRow.appendChild(card);
  }
  theme.appendChild(themeRow);
  wrap.appendChild(theme);

  /* ---------- Animation ---------- */
  const animation = section('Animation speed', 'Damage numbers, WEAK! and ONE MORE! splashes, knockdown and the rest.');
  const animRow = el('div', 'settings__row');
  for (const speed of ANIMATION_SPEEDS) {
    const card = el('button', `setting-card${settings.animationSpeed === speed.id ? ' setting-card--on' : ''}`);
    card.type = 'button';
    card.dataset.speed = speed.id;
    card.appendChild(el('span', 'setting-card__title', speed.label));
    card.appendChild(el('span', 'setting-card__desc', speed.blurb));
    card.addEventListener('click', () => {
      setSetting('animationSpeed', speed.id);
      rerender();
    });
    animRow.appendChild(card);
  }
  animation.appendChild(animRow);
  wrap.appendChild(animation);

  /* ---------- Play assists ---------- */
  const assists = section('Play assists');
  assists.appendChild(
    toggle({
      label: 'Auto-end turn',
      hint: 'When nothing but "end turn" is left, end it for me after a short pause. Never while a One More or Baton Pass is still yours to spend.',
      value: settings.autoEndTurn,
      onChange: (value) => {
        setSetting('autoEndTurn', value);
        rerender();
      },
    })
  );
  assists.appendChild(
    toggle({
      label: 'Auto-skip impossible choices',
      hint: 'If a card asks for a target and only one is legal, pick it automatically.',
      value: settings.autoSkipChoices,
      onChange: (value) => {
        setSetting('autoSkipChoices', value);
        rerender();
      },
    })
  );
  wrap.appendChild(assists);

  /* ---------- Sound ---------- */
  const sound = section('Sound');
  sound.appendChild(
    el('p', 'settings-section__hint',
      'The beta has no audio yet, so there is nothing to switch off. A toggle appears here as soon as there is a sound to attach it to.')
  );
  wrap.appendChild(sound);

  /* ---------- Online ---------- */
  const online = section(
    'Online match codes',
    'Online play is peer to peer and needs nothing by default — you paste the connection details directly, which is why that code is long. A rendezvous server holds those details under a six-character code instead. It only ever stores the code; no game data passes through it.'
  );

  const rendezvousRow = el('label', 'seat-name seat-name--wide');
  rendezvousRow.appendChild(el('span', null, 'Rendezvous server (optional)'));
  const rendezvousInput = document.createElement('input');
  rendezvousInput.type = 'url';
  rendezvousInput.placeholder = `${DEFAULT_RENDEZVOUS} — leave empty for no server`;
  rendezvousInput.value = settings.rendezvousUrl || '';
  rendezvousInput.addEventListener('change', () => {
    setSetting('rendezvousUrl', rendezvousInput.value.trim());
  });
  rendezvousRow.appendChild(rendezvousInput);
  online.appendChild(rendezvousRow);

  const useLocal = button(`Use ${DEFAULT_RENDEZVOUS}`, 'btn btn--small', () => {
    setSetting('rendezvousUrl', DEFAULT_RENDEZVOUS);
    rerender();
  });
  online.appendChild(useLocal);
  online.appendChild(
    el('p', 'settings-section__hint',
      'Run the bundled one with: node server/rendezvous.js — zero dependencies, in memory, codes expire after 10 minutes.')
  );
  wrap.appendChild(online);

  /* ---------- Credits ---------- */
  const credits = section('Credits', 'Who built this, and what it is.');
  credits.appendChild(renderAttributionLink());
  credits.appendChild(
    el('p', 'settings-section__hint',
      'Unofficial fan project, not affiliated with or endorsed by ATLUS or SEGA. Every card is placeholder CSS art — ' +
        'no official artwork, sprites or logos are used anywhere.')
  );
  wrap.appendChild(credits);

  /* ---------- Contact ---------- */
  const contact = section('Contact us!', 'Found a bug, or want to argue about the damage formula? We would like to hear it.');
  const mail = el('a', 'contact-link');
  mail.href = 'mailto:shcherbakovco@gmail.com?subject=Persona%20Card%20Game%20feedback';
  mail.rel = 'noopener';
  mail.appendChild(el('span', 'contact-link__icon', '✉️'));
  mail.appendChild(el('span', 'contact-link__address', 'shcherbakovco@gmail.com'));
  contact.appendChild(mail);
  wrap.appendChild(contact);

  /* ---------- Reset ---------- */
  const danger = section('Reset profile', 'Clears your display name, theme choice and every setting on this device.');
  const resetBtn = button('Reset everything', 'btn btn--danger', () => {
    if (!window.confirm('Reset your name, theme and all settings? This cannot be undone.')) return;
    resetProfile();
    resetSettings();
    applyThemeFor({});
    rerender();
  });
  danger.appendChild(resetBtn);
  wrap.appendChild(danger);

  root.appendChild(wrap);
}
