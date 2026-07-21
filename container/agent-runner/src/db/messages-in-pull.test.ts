import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { clearConfigForTest, setConfigForTest } from '../config.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './connection.js';
import { getChannelHistory, getPendingMessages } from './messages-in.js';

function insertChat(id: string, seq: number, trigger: 0 | 1, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, platform_id, channel_type, content)
       VALUES (?, ?, 'chat-sdk', datetime('now'), 'pending', ?, 'slack:C0DEV', 'slack', ?)`,
    )
    .run(id, seq, trigger, JSON.stringify({ text, sender: 'Someone' }));
}

beforeEach(() => initTestSessionDb());
afterEach(() => {
  clearConfigForTest();
  closeSessionDb();
});

describe('pull history mode', () => {
  it('keeps push mode behavior by default', () => {
    insertChat('c1', 1, 0, 'noise');
    insertChat('m1', 2, 1, 'mention');
    expect(getPendingMessages().map((message) => message.id)).toEqual(['c1', 'm1']);
  });

  it('acks context, returns triggers, and retains readable history', () => {
    setConfigForTest({ historyMode: 'pull' });
    insertChat('c1', 1, 0, 'discussion');
    insertChat('m1', 2, 1, 'mention');
    expect(getPendingMessages().map((message) => message.id)).toEqual(['m1']);
    expect(getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get('c1')).toEqual({
      status: 'completed',
    });
    expect(getChannelHistory({ channelType: 'slack', platformId: 'slack:C0DEV', limit: 10 }).map((m) => m.id)).toEqual([
      'c1',
      'm1',
    ]);
  });

  it('does not let a context backlog crowd a trigger out of the limit', () => {
    setConfigForTest({ historyMode: 'pull', maxMessagesPerPrompt: 5 });
    insertChat('m1', 1, 1, 'mention');
    for (let seq = 2; seq <= 21; seq++) insertChat(`c${seq}`, seq, 0, `noise ${seq}`);
    expect(getPendingMessages().map((message) => message.id)).toEqual(['m1']);
  });
});
