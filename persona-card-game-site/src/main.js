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
import './styles/story.css';
// Last on purpose: the one selection/highlight system overrides whatever the
// component sheets above happen to say about hover, selected and target states.
import './styles/select.css';

import { renderMenu } from './ui/menu.js';
import { renderGallery } from './ui/gallery.js';
import { renderBotGame } from './ui/game/botGame.js';
import { renderHotseat } from './ui/game/hotseat.js';
import { renderOnline, joinCodeFromHash } from './ui/game/online.js';
import { renderHowTo, lessonIdFromHash } from './ui/tutorial/index.js';
import { renderStory, storyBattleFromHash } from './ui/story/index.js';
import { renderTrophies } from './ui/story/trophyScreen.js';
import { renderSettings } from './ui/settingsView.js';
import { applyThemeFor } from './ui/theme.js';
import { syncAdmin } from './ui/admin.js';
import { getProfileName } from './ui/profile.js';

const routes = {
  '#/': renderMenu,
  '#/gallery': renderGallery,
  '#/howto': renderHowTo,
  '#/story': renderStory,
  '#/trophies': renderTrophies,
  '#/bot': renderBotGame,
  '#/local': renderHotseat,
  '#/online': renderOnline,
  '#/settings': renderSettings,
};

/**
 * Three routes carry a parameter: `#/join/ABC234`, the shareable match link,
 * `#/howto/<lesson>`, one tutorial battle, and `#/story/<n>`, one Story Mode
 * battle. Everything else is an exact match.
 */
function resolve(hash) {
  const joinCode = joinCodeFromHash(hash);
  if (joinCode) return (root) => renderOnline(root, { joinCode });
  const lessonId = lessonIdFromHash(hash);
  if (lessonId) return (root) => renderHowTo(root, { lessonId });
  const battleNumber = storyBattleFromHash(hash);
  if (battleNumber !== null) return (root) => renderStory(root, { battleNumber });
  return routes[hash] || renderMenu;
}

function route() {
  const root = document.getElementById('app');
  resolve(window.location.hash)(root);
  window.scrollTo(0, 0);
}

// A name that was already `n--admin` activates on load rather than needing to
// be re-typed. Before the first paint, so the granted theme is the first one
// the page shows.
syncAdmin(getProfileName());

// Paint the saved theme before the first render so nothing flashes.
applyThemeFor({});

window.addEventListener('hashchange', route);
route();
