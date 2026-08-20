/**
 * How to Play — the lesson picker and the tutorial-battle runner.
 *
 * Routes:
 *   #/howto          the five lesson boxes
 *   #/howto/<id>     one tutorial battle
 *
 * All five are unlocked from the start. Gating lesson 3 behind lesson 2 would
 * only punish the player who already knows how fusion works and came for the
 * strategy one.
 *
 * A tutorial battle is a completely ordinary match — the real engine, the real
 * bot, the real board — with two differences: the position is authored rather
 * than dealt (scenario.js), and a coach panel sits over it (coach.js). Nothing
 * is locked; the coach watches and waits.
 */
import { LESSONS, getLesson } from './lessons.js';
import { buildScenario } from './scenario.js';
import { mountCoach } from './coach.js';
import { createController } from '../game/controller.js';
import { mountBoard } from '../game/board.js';
import { applyThemeFor } from '../theme.js';

const HUMAN = 0;
const BOT = 1;

let teardown = null;

function cleanup() {
  if (teardown) {
    teardown();
    teardown = null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** `#/howto/basics` -> 'basics'. Returns null for the picker route. */
export function lessonIdFromHash(hash) {
  const match = /^#\/howto\/([a-z0-9-]+)$/i.exec(hash || '');
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ *
 * The picker
 * ------------------------------------------------------------------ */

function renderPicker(root) {
  root.innerHTML = '';

  const topbar = el('div', 'topbar');
  const back = el('button', 'btn btn--ghost', '← Menu');
  back.type = 'button';
  back.addEventListener('click', () => {
    window.location.hash = '#/';
  });
  topbar.appendChild(back);
  const titles = el('div');
  titles.appendChild(el('h1', 'topbar__title', 'How to Play'));
  titles.appendChild(
    el('div', 'topbar__sub', 'Five guided battles. Start anywhere — they are all unlocked.')
  );
  topbar.appendChild(titles);
  root.appendChild(topbar);

  const wrap = el('section', 'setup');
  wrap.appendChild(
    el(
      'p',
      'setup__note',
      'Each lesson drops you into a real match on a board built for the point it is making. ' +
        'The coach along the bottom talks you through it and waits for you to play — nothing is locked, ' +
        'nothing is on rails, and you can collapse the coach to a single line or leave any time.'
    )
  );

  const row = el('div', 'lesson-grid');
  for (const lesson of LESSONS) {
    const node = el('button', 'setup-card lesson-card');
    node.type = 'button';
    node.dataset.lesson = lesson.id;
    node.appendChild(el('span', 'lesson-card__number', String(lesson.number)));
    node.appendChild(el('span', 'setup-card__icon', lesson.icon));
    node.appendChild(el('span', 'setup-card__title', lesson.title));
    node.appendChild(el('span', 'setup-card__desc', lesson.summary));
    node.appendChild(
      el('span', 'setup-card__tag', `${lesson.steps.length} steps · about ${lesson.minutes} min`)
    );
    node.addEventListener('click', () => {
      window.location.hash = `#/howto/${lesson.id}`;
    });
    row.appendChild(node);
  }
  wrap.appendChild(row);
  root.appendChild(wrap);
}

/* ------------------------------------------------------------------ *
 * One tutorial battle
 * ------------------------------------------------------------------ */

function startLesson(root, lesson) {
  cleanup();
  root.innerHTML = '';

  const spec = lesson.scenario;
  applyThemeFor({ deckId: spec.players[HUMAN].deckId });

  const state = buildScenario(spec);
  const controller = createController({
    state,
    botPlayer: BOT,
    difficulty: spec.players[BOT].difficulty ?? 'easy',
    playstyle: spec.players[BOT].playstyle ?? 'normal',
    botSeed: (spec.seed ?? 1) + 977,
  });

  const goPicker = () => {
    window.location.hash = '#/howto';
  };
  const next = LESSONS[LESSONS.indexOf(lesson) + 1] ?? null;

  const unmountBoard = mountBoard(root, {
    controller,
    viewer: HUMAN,
    title: `How to Play · ${lesson.title}`,
    subtitle: `Lesson ${lesson.number} of ${LESSONS.length} — ${lesson.summary}`,
    onExit: goPicker,
    // Replaying a scripted board from the start is exactly what "again" should
    // mean here, so the rematch button rebuilds the lesson rather than
    // reshuffling it into a different position.
    onRematch: () => startLesson(root, lesson),
  });

  const unmountCoach = mountCoach(root, {
    lesson,
    controller,
    onExit: goPicker,
    onNextLesson: next
      ? () => {
          window.location.hash = `#/howto/${next.id}`;
        }
      : null,
  });

  // No controller.start() here: mountBoard already does it, and the coach is
  // mounted after the board precisely so its first render sees a live state.
  teardown = () => {
    unmountCoach();
    controller.destroy();
    unmountBoard();
  };
}

/* ------------------------------------------------------------------ *
 * Route entry
 * ------------------------------------------------------------------ */

export function renderHowTo(root, { lessonId = null } = {}) {
  cleanup();
  if (!lessonId) {
    renderPicker(root);
    return;
  }
  const lesson = getLesson(lessonId);
  if (!lesson) {
    // An unknown id is a stale bookmark, not an error worth a screen.
    window.location.hash = '#/howto';
    return;
  }
  startLesson(root, lesson);
}
