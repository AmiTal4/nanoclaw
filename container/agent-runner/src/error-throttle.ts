/**
 * Error-post throttling + provider-limit backoff for the poll loop.
 *
 * Motivation (2026-07-12 #dev flood): a rate-limited turn used to emit a
 * user-facing error post per batch, with no dedupe or cooldown. Two live
 * agents in one channel then fed each other's error posts — ~2,700
 * "You've hit your session limit" messages in one day, plus one API call
 * per attempt against a provider that was already refusing turns.
 *
 * The gate enforces two rules:
 *
 * 1. **Post an error once, not per batch.** Identical error text (and any
 *    limit-class error, regardless of exact wording) is delivered to the
 *    channel at most once per cooldown window.
 * 2. **Sleep through provider limits.** A limit-class error pauses the
 *    poll loop until the stated reset time ("resets 10am (UTC)") when
 *    parseable, or a default backoff when not. Messages stay pending and
 *    are processed when the window reopens.
 */

const DEFAULT_POST_COOLDOWN_MS = 15 * 60_000;
const DEFAULT_PAUSE_MS = 15 * 60_000;
/**
 * Upper bound on a parsed pause. Claude Max session windows are 5h, so a
 * legitimate "resets …" time is always closer than this; anything longer
 * means we misparsed and should not silence the agent for it.
 */
const MAX_PAUSE_MS = 6 * 60 * 60_000;

/** Provider errors that mean "stop trying — the account/session is throttled". */
export function isLimitErrorText(text: string): boolean {
  return /session limit|usage limit|rate.?limit|overloaded|too many requests|quota exceeded|hit your limit/i.test(text);
}

/**
 * Parse "resets 3:40am (UTC)" / "resets 10am (UTC)" out of a limit error
 * and return the epoch ms of the next occurrence of that wall-clock time
 * in UTC. Returns null when no reset time is present.
 */
export function parseResetTimeMs(text: string, nowMs: number): number | null {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!m) return null;

  let hour = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  const meridiem = m[3].toLowerCase();
  if (hour < 1 || hour > 12 || minute > 59) return null;
  if (meridiem === 'pm' && hour !== 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;

  const now = new Date(nowMs);
  const candidate = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute, 0, 0);
  return candidate > nowMs ? candidate : candidate + 24 * 60 * 60_000;
}

export interface ErrorVerdict {
  /** Deliver this error text to the channel? */
  post: boolean;
  /** Was this a limit-class error (poll loop should pause + abort the stream)? */
  limit: boolean;
}

export class ErrorGate {
  private pausedUntil = 0;
  private lastPostKey = '';
  private lastPostAt = 0;

  constructor(
    private readonly postCooldownMs: number = DEFAULT_POST_COOLDOWN_MS,
    private readonly now: () => number = Date.now,
  ) {}

  isPaused(): boolean {
    return this.now() < this.pausedUntil;
  }

  pauseRemainingMs(): number {
    return Math.max(0, this.pausedUntil - this.now());
  }

  /**
   * Record an error-turn outcome and decide what to do with it.
   * Limit-class errors extend the pause window; repeated errors (same text,
   * or any two limit-class texts) within the cooldown are not re-posted.
   */
  handle(text: string): ErrorVerdict {
    const nowMs = this.now();
    const limit = isLimitErrorText(text);

    if (limit) {
      const reset = parseResetTimeMs(text, nowMs);
      const until = reset !== null ? Math.min(reset, nowMs + MAX_PAUSE_MS) : nowMs + DEFAULT_PAUSE_MS;
      this.pausedUntil = Math.max(this.pausedUntil, until);
    }

    // All limit-class errors share one dedupe key: "resets 10am" vs
    // "resets 3:40am" are the same condition and the channel only needs to
    // hear about it once per window.
    const key = limit ? '__limit__' : text.trim();
    const post = key !== this.lastPostKey || nowMs - this.lastPostAt >= this.postCooldownMs;
    if (post) {
      this.lastPostKey = key;
      this.lastPostAt = nowMs;
    }
    return { post, limit };
  }
}
