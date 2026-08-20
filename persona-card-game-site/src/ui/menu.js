/**
 * Main menu — How to Play, Story Mode, Against Bot, Local Multiplayer,
 * Online Match and Settings.
 * The Card Gallery hangs off the side as a reference link.
 */
import { getProfileName, setProfileName } from './profile.js';
import { isShelfUnlocked } from './story/trophyStore.js';
import { isAdminUnlocked } from './admin.js';

const BOXES = [
  // First on purpose: a new player's eye lands here before it lands on a
  // difficulty picker they have no way to judge yet.
  {
    id: 'howto',
    icon: '📖',
    label: 'How to Play',
    desc: 'Five guided tutorial battles, from your first attack to reading a position two turns ahead.',
    route: '#/howto',
    enabled: true,
  },
  {
    id: 'story',
    icon: '🌙',
    label: 'Story Mode',
    desc: 'A seven-battle campaign against the AI, from the first door to Nyx. Progress saves on this device.',
    route: '#/story',
    enabled: true,
  },
  {
    id: 'bot',
    icon: '🎭',
    label: 'Against Bot',
    desc: 'Four difficulties and five playstyles — Normal, Defensive, All-Rounder, Combo, or Random.',
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
  titleWrap.appendChild(el('h1', 'topbar__title', 'Velvet Duel'));
  // The subtitle carries the disclaimer, so the name can stand on its own while
  // the fan-project status stays on screen rather than buried in Settings.
  titleWrap.appendChild(el('div', 'topbar__sub', 'A Persona card game · Unofficial fan project · Patch 3'));
  topbar.appendChild(titleWrap);
  topbar.appendChild(el('div', 'topbar__spacer'));

  const who = el('div', 'topbar__sub');
  who.textContent = `Playing as ${getProfileName()}`;
  topbar.appendChild(who);
  // Unmistakable while it is on: an unlock you cannot see is one you forget you
  // left running, and then wonder why every battle is already open.
  if (isAdminUnlocked()) topbar.appendChild(el('span', 'admin-badge', 'ADMIN'));
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

  // The Trophy Shelf appears in the menu only once it has been unlocked in
  // Story Mode. Until then the player is given no indication it is there.
  if (isShelfUnlocked()) {
    const shelf = el('div', 'menu__aside');
    const trophies = el('button', 'btn btn--primary', '🏆 Trophy Shelf');
    trophies.addEventListener('click', () => {
      window.location.hash = '#/trophies';
    });
    shelf.appendChild(trophies);
    shelf.appendChild(el('span', null, 'Everything you have earned across the night.'));
    root.appendChild(shelf);
  }

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
