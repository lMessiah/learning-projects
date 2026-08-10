/**
 * @vitest-environment jsdom
 *
 * A full match through the real board UI against the Medium bot.
 *
 * One difficulty per file on purpose. Each match drives hundreds of actions
 * and rebuilds the whole board every time, so a single run peaks at a few
 * hundred MB of jsdom heap; vitest isolates per file, so this is what keeps
 * each worker's peak well clear of the limit. See tests/support/fullMatch.js.
 */
import { describe, it } from 'vitest';
import { useBoardHarness, expectDecisiveMatch } from './support/fullMatch.js';

useBoardHarness();

describe('a full match through the UI', () => {
  it('reaches a decisive result against the Medium bot with no errors', () => {
    expectDecisiveMatch('medium');
  });
});
