/**
 * The coach — the box that talks you through a tutorial battle.
 *
 * It sits over a completely ordinary board. It does not gate clicks, disable
 * controls, or apply actions on your behalf: you can ignore every word of it
 * and play the position however you like. What it does is watch the state and
 * move on when the thing it asked for has happened.
 *
 * That is a deliberate choice over an on-rails script. A script that only
 * enables the one correct button teaches the sequence rather than the reason,
 * breaks whenever a rule is retuned, and feels like a slideshow. Watching the
 * state instead means the lesson survives the player doing something else
 * first, and it survives the balance changing underneath it.
 *
 * Two kinds of step:
 *
 *   { say }  — a paragraph. Advances when the player clicks Next.
 *   { do }   — an objective. Advances by itself when `until(state)` is true.
 *
 * A `do` step may name a `point`: a CSS selector for the control it is talking
 * about, which gets a ring drawn round it. The board re-renders from scratch on
 * every state change, so the ring is re-applied after each one — and if the ring
 * lands somewhere the coach is covering, the page is nudged until it is not.
 *
 * The panel is appended to the layout rather than laid over it: see .coach in
 * board.css for why, and `collapsed` below for the one-tap escape when even an
 * appended bar is one thing too many on a phone.
 */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Minimal inline formatting so lesson text stays readable in source:
 * `**bold**` and nothing else. Deliberately not a markdown parser — the day
 * this needs tables is the day the lesson is too long.
 */
function richText(parent, text) {
  for (const [i, chunk] of text.split('**').entries()) {
    if (!chunk) continue;
    parent.appendChild(i % 2 ? el('strong', null, chunk) : document.createTextNode(chunk));
  }
  return parent;
}

/** The same text with the marks dropped, for the one-line collapsed summary. */
function plainText(text) {
  return String(text ?? '').split('**').join('').split('\n')[0].trim();
}

const POINT_CLASS = 'coach-point';
const COLLAPSE_KEY = 'pcg.howto.collapsed';

/* Collapsed-or-not is a preference about screen space, not a fact about the
 * lesson, so it outlives the panel: someone on a small phone should collapse it
 * once, not once per step and again in every lesson after this one. */
function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false; // storage blocked (private mode) — start open, same as default
  }
}

function writeCollapsed(value) {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function prefersReducedMotion() {
  return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches);
}

export function mountCoach(host, { lesson, controller, onExit, onNextLesson }) {
  let index = 0;
  let frame = null;
  let destroyed = false;
  let collapsed = readCollapsed();

  const panel = el('aside', 'coach');
  host.appendChild(panel);
  // The coach is a sibling of the board in the same column, not a sheet over
  // it: the body class is what switches the page into that two-part layout.
  // See .coach in board.css.
  document.body.classList.add('coach-active');

  const steps = lesson.steps;
  const current = () => steps[index];
  const finished = () => index >= steps.length;

  /* ---------------------------------------------------------------- *
   * Pointing at things
   * ---------------------------------------------------------------- */

  // Which selector the ring is currently for. Used to scroll a target into
  // view exactly once — on every board re-render would fight the player.
  let pointedAt = null;

  /**
   * The coach is pinned to the bottom of the viewport, so on a short screen the
   * control a step is pointing at can end up behind it — which is precisely the
   * complaint that a bar you cannot move produces. Scroll it clear instead.
   */
  function bringIntoView(node) {
    if (typeof node.scrollIntoView !== 'function') return;
    const target = node.getBoundingClientRect?.();
    const bar = panel.getBoundingClientRect?.();
    // jsdom (and a node that has not been laid out yet) reports all zeroes;
    // there is nothing to scroll to in that case.
    if (!target || !bar || (!target.height && !target.width)) return;
    if (target.top >= 0 && target.bottom <= bar.top) return;
    node.scrollIntoView({
      block: 'center',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }

  /** Draw the ring on whatever the current step is pointing at. */
  function repoint() {
    for (const node of document.querySelectorAll(`.${POINT_CLASS}`)) node.classList.remove(POINT_CLASS);
    const step = finished() ? null : current();
    const selector = step?.point ?? null;
    if (!selector) {
      pointedAt = null;
      return;
    }
    // A step may point at something that is not on screen yet — that is normal
    // while the player is still doing something else, not an error. Leaving
    // `pointedAt` alone means it still gets scrolled to when it does appear.
    const node = document.querySelector(selector);
    if (!node) return;
    node.classList.add(POINT_CLASS);
    if (selector === pointedAt) return;
    pointedAt = selector;
    bringIntoView(node);
  }

  /** Re-apply the ring after the board has finished re-rendering. */
  function repointSoon() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!destroyed) repoint();
    });
  }

  /* ---------------------------------------------------------------- *
   * Stepping
   * ---------------------------------------------------------------- */

  function advance() {
    if (finished()) return;
    index += 1;
    render();
  }

  function setCollapsed(next) {
    collapsed = next;
    writeCollapsed(next);
    render();
  }

  // The board as it was when the current step opened. Objectives are very often
  // relative — "the enemy has taken more damage", "you have ended a turn" — and
  // comparing against a captured baseline is far more robust than trying to
  // write an absolute predicate for every position the player could be in.
  let stepStart = null;
  // Which step that baseline belongs to. render() runs for collapsing and
  // expanding too, and re-baselining there would quietly move the goalposts
  // under a half-finished objective.
  let stepStartIndex = -1;

  /** A `do` step finishes itself the moment the board satisfies it. */
  function checkObjective(state) {
    if (finished()) return;
    const step = current();
    if (!step || !step.until) return;
    let done = false;
    try {
      done = Boolean(step.until(state, stepStart ?? state));
    } catch {
      // A predicate that throws on an unexpected board must not wedge the
      // lesson — leave the step up and let the player carry on.
      done = false;
    }
    if (done) advance();
  }

  /* ---------------------------------------------------------------- *
   * Drawing
   * ---------------------------------------------------------------- */

  const eyebrowText = () =>
    finished() ? 'Lesson complete' : `${lesson.title} · step ${index + 1} of ${steps.length}`;

  /** The one line that survives collapsing: what the player is meant to do. */
  function peekText() {
    if (finished()) return lesson.title;
    const step = current();
    if (step.until) return plainText(step.hint ?? 'Your move.');
    return step.title ?? plainText(step.say ?? step.do ?? '');
  }

  /** The buttons for the current step — shown in the bar when collapsed. */
  function buildActions() {
    if (finished()) {
      const row = el('div', 'coach__row');
      if (onNextLesson) {
        const next = el('button', 'btn btn--primary', 'Next lesson ▸');
        next.type = 'button';
        next.addEventListener('click', onNextLesson);
        row.appendChild(next);
      }
      const back = el('button', 'btn btn--ghost', '← All lessons');
      back.type = 'button';
      back.addEventListener('click', onExit);
      row.appendChild(back);
      return row;
    }

    const row = el('div', 'coach__row');
    if (current().until) {
      // No Next button: this step is finished by playing, not by clicking. But
      // an escape hatch is essential — if a player wanders into a position the
      // objective can no longer be met from, the lesson must not trap them.
      const skip = el('button', 'btn btn--ghost btn--small', 'Skip this step');
      skip.type = 'button';
      skip.addEventListener('click', advance);
      row.appendChild(skip);
    } else {
      const next = el('button', 'btn btn--primary', index === steps.length - 1 ? 'Finish ▸' : 'Next ▸');
      next.type = 'button';
      next.addEventListener('click', advance);
      row.appendChild(next);
    }
    return row;
  }

  /**
   * The header strip. Always visible, collapsed or not, and when collapsed it
   * carries the whole coach: where you are, what to do, and the button to do it
   * with — so collapsing costs the player nothing but the prose.
   */
  function buildBar(actions) {
    const bar = el('div', 'coach__bar');

    const toggle = el('button', 'coach__toggle', collapsed ? '▴' : '▾');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.title = collapsed ? 'Show the lesson text' : 'Collapse the lesson text';
    toggle.setAttribute('aria-label', toggle.title);
    toggle.addEventListener('click', () => setCollapsed(!collapsed));
    bar.appendChild(toggle);

    bar.appendChild(el('div', 'coach__eyebrow', eyebrowText()));
    if (collapsed) {
      bar.appendChild(el('div', 'coach__peek', peekText()));
      bar.appendChild(actions);
    }

    const quit = el('button', 'coach__quit', '✕');
    quit.type = 'button';
    quit.title = 'Leave the lesson';
    quit.setAttribute('aria-label', quit.title);
    quit.addEventListener('click', onExit);
    bar.appendChild(quit);

    return bar;
  }

  /** Everything below the header: the prose, and what to do about it. */
  function buildBody(actions) {
    const body = el('div', 'coach__panel');

    const prose = el('div', 'coach__prose');
    if (finished()) {
      prose.appendChild(el('h3', 'coach__title', lesson.title));
      richText(prose.appendChild(el('p', 'coach__body')), lesson.outro);
    } else {
      const step = current();
      if (step.title) prose.appendChild(el('h3', 'coach__title', step.title));
      richText(prose.appendChild(el('p', 'coach__body')), step.say ?? step.do);
    }
    body.appendChild(prose);

    const side = el('div', 'coach__side');
    if (!finished() && current().until) {
      const objective = el('div', 'coach__objective');
      objective.appendChild(el('span', 'coach__objective-dot', '◆'));
      richText(objective.appendChild(el('span', null)), current().hint ?? 'Your move.');
      side.appendChild(objective);
    }
    side.appendChild(actions);
    if (finished()) {
      const note = el('p', 'coach__note');
      richText(note, 'The board is still live — stay and play it out, or head back.');
      side.appendChild(note);
    }
    body.appendChild(side);

    return body;
  }

  function render() {
    if (destroyed) return;
    const done = finished();
    if (!done && stepStartIndex !== index) {
      stepStart = controller.getState();
      stepStartIndex = index;
    }

    const kind = done ? ' coach--done' : current().until ? ' coach--objective' : '';
    panel.className = `coach${kind}${collapsed ? ' coach--collapsed' : ''}`;
    panel.innerHTML = '';

    // Built once and handed to whichever half is showing it — the bar when the
    // panel is collapsed away, the panel itself otherwise.
    const actions = buildActions();
    panel.appendChild(buildBar(actions));
    if (!collapsed) panel.appendChild(buildBody(actions));

    repointSoon();
    // A `do` step whose objective is ALREADY satisfied should not sit there
    // asking for something that has happened. This is the common case after a
    // say-step that describes a board the player is already looking at.
    if (!done) checkObjective(controller.getState());
  }

  const unsubscribe = controller.subscribe((state) => {
    checkObjective(state);
    repointSoon();
  });

  render();

  return () => {
    destroyed = true;
    unsubscribe();
    if (frame !== null) cancelAnimationFrame(frame);
    for (const node of document.querySelectorAll(`.${POINT_CLASS}`)) node.classList.remove(POINT_CLASS);
    document.body.classList.remove('coach-active');
    panel.remove();
  };
}
