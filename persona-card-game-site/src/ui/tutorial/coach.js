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
 * every state change, so the ring is re-applied after each one.
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

const POINT_CLASS = 'coach-point';

export function mountCoach(host, { lesson, controller, onExit, onNextLesson }) {
  let index = 0;
  let frame = null;
  let destroyed = false;

  const panel = el('aside', 'coach');
  host.appendChild(panel);
  // The board is a fixed-viewport grid with no spare room, so it shrinks by the
  // height of this bar rather than being covered by it. See .coach in board.css.
  document.body.classList.add('coach-active');

  const steps = lesson.steps;
  const current = () => steps[index];

  /** Draw the ring on whatever the current step is pointing at. */
  function repoint() {
    for (const node of document.querySelectorAll(`.${POINT_CLASS}`)) node.classList.remove(POINT_CLASS);
    const step = current();
    if (!step?.point) return;
    // A step may point at something that is not on screen yet — that is normal
    // while the player is still doing something else, not an error.
    document.querySelector(step.point)?.classList.add(POINT_CLASS);
  }

  /** Re-apply the ring after the board has finished re-rendering. */
  function repointSoon() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      frame = null;
      if (!destroyed) repoint();
    });
  }

  function advance() {
    if (index >= steps.length) return;
    index += 1;
    render();
  }

  // The board as it was when the current step opened. Objectives are very often
  // relative — "the enemy has taken more damage", "you have ended a turn" — and
  // comparing against a captured baseline is far more robust than trying to
  // write an absolute predicate for every position the player could be in.
  let stepStart = null;

  /** A `do` step finishes itself the moment the board satisfies it. */
  function checkObjective(state) {
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

  function renderFinished() {
    panel.className = 'coach coach--done';
    panel.innerHTML = '';
    panel.appendChild(el('div', 'coach__eyebrow', 'Lesson complete'));
    panel.appendChild(el('h3', 'coach__title', lesson.title));
    richText(panel.appendChild(el('p', 'coach__body')), lesson.outro);

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
    panel.appendChild(row);

    const note = el('p', 'coach__note');
    richText(note, 'The board is still live — stay and play it out, or head back.');
    panel.appendChild(note);
    repoint();
  }

  function render() {
    if (destroyed) return;
    if (index >= steps.length) return renderFinished();

    const step = current();
    stepStart = controller.getState();
    panel.className = `coach${step.until ? ' coach--objective' : ''}`;
    panel.innerHTML = '';

    panel.appendChild(
      el('div', 'coach__eyebrow', `${lesson.title} · step ${index + 1} of ${steps.length}`)
    );
    if (step.title) panel.appendChild(el('h3', 'coach__title', step.title));
    richText(panel.appendChild(el('p', 'coach__body')), step.say ?? step.do);

    if (step.until) {
      const objective = el('div', 'coach__objective');
      objective.appendChild(el('span', 'coach__objective-dot', '◆'));
      richText(objective.appendChild(el('span', null)), step.hint ?? 'Your move.');
      panel.appendChild(objective);
      // No Next button: this step is finished by playing, not by clicking. But
      // an escape hatch is essential — if a player wanders into a position the
      // objective can no longer be met from, the lesson must not trap them.
      const skip = el('button', 'btn btn--ghost btn--small', 'Skip this step');
      skip.type = 'button';
      skip.addEventListener('click', advance);
      panel.appendChild(skip);
    } else {
      const row = el('div', 'coach__row');
      const next = el('button', 'btn btn--primary', index === steps.length - 1 ? 'Finish ▸' : 'Next ▸');
      next.type = 'button';
      next.addEventListener('click', advance);
      row.appendChild(next);
      panel.appendChild(row);
    }

    const quit = el('button', 'coach__quit', '✕');
    quit.type = 'button';
    quit.title = 'Leave the lesson';
    quit.addEventListener('click', onExit);
    panel.appendChild(quit);

    repointSoon();
    // A `do` step whose objective is ALREADY satisfied should not sit there
    // asking for something that has happened. This is the common case after a
    // say-step that describes a board the player is already looking at.
    checkObjective(controller.getState());
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
