/**
 * CodexProvider.isAuthFailure — the classifier that decides whether a failed
 * turn means "the vaulted OpenAI credential is dead".
 *
 * The strings below are verbatim from the 2026-08-01 expiry: the operator saw
 * only the read-only variant, because Codex answers a 401 by trying to refresh
 * into the read-only OneCLI auth stub and then reports the write failure
 * instead of the 401 that caused it.
 */
import { describe, expect, it } from 'bun:test';

import { CodexProvider } from './codex.js';

const provider = new CodexProvider();

describe('CodexProvider.isAuthFailure', () => {
  it('matches the read-only refresh failure the operator actually sees', () => {
    expect(provider.isAuthFailure(new Error('Reconnecting... 2/5: Read-only file system (os error 30)'))).toBe(true);
    expect(provider.isAuthFailure(new Error('startup websocket prewarm setup failed: Read-only file system (os error 30)'))).toBe(true);
  });

  it('matches the underlying 401 when it survives to the runner', () => {
    expect(
      provider.isAuthFailure(new Error('Provided authentication token is expired. Please try signing in again.')),
    ).toBe(true);
    expect(provider.isAuthFailure(new Error('auth error code: token_expired'))).toBe(true);
    expect(provider.isAuthFailure(new Error('failed to connect to websocket: HTTP error: 401 Unauthorized'))).toBe(true);
  });

  it('matches a revoked session (refresh-token reuse detection)', () => {
    expect(provider.isAuthFailure(new Error('token_invalidated'))).toBe(true);
  });

  it('accepts non-Error values', () => {
    expect(provider.isAuthFailure('token_expired')).toBe(true);
    expect(provider.isAuthFailure(undefined)).toBe(false);
  });

  it('does not claim ordinary failures', () => {
    expect(provider.isAuthFailure(new Error('database is locked'))).toBe(false);
    expect(provider.isAuthFailure(new Error('turn timed out after 10 minutes'))).toBe(false);
    expect(provider.isAuthFailure(new Error('ENOENT: no such file or directory'))).toBe(false);
    // A throttle is not an auth failure — different operator action entirely.
    expect(provider.isAuthFailure(new Error("You've hit your session limit · resets 3pm (UTC)"))).toBe(false);
  });

  describe('read-only failures unrelated to credentials', () => {
    // Several container paths are read-only BY DESIGN, so EROFS on its own
    // says nothing about the credential. Misreading one is expensive: it
    // silences the agent for an hour and tells the operator to delete a
    // healthy secret.
    it('ignores an agent write to a deliberately read-only path', () => {
      expect(
        provider.isAuthFailure(new Error('failed to write /workspace/agent/AGENTS.md: Read-only file system (os error 30)')),
      ).toBe(false);
      expect(
        provider.isAuthFailure(new Error('apply_patch failed: /workspace/agent/container.json: Read-only file system')),
      ).toBe(false);
      expect(
        provider.isAuthFailure(new Error('cannot append to /workspace/agent/activity-log.md (os error 30)')),
      ).toBe(false);
      expect(provider.isAuthFailure(new Error('EROFS: read-only file system, open /app/skills/x'))).toBe(false);
    });

    it('still catches the read-only failure that IS a credential refresh', () => {
      // Both observed forms carry connection/auth context; a tool-side write
      // failure names a path instead.
      expect(provider.isAuthFailure(new Error('Reconnecting... 2/5: Read-only file system (os error 30)'))).toBe(true);
      expect(
        provider.isAuthFailure(new Error('startup websocket prewarm setup failed: Read-only file system (os error 30)')),
      ).toBe(true);
      expect(
        provider.isAuthFailure(new Error('failed to persist refreshed token: Read-only file system (os error 30)')),
      ).toBe(true);
    });
  });
});
