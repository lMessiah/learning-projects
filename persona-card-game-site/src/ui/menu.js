/**
 * Main menu — three boxes: Against Bot, Local Multiplayer, Settings.
 * The Card Gallery hangs off the side as a reference link.
 */
import { getProfileName, setProfileName } from './profile.js';

const BOXES = [
  {
    id: 'bot',
    icon: '🎭',
    label: 'Against Bot',
    desc: 'Take on the AI across four difficulties: Easy, Medium, Brutal and Chaos.',
    route: '#/bot',
    enabled: true,
  },
  {
    id: 'local',
    icon: '👥',
    label: 'Local Multiplayer',
    desc: 'Hot-seat on one device, with a pass-the-device screen so hands stay hidden.',
    route: '#/local',
    enabled: true,
  },
  {
    id: 'online',
    icon: '🌐',
    label: 'Online Match',
    desc: 'Play someone on another machine, browser to browser. No server, no account.',
    route: '#/online',
    enabled: true,
  },
  {
    id: 'settings',
    icon: '⚙️',
    label: 'Settings',
    desc: 'Sound, animation speed, board theme and profile reset.',
    route: '#/settings',
    enabled: true,
  },
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderMenu(root) {
  root.innerHTML = '';

  const topbar = el('div', 'topbar');
  const titleWrap = el('div');
  titleWrap.appendChild(el('h1', 'topbar__title', 'Persona Card Game'));
  titleWrap.appendChild(el('div', 'topbar__sub', 'Unofficial fan project · Patch 3'));
  topbar.appendChild(titleWrap);
  topbar.appendChild(el('div', 'topbar__spacer'));

  const who = el('div', 'topbar__sub');
  who.textContent = `Playing as ${getProfileName()}`;
  topbar.appendChild(who);
  const rename = el('button', 'btn btn--ghost', 'Rename');
  rename.addEventListener('click', () => {
    const next = window.prompt('Display name (local only):', getProfileName());
    if (next !== null) {
      who.textContent = `Playing as ${setProfileName(next)}`;
    }
  });
  topbar.appendChild(rename);
  root.appendChild(topbar);

  const menu = el('div', 'menu');
  for (const box of BOXES) {
    const btn = el('button', 'menu__box');
    btn.type = 'button';
    if (!box.enabled) btn.disabled = true;
    btn.appendChild(el('span', 'menu__status', box.enabled ? 'Ready' : 'Coming soon'));
    btn.appendChild(el('span', 'menu__icon', box.icon));
    btn.appendChild(el('span', 'menu__label', box.label));
    btn.appendChild(el('span', 'menu__desc', box.desc));
    btn.addEventListener('click', () => {
      if (box.enabled) window.location.hash = box.route;
    });
    menu.appendChild(btn);
  }
  root.appendChild(menu);

  const aside = el('div', 'menu__aside');
  const gallery = el('button', 'btn btn--primary', '🃏 Card Gallery');
  gallery.addEventListener('click', () => {
    window.location.hash = '#/gallery';
  });
  aside.appendChild(gallery);
  aside.appendChild(el('span', null, 'Inspect every card in the database — Personas, Items, Specials and fusion recipes.'));
  root.appendChild(aside);

  root.appendChild(
    el(
      'div',
      'notice',
      'Unofficial fan-made project, not affiliated with or endorsed by ATLUS or SEGA. ' +
        'All card art is placeholder CSS — no game artwork, sprites or logos are used. Everything runs locally in your browser.'
    )
  );
}
