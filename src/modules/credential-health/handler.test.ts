/**
 * `credential_alert` trust boundary.
 *
 * The row crosses container → host on a writable mount, so a compromised
 * container can author one directly rather than going through the runner.
 * The alert reaches the OWNER's DM regardless of the group's destination
 * grants and carries a real destructive runbook line, so the payload must not
 * be able to steer it.
 *
 * These pin the two properties that make the unguarded registration honest:
 * the provider is re-derived host-side, and a forged provider string can
 * neither mislabel the alert nor mint fresh cooldown buckets to fan out DMs.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import type { Session } from '../../types.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { resetCredentialAlertState } from './alert.js';
// Registers the action under test.
import './index.js';

vi.mock('../../container-runner.js', async () => {
  const actual = await vi.importActual<typeof import('../../container-runner.js')>('../../container-runner.js');
  return { ...actual, wakeContainer: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-credential-handler' };
});

const TEST_DIR = '/tmp/nanoclaw-test-credential-handler';

function now(): string {
  return new Date().toISOString();
}

function collectingAdapter(): { texts: () => string[] } {
  const sent: string[] = [];
  const adapter: ChannelDeliveryAdapter = {
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      sent.push((JSON.parse(content) as { text: string }).text);
      return 'platform-msg-1';
    },
  };
  setDeliveryAdapter(adapter);
  return { texts: () => sent };
}

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  resetCredentialAlertState();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);

  createAgentGroup({ id: 'ag-1', name: 'Edna', folder: 'edna', agent_provider: null, created_at: now() });
  // The group's real provider lives in container_configs; the session column
  // is null, which is the shape real sessions have on this install.
  db.prepare('INSERT INTO container_configs (agent_group_id, provider, updated_at) VALUES (?, ?, ?)').run(
    'ag-1',
    'codex',
    now(),
  );

  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);

  upsertUser({ id: 'slack:owner-1', kind: 'slack', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'slack:owner-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-owner-1',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({ user_id: 'slack:owner-1', channel_type: 'slack', messaging_group_id: 'mg-dm-1', resolved_at: now() });
});

afterEach(() => {
  closeDb();
  resetCredentialAlertState();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function dispatch(content: Record<string, unknown>): Promise<void> {
  const handler = getDeliveryAction('credential_alert');
  expect(handler).toBeDefined();
  await handler!(content, session, undefined as never);
}

describe('credential_alert handler', () => {
  it('is registered', () => {
    expect(getDeliveryAction('credential_alert')).toBeDefined();
  });

  it('resolves the provider from the session config, not the payload', async () => {
    const { texts } = collectingAdapter();

    await dispatch({ action: 'credential_alert', provider: 'totally-made-up', detail: 'x' });

    const text = texts()[0];
    // The alert names the provider this session actually runs...
    expect(text).toContain('codex');
    // ...and the runbook is the real one for it.
    expect(text).toContain('provider-auth codex');
    // The forged string never reaches the operator.
    expect(text).not.toContain('totally-made-up');
  });

  it('cannot fan out DMs by varying the claimed provider', async () => {
    const { texts } = collectingAdapter();

    // Every row resolves to the same real provider, so the per-provider
    // cooldown applies to all of them — one DM, not five.
    for (const claimed of ['codex-a', 'codex-b', 'codex-c', 'codex-d', 'codex-e']) {
      await dispatch({ action: 'credential_alert', provider: claimed, detail: 'x' });
    }

    expect(texts()).toHaveLength(1);
  });

  it('still works when the payload omits a provider entirely', async () => {
    const { texts } = collectingAdapter();

    await dispatch({ action: 'credential_alert', detail: 'token_expired' });

    expect(texts()[0]).toContain('codex');
  });
});
