/**
 * SPA entry point + hash router.
 *
 * Unknown routes fall back to the menu.
 */
import './styles/base.css';
import './styles/cards.css';
import './styles/gallery.css';
import './styles/themes.css';
import './styles/board.css';
// Last on purpose: the one selection/highlight system overrides whatever the
// component sheets above happen to say about hover, selected and target states.
import './styles/select.css';

import { renderMenu } from './ui/menu.js';
import { renderGallery } from './ui/gallery.js';
import { renderBotGame } from './ui/game/botGame.js';
import { renderHotseat } from './ui/game/hotseat.js';
import { renderOnline } from './ui/game/online.js';
import { renderSettings } from './ui/settingsView.js';
import { applyThemeFor } from './ui/theme.js';

const routes = {
  '#/': renderMenu,
  '#/gallery': renderGallery,
  '#/bot': renderBotGame,
  '#/local': renderHotseat,
  '#/online': renderOnline,
  '#/settings': renderSettings,
};

function route() {
  const root = document.getElementById('app');
  const render = routes[window.location.hash] || renderMenu;
  render(root);
  window.scrollTo(0, 0);
}

// Paint the saved theme before the first render so nothing flashes.
applyThemeFor({});

window.addEventListener('hashchange', route);
route();
