/**
 * Activity journal tests.
 *
 * The journal is the host-written record of an agent group's cross-session
 * activity (activity-log.md in the group workspace). Covered here:
 *  - direct module behavior: line format, excerpts, off-switch, missing
 *    group folder (must no-op, never create dirs, never throw)
 *  - the two live hooks: writeSessionMessage journals [in] rows (and skips
 *    host mirror rows), delivery journals [out] on successful sends
 *  - in-place rotation keeps the newest entries and the same inode (the
 *    container bind mount depends on inode stability)
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-journal/data',
    GROUPS_DIR: '/tmp/nanoclaw-test-journal/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-journal';
const GROUPS = path.join(TEST_DIR, 'groups');

import { initTestDb, closeDb, runMigrations, createAgentGroup, createMessagingGroup } from './db/index.js';
import { ensureContainerConfig, updateContainerConfigScalars } from './db/container-configs.js';
import { journalMessageIn, journalMessageOut, journalTask, ensureActivityLog } from './activity-journal.js';
import { resolveSession, writeSessionMessage, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

function now(): string {
  return new Date().toISOString();
}

function seedGroup(withFolder = true): void {
  createAgentGroup({
    id: 'ag-j1',
    name: 'Journal Agent',
    folder: 'journal-agent',
    agent_provider: null,
    created_at: now(),
  });
  if (withFolder) fs.mkdirSync(path.join(GROUPS, 'journal-agent'), { recursive: true });
}

function logPath(): string {
  return path.join(GROUPS, 'journal-agent', 'activity-log.md');
}

function logText(): string {
  return fs.readFileSync(logPath(), 'utf8');
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(GROUPS, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('activity journal — module behavior', () => {
  it('journals in/out/task lines with chat, sender, session and excerpt', () => {
    seedGroup();
    journalMessageIn('ag-j1', 'sess-a', {
      channelType: 'whatsapp',
      platformId: '123@s.whatsapp.net',
      content: JSON.stringify({ text: 'hello   world', senderName: 'Asaf' }),
      trigger: 1,
    });
    journalMessageOut(
      'ag-j1',
      'sess-a',
      { channelType: 'whatsapp', platformId: '123@s.whatsapp.net', name: 'whatsapp-asaf' },
      JSON.stringify({ text: 'hi back' }),
    );
    journalTask('ag-j1', 'sess-a', 'scheduled', 'task-1', 'next=2026-07-09T07:00:00.000Z recurrence="0 7 * * *"');

    const text = logText();
    expect(text).toContain('[in] whatsapp:123@s.whatsapp.net sender="Asaf" session=sess-a :: hello world');
    expect(text).toContain('[out] whatsapp-asaf session=sess-a :: hi back');
    expect(text).toContain(
      '[task-scheduled] task-1 next=2026-07-09T07:00:00.000Z recurrence="0 7 * * *" session=sess-a',
    );
  });

  it('respects the per-group off switch and missing group folders (no-ops, never throws)', () => {
    seedGroup();
    ensureContainerConfig('ag-j1');
    updateContainerConfigScalars('ag-j1', { activity_journal: 'off' });
    journalMessageIn('ag-j1', 'sess-a', { content: '{"text":"x"}' });
    expect(fs.existsSync(logPath())).toBe(false);
    expect(ensureActivityLog('ag-j1')).toBeNull();

    // unknown group and unprovisioned folder both no-op
    journalMessageIn('ag-missing', 'sess-a', { content: '{"text":"x"}' });
    updateContainerConfigScalars('ag-j1', { activity_journal: 'on' });
    fs.rmSync(path.join(GROUPS, 'journal-agent'), { recursive: true });
    journalMessageIn('ag-j1', 'sess-a', { content: '{"text":"x"}' });
    expect(fs.existsSync(logPath())).toBe(false);
  });

  it('truncates long excerpts on code-point boundaries', () => {
    seedGroup();
    journalMessageIn('ag-j1', 'sess-a', {
      content: JSON.stringify({ text: '🎉'.repeat(200) }),
    });
    const line = logText()
      .split('\n')
      .find((l) => l.includes('[in]'))!;
    expect(line).toContain('🎉'.repeat(120) + '…');
    expect(line).not.toContain('�'); // no split surrogate pairs
  });

  it('rotates in place: keeps newest entries and the same inode', () => {
    seedGroup();
    ensureActivityLog('ag-j1');
    const inodeBefore = fs.statSync(logPath()).ino;
    // Excerpts cap at 120 chars (~170 bytes/line), so ~2000 lines crosses
    // the 256KB rotation threshold with room to spare.
    const filler = 'x'.repeat(200);
    for (let i = 0; i < 2000; i++) {
      journalMessageIn('ag-j1', `sess-${i}`, { content: JSON.stringify({ text: filler }) });
    }
    journalMessageIn('ag-j1', 'sess-final', { content: '{"text":"newest entry"}' });
    const text = logText();
    expect(fs.statSync(logPath()).size).toBeLessThan(257 * 1024);
    expect(text).toContain('newest entry');
    expect(text).toContain('rotated');
    expect(text.startsWith('<!-- activity-log.md')).toBe(true);
    expect(fs.statSync(logPath()).ino).toBe(inodeBefore);
  });
});

describe('activity journal — live hooks', () => {
  it('writeSessionMessage journals inbound chat rows but skips host mirror rows', () => {
    seedGroup();
    createMessagingGroup({
      id: 'mg-j1',
      channel_type: 'whatsapp',
      platform_id: '123@s.whatsapp.net',
      name: 'Chat',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = resolveSession('ag-j1', 'mg-j1', null, 'shared');

    writeSessionMessage('ag-j1', session.id, {
      id: 'msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: '123@s.whatsapp.net',
      channelType: 'whatsapp',
      content: JSON.stringify({ text: 'routed message', senderName: 'Asaf' }),
      trigger: 1,
    });
    writeSessionMessage('ag-j1', session.id, {
      id: 'mirror-out-9',
      kind: 'chat',
      timestamp: now(),
      platformId: '123@s.whatsapp.net',
      channelType: 'whatsapp',
      content: JSON.stringify({ text: 'mirrored copy', sender: 'Journal Agent', origin: 'self-mirror' }),
      trigger: 0,
      sourceSessionId: 'sess-elsewhere',
    });

    const text = logText();
    expect(text).toContain('routed message');
    expect(text).not.toContain('mirrored copy');
  });

  it('delivery journals [out] with the wired chat name on successful sends', async () => {
    seedGroup();
    createMessagingGroup({
      id: 'mg-j1',
      channel_type: 'whatsapp',
      platform_id: '123@s.whatsapp.net',
      name: 'whatsapp-asaf',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now(),
    });
    const { session } = resolveSession('ag-j1', 'mg-j1', null, 'shared');
    const outDb = new Database(outboundDbPath('ag-j1', session.id));
    outDb
      .prepare(
        `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
         VALUES (?, datetime('now'), 'chat', '123@s.whatsapp.net', 'whatsapp', ?)`,
      )
      .run('out-j1', JSON.stringify({ text: 'delivered reply' }));
    outDb.close();

    setDeliveryAdapter({
      async deliver() {
        return 'plat-1';
      },
    });
    await deliverSessionMessages(session);

    expect(logText()).toContain('[out] whatsapp-asaf session=' + session.id + ' :: delivered reply');
  });
});
