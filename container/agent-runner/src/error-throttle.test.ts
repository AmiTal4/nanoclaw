import { describe, it, expect } from 'bun:test';

import { ErrorGate, isLimitErrorText, parseResetTimeMs } from './error-throttle.js';

describe('isLimitErrorText', () => {
  it('matches the Claude Max session-limit message', () => {
    expect(isLimitErrorText("You've hit your session limit · resets 10am (UTC)")).toBe(true);
    expect(isLimitErrorText("You've hit your session limit · resets 3:40am (UTC)")).toBe(true);
  });

  it('matches other throttle-class provider errors', () => {
    expect(isLimitErrorText('Rate limit exceeded, retry later')).toBe(true);
    expect(isLimitErrorText('529 overloaded_error: Overloaded')).toBe(true);
    expect(isLimitErrorText('Too many requests')).toBe(true);
    expect(isLimitErrorText('Monthly usage limit reached')).toBe(true);
  });

  it('does not match ordinary errors', () => {
    expect(isLimitErrorText('403 billing_error: no active subscription')).toBe(false);
    expect(isLimitErrorText('database is locked')).toBe(false);
  });
});

describe('parseResetTimeMs', () => {
  // 2026-07-12 12:30:00 UTC
  const NOW = Date.UTC(2026, 6, 12, 12, 30, 0);

  it('parses a later-today reset ("resets 3pm")', () => {
    const t = parseResetTimeMs('You’ve hit your session limit · resets 3pm (UTC)', NOW);
    expect(t).toBe(Date.UTC(2026, 6, 12, 15, 0, 0));
  });

  it('parses minutes and rolls past-time to tomorrow ("resets 3:40am")', () => {
    const t = parseResetTimeMs('You’ve hit your session limit · resets 3:40am (UTC)', NOW);
    expect(t).toBe(Date.UTC(2026, 6, 13, 3, 40, 0));
  });

  it('handles 12am / 12pm correctly', () => {
    expect(parseResetTimeMs('resets 12am (UTC)', NOW)).toBe(Date.UTC(2026, 6, 13, 0, 0, 0));
    expect(parseResetTimeMs('resets 12pm (UTC)', NOW)).toBe(Date.UTC(2026, 6, 13, 12, 0, 0));
  });

  it('returns null when no reset time is present', () => {
    expect(parseResetTimeMs('Rate limit exceeded', NOW)).toBeNull();
    expect(parseResetTimeMs('resets soon', NOW)).toBeNull();
  });
});

describe('ErrorGate', () => {
  function makeGate(startMs: number, cooldownMs = 15 * 60_000) {
    let now = startMs;
    const gate = new ErrorGate(cooldownMs, () => now);
    return { gate, advance: (ms: number) => (now += ms) };
  }

  const NOW = Date.UTC(2026, 6, 12, 12, 30, 0);

  it('posts a fresh error, suppresses the identical repeat within cooldown', () => {
    const { gate, advance } = makeGate(NOW);
    expect(gate.handle('Error: something broke').post).toBe(true);
    advance(60_000);
    expect(gate.handle('Error: something broke').post).toBe(false);
    advance(15 * 60_000);
    expect(gate.handle('Error: something broke').post).toBe(true);
  });

  it('treats all limit-class texts as one dedupe key', () => {
    const { gate, advance } = makeGate(NOW);
    expect(gate.handle("You've hit your session limit · resets 3pm (UTC)").post).toBe(true);
    advance(60_000);
    // Different wording, same condition — still suppressed.
    expect(gate.handle('Rate limit exceeded').post).toBe(false);
  });

  it('a different (non-limit) error text posts immediately', () => {
    const { gate, advance } = makeGate(NOW);
    expect(gate.handle('Error: first').post).toBe(true);
    advance(1000);
    expect(gate.handle('Error: second').post).toBe(true);
  });

  it('pauses until the parsed reset time on limit errors', () => {
    const { gate, advance } = makeGate(NOW);
    const verdict = gate.handle("You've hit your session limit · resets 3pm (UTC)");
    expect(verdict.limit).toBe(true);
    expect(gate.isPaused()).toBe(true);
    // 3pm is 2.5h away from 12:30
    expect(gate.pauseRemainingMs()).toBe(2.5 * 60 * 60_000);
    advance(2.5 * 60 * 60_000);
    expect(gate.isPaused()).toBe(false);
  });

  it('falls back to a default pause when the reset time is unparseable', () => {
    const { gate } = makeGate(NOW);
    const verdict = gate.handle('Rate limit exceeded');
    expect(verdict.limit).toBe(true);
    expect(gate.isPaused()).toBe(true);
    expect(gate.pauseRemainingMs()).toBe(15 * 60_000);
  });

  it('caps a parsed pause at 6 hours', () => {
    // 12:30 → "resets 12pm" tomorrow = 23.5h away; cap must clamp it.
    const { gate } = makeGate(NOW);
    gate.handle('You have hit your session limit · resets 12pm (UTC)');
    expect(gate.pauseRemainingMs()).toBe(6 * 60 * 60_000);
  });

  it('non-limit errors never pause', () => {
    const { gate } = makeGate(NOW);
    gate.handle('Error: something broke');
    expect(gate.isPaused()).toBe(false);
  });

  describe('auth-class errors', () => {
    it('pauses for an hour — only an operator can renew a vaulted credential', () => {
      const { gate, advance } = makeGate(NOW);
      const verdict = gate.handle('Reconnecting... 2/5: Read-only file system (os error 30)', true);
      expect(verdict.auth).toBe(true);
      expect(gate.isPaused()).toBe(true);
      expect(gate.pauseRemainingMs()).toBe(60 * 60_000);
      advance(60 * 60_000);
      expect(gate.isPaused()).toBe(false);
    });

    it('dedupes across differing texts — one dead credential is one incident', () => {
      const { gate } = makeGate(NOW);
      expect(gate.handle('401 Unauthorized', true).post).toBe(true);
      // Codex words the same expiry differently on nearly every turn.
      expect(gate.handle('Read-only file system (os error 30)', true).post).toBe(false);
      expect(gate.handle('token_expired', true).post).toBe(false);
    });

    it('re-posts once the cooldown has elapsed', () => {
      const { gate, advance } = makeGate(NOW);
      expect(gate.handle('401 Unauthorized', true).post).toBe(true);
      advance(15 * 60_000);
      expect(gate.handle('401 Unauthorized', true).post).toBe(true);
    });

    it('keeps auth and limit classes in separate dedupe buckets', () => {
      const { gate } = makeGate(NOW);
      expect(gate.handle('401 Unauthorized', true).post).toBe(true);
      // Different operator action — must not be swallowed as a repeat.
      expect(gate.handle("You've hit your session limit · resets 3pm (UTC)").post).toBe(true);
    });

    it('classifies as auth when the caller says so, even if the text reads like a limit', () => {
      const { gate } = makeGate(NOW);
      const verdict = gate.handle('rate limit exceeded (401 token_expired)', true);
      expect(verdict.auth).toBe(true);
      expect(verdict.limit).toBe(true);
      // Auth wins the dedupe key, so a following auth error is suppressed.
      expect(gate.handle('a totally different auth error', true).post).toBe(false);
    });

    it('leaves ordinary errors unclassified', () => {
      const { gate } = makeGate(NOW);
      const verdict = gate.handle('Error: something broke');
      expect(verdict.auth).toBe(false);
      expect(gate.isPaused()).toBe(false);
    });

    it('reports the pause cause so the loop logs the right operator action', () => {
      const { gate, advance } = makeGate(NOW);
      gate.handle("You've hit your session limit · resets 3pm (UTC)");
      expect(gate.pauseReason()).toBe('limit');

      // The 2.5h limit pause outlasts the 1h auth pause, but the credential
      // is still the thing a human has to fix — so it names the cause.
      gate.handle('401 Unauthorized', true);
      expect(gate.pauseReason()).toBe('auth');

      // Once the auth window lapses and only the limit pause remains, the
      // label goes back to the limit.
      advance(60 * 60_000);
      expect(gate.isPaused()).toBe(true);
      expect(gate.pauseReason()).toBe('limit');
    });

    it('keeps the auth cause when a shorter limit pause follows', () => {
      const { gate } = makeGate(NOW);
      gate.handle('401 Unauthorized', true);
      // 15-min default limit pause cannot shorten or relabel the 1h auth pause.
      gate.handle('Rate limit exceeded');
      expect(gate.pauseReason()).toBe('auth');
      expect(gate.pauseRemainingMs()).toBe(60 * 60_000);
    });
  });
});
