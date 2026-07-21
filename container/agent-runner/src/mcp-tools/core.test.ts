/**
 * Tests for the core MCP tools' interaction with the per-batch routing
 * context. The agent-runner sets a current `inReplyTo` at the top of each
 * batch in poll-loop, and outbound writes from MCP tools (send_message,
 * send_file) must pick it up so a2a return-path routing on the host can
 * correlate replies back to the originating session.
 *
 * The stamp is published through session_state in outbound.db, not module
 * state — the MCP server runs as a separate stdio subprocess from the poll
 * loop, so it can only see the stamp through the shared DB. These tests seed
 * it the same way the poll-loop process does (a direct DB write) rather than
 * via any in-memory helper, so they exercise the real process boundary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from '../db/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { fetchChannelHistory, sendMessage } from './core.js';

/**
 * Publish the a2a reply stamp the way the poll loop does: a direct write to
 * session_state in outbound.db. `ageMs` back-dates updated_at to exercise the
 * staleness guard MCP tools apply when reading it.
 */
function publishInReplyTo(id: string, ageMs = 0): void {
  const updatedAt = new Date(Date.now() - ageMs).toISOString();
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_in_reply_to', id, updatedAt);
}

beforeEach(() => {
  initTestSessionDb();
  // Seed a peer agent destination
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('peer', 'Peer', 'agent', NULL, NULL, 'ag-peer')`,
    )
    .run();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('dev', 'Dev', 'channel', 'slack', 'slack:C0DEV', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

describe('send_message MCP tool — in_reply_to plumbing', () => {
  it('stamps the batch in_reply_to (published via the DB) on outbound rows', async () => {
    publishInReplyTo('inbound-msg-1');

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBe('inbound-msg-1');
  });

  it('writes null when no batch is active', async () => {
    // Nothing published to session_state — simulates ad-hoc / out-of-batch invocation.
    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });

  it('ignores a stale stamp left behind by a killed container', async () => {
    publishInReplyTo('inbound-msg-1', 60 * 60 * 1000); // an hour old

    await sendMessage.handler({ to: 'peer', text: 'hello' });

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].in_reply_to).toBeNull();
  });
});

describe('fetch_channel_history MCP tool', () => {
  function seed(seq: number, text: string, threadId: string | null = null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, 'chat-sdk', ?, 0, 'slack:C0DEV', 'slack', ?, ?)`,
      )
      .run(
        `history-${seq}`,
        seq,
        `2026-07-12T10:00:${String(seq).padStart(2, '0')}.000Z`,
        threadId,
        JSON.stringify({ text, sender: 'Dana', id: `platform-${seq}` }),
      );
  }

  it('returns named-channel history oldest first and supports paging', async () => {
    seed(21, 'first');
    seed(22, 'second');
    seed(23, 'third');
    const result = await fetchChannelHistory.handler({ channel: 'dev', limit: 2, before: 23 });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text.indexOf('#21')).toBeLessThan(result.content[0].text.indexOf('#22'));
    expect(result.content[0].text).not.toContain('#23');
  });

  it('requires a valid destination when there is no current message context', async () => {
    const result = await fetchChannelHistory.handler({ channel: 'missing' });
    expect(result.isError).toBe(true);
  });
});
