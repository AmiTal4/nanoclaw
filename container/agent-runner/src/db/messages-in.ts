/**
 * Legacy runner-facing inbound API, backed by the registered mailbox.
 */
import { getConfig } from '../config.js';
import { getAgentMailbox } from '../mailbox/index.js';
// Fork-local readers below (pull history mode, channel history) read the
// inbound SQLite file directly rather than through the mailbox seam: both are
// SQLite-shaped queries the seam does not expose.
import { getOutboundDb, openInboundDb } from '../mailbox/sqlite/connection.js';
import type { InboundMessage } from '../mailbox/types.js';

export interface MessageInRow {
  id: string;
  seq: number | null;
  kind: InboundMessage['kind'];
  timestamp: string;
  status: string;
  process_after: string | null;
  recurrence: string | null;
  series_id: string | null;
  tries: number;
  /** 1 = wake-eligible (default); 0 = accumulated context only */
  trigger: number;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
  source_session_id: string | null;
  on_wake: number;
}

function messageRow(message: InboundMessage): MessageInRow {
  return {
    id: message.id,
    seq: message.sequence,
    kind: message.kind,
    timestamp: message.timestamp,
    status: message.status,
    process_after: message.processAfter,
    recurrence: message.recurrence,
    series_id: message.seriesId,
    tries: message.tries,
    trigger: message.trigger ? 1 : 0,
    platform_id: message.platformId,
    channel_type: message.channelType,
    thread_id: message.threadId,
    content: message.content,
    source_session_id: message.sourceSessionId,
    on_wake: message.onWake ? 1 : 0,
  };
}

export function getMessageInBySeq(seq: number): MessageInRow | undefined {
  const inbound = openInboundDb();
  try {
    return inbound.prepare('SELECT * FROM messages_in WHERE seq = ?').get(seq) as MessageInRow | undefined;
  } finally {
    inbound.close();
  }
}

// Cap on how many messages reach the agent in one prompt. Read from
// container.json; falls back to 10.
function getMaxMessagesPerPrompt(): number {
  try {
    return getConfig().maxMessagesPerPrompt;
  } catch {
    // Config not loaded yet (e.g. test harness) — use default
    return 10;
  }
}

function getHistoryMode(): 'push' | 'pull' {
  try {
    return getConfig().historyMode;
  } catch {
    return 'push';
  }
}

/** Ack accumulated context without deleting it from the inbound history mirror. */
function ackContextRows(): void {
  const inbound = openInboundDb();
  let rows: Array<{ id: string }>;
  try {
    rows = inbound.prepare("SELECT id FROM messages_in WHERE status = 'pending' AND trigger = 0").all() as Array<{
      id: string;
    }>;
  } finally {
    inbound.close();
  }
  if (rows.length === 0) return;
  const acked = new Set(
    (getOutboundDb().prepare('SELECT message_id FROM processing_ack').all() as Array<{ message_id: string }>).map(
      (row) => row.message_id,
    ),
  );
  markCompleted(rows.map((row) => row.id).filter((id) => !acked.has(id)));
}

/**
 * Fetch pending messages that are due for processing.
 * Fetch pending messages while excluding work already claimed by this runner.
 *
 * Selection is two-phase so accumulated context can never crowd a wake row
 * out of the batch: all due trigger=1 rows come first (oldest-first, up to
 * `maxMessagesPerPrompt`), then remaining slots fill with the NEWEST due
 * trigger=0 rows. Without this, ≥cap accumulated context rows (e.g.
 * non-engaged group messages) newer than a due task row would push the task
 * itself out of the batch. The combined batch is returned in chronological
 * order (oldest first). Host's countDueMessages gates waking on trigger=1
 * separately through the host mailbox contract.
 *
 * ORDER MATTERS: claim filtering runs BEFORE the cap windowing. Rows this
 * runner already claimed can remain pending until the host sweep syncs state;
 * windowing first
 * would let a cap-sized batch of those claimed rows fill the window, the
 * ack filter would then empty it, and genuinely new rows beyond the window
 * would be invisible for the rest of the turn.
 */
export function getPendingMessages(isFirstPoll = false): MessageInRow[] {
  // Pull history mode (fork feature): context rows are never fed to the
  // model. Acking them up front takes them out of the mailbox's own pending
  // window, so the batch fills with trigger rows only.
  const pull = getHistoryMode() === 'pull';
  if (pull) ackContextRows();
  const rows = getAgentMailbox()
    .operations.getPendingMessages(getMaxMessagesPerPrompt(), isFirstPoll)
    .map(messageRow);
  return pull ? rows.filter((row) => row.trigger === 1) : rows;
}

export function markProcessing(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'processing');
}

export function markCompleted(ids: string[]): void {
  getAgentMailbox().operations.markMessages(ids, 'completed');
}

export function markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
  getAgentMailbox().operations.markScriptSkipped(skips);
}

export function markFailed(id: string): void {
  getAgentMailbox().operations.markMessages([id], 'failed');
}

export function getMessageIn(id: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.getMessageIn(id);
  return message && messageRow(message);
}

export interface ChannelHistoryFilter {
  channelType?: string;
  platformId?: string;
  threadId?: string;
  beforeSeq?: number;
  limit: number;
}

/** Read stored inbound chat rows regardless of their processing acknowledgement. */
export function getChannelHistory(filter: ChannelHistoryFilter): MessageInRow[] {
  const inbound = openInboundDb();
  try {
    const where = ["kind IN ('chat', 'chat-sdk')"];
    const params: Record<string, string | number> = { $limit: filter.limit };
    if (filter.channelType !== undefined) {
      where.push('channel_type = $channelType');
      params.$channelType = filter.channelType;
    }
    if (filter.platformId !== undefined) {
      where.push('platform_id = $platformId');
      params.$platformId = filter.platformId;
    }
    if (filter.threadId !== undefined) {
      where.push('thread_id = $threadId');
      params.$threadId = filter.threadId;
    }
    if (filter.beforeSeq !== undefined) {
      where.push('seq < $beforeSeq');
      params.$beforeSeq = filter.beforeSeq;
    }
    const rows = inbound
      .prepare(`SELECT * FROM messages_in WHERE ${where.join(' AND ')} ORDER BY seq DESC LIMIT $limit`)
      .all(params) as MessageInRow[];
    return rows.reverse();
  } finally {
    inbound.close();
  }
}

/**
 * Find a pending response to a question (by questionId in content).
 * Reads from inbound.db, checks processing_ack to skip already-handled responses.
 */
export function findQuestionResponse(questionId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findQuestionResponse(questionId);
  return message && messageRow(message);
}

export function findCliResponse(requestId: string): MessageInRow | undefined {
  const message = getAgentMailbox().operations.findCliResponse(requestId);
  return message && messageRow(message);
}
