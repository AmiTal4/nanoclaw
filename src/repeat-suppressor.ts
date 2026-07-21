/**
 * Last-line defense against outbound message floods (2026-07-12 incident:
 * two rate-limited agents fed each other's "session limit" error posts,
 * ~2,700 identical messages delivered to one Slack channel in a day).
 *
 * The container-side fixes (error cooldown, accumulate gate, no errors over
 * a2a) should make this unreachable — this exists so the *next* loop bug,
 * whatever it is, gets capped at the host before it reaches a platform.
 *
 * Policy: a session may deliver the same text up to REPEAT_LIMIT times
 * within WINDOW_MS; further identical sends are suppressed (marked
 * delivered, logged, never sent to the adapter). Any different text resets
 * the run. State is in-memory — a host restart forgives everything.
 */

const REPEAT_LIMIT = 3;
const WINDOW_MS = 10 * 60_000;

interface RepeatRun {
  text: string;
  count: number;
  firstAt: number;
}

const runs = new Map<string, RepeatRun>();

/**
 * Record an outbound text for a session and decide whether it should be
 * suppressed as part of an identical-message flood.
 */
export function shouldSuppressRepeat(sessionId: string, text: string, nowMs: number = Date.now()): boolean {
  const run = runs.get(sessionId);
  if (!run || run.text !== text || nowMs - run.firstAt > WINDOW_MS) {
    runs.set(sessionId, { text, count: 1, firstAt: nowMs });
    return false;
  }
  run.count++;
  return run.count > REPEAT_LIMIT;
}

/** Test hook. */
export function resetRepeatSuppressor(): void {
  runs.clear();
}
