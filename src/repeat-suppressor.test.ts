import { describe, it, expect, beforeEach } from 'vitest';

import { shouldSuppressRepeat, resetRepeatSuppressor } from './repeat-suppressor.js';

describe('repeat suppressor (outbound flood cap)', () => {
  const NOW = 1_783_900_000_000;

  beforeEach(() => {
    resetRepeatSuppressor();
  });

  it('allows the first three identical sends, suppresses the fourth onward', () => {
    const text = "You've hit your session limit · resets 10am (UTC)";
    expect(shouldSuppressRepeat('s1', text, NOW)).toBe(false);
    expect(shouldSuppressRepeat('s1', text, NOW + 1000)).toBe(false);
    expect(shouldSuppressRepeat('s1', text, NOW + 2000)).toBe(false);
    expect(shouldSuppressRepeat('s1', text, NOW + 3000)).toBe(true);
    expect(shouldSuppressRepeat('s1', text, NOW + 4000)).toBe(true);
  });

  it('a different text resets the run', () => {
    expect(shouldSuppressRepeat('s1', 'a', NOW)).toBe(false);
    expect(shouldSuppressRepeat('s1', 'a', NOW + 1)).toBe(false);
    expect(shouldSuppressRepeat('s1', 'a', NOW + 2)).toBe(false);
    expect(shouldSuppressRepeat('s1', 'b', NOW + 3)).toBe(false);
    // Run restarted: 'a' gets a fresh budget.
    expect(shouldSuppressRepeat('s1', 'a', NOW + 4)).toBe(false);
  });

  it('sessions are independent', () => {
    const text = 'same text';
    for (let i = 0; i < 3; i++) shouldSuppressRepeat('s1', text, NOW + i);
    expect(shouldSuppressRepeat('s1', text, NOW + 3)).toBe(true);
    expect(shouldSuppressRepeat('s2', text, NOW + 3)).toBe(false);
  });

  it('the window expiring forgives the run', () => {
    const text = 'same text';
    for (let i = 0; i < 4; i++) shouldSuppressRepeat('s1', text, NOW + i);
    expect(shouldSuppressRepeat('s1', text, NOW + 11 * 60_000)).toBe(false);
  });
});
