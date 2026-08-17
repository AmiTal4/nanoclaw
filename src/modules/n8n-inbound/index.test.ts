/**
 * Guard for the n8n inbound webhook.
 *
 * Drives the REAL shared webhook server (as webhook-server-raw.test.ts does)
 * with the router and DB layers mocked, because the things worth pinning here
 * are the security edge and the exact InboundEvent shape:
 *
 *   - the secret check rejects before any parsing or DB work happens
 *   - `kind: 'webhook'` (not 'chat') so the agent sees a machine event
 *   - `isMention: true`, without which routeInbound returns silently and the
 *     message vanishes with no log line
 *   - `replyTo` is populated, without which the agent's answer is written to
 *     outbound.db and delivered nowhere
 *   - entity names are constrained before becoming a primary-key component
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { stopWebhookServer } from '../../webhook-server.js';

const PORT = 21000 + Math.floor(Math.random() * 20000);
const SECRET = 'test-secret-value-long-enough';

const routeInbound = vi.fn<(event: InboundEvent) => Promise<void>>(async () => {});
const createMessagingGroup = vi.fn<(...args: unknown[]) => void>();
const createMessagingGroupAgent = vi.fn<(...args: unknown[]) => void>();
const getMessagingGroupByPlatform = vi.fn<(...args: unknown[]) => unknown>();
const getMessagingGroupAgentByPair = vi.fn<(...args: unknown[]) => unknown>();
const getAgentGroup = vi.fn<(...args: unknown[]) => unknown>();
const getAgentGroupByFolder = vi.fn<(...args: unknown[]) => unknown>();

// This install never loads .env into process.env (src/env.ts) — config must
// come through readEnvFile or the module silently refuses to register. Mocked
// to {} so the tests drive config via the process.env fallback instead of
// whatever the real .env happens to hold.
const readEnvFile = vi.fn<(keys: string[]) => Record<string, string>>(() => ({}));
vi.mock('../../env.js', () => ({ readEnvFile: (keys: string[]) => readEnvFile(keys) }));

vi.mock('../../router.js', () => ({ routeInbound: (e: InboundEvent) => routeInbound(e) }));
vi.mock('../../db/messaging-groups.js', () => ({
  createMessagingGroup: (...a: unknown[]) => createMessagingGroup(...a),
  createMessagingGroupAgent: (...a: unknown[]) => createMessagingGroupAgent(...a),
  getMessagingGroupByPlatform: (...a: unknown[]) => getMessagingGroupByPlatform(...a),
  getMessagingGroupAgentByPair: (...a: unknown[]) => getMessagingGroupAgentByPair(...a),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (...a: unknown[]) => getAgentGroup(...a),
  getAgentGroupByFolder: (...a: unknown[]) => getAgentGroupByFolder(...a),
}));

process.env.WEBHOOK_PORT = String(PORT);
process.env.N8N_INBOUND_SECRET = SECRET;
process.env.N8N_REPLY_TO_CHANNEL = 'whatsapp';
process.env.N8N_REPLY_TO_PLATFORM_ID = '972523968011@s.whatsapp.net';

// Import after env is in place, then run the host-start callbacks. Importing
// the module only *registers* an onHostStart hook — binding the webhook port
// is deliberately deferred to real startup (so merely loading the module graph
// never opens a socket), which is exactly what startHostModules triggers here.
await import('./index.js');
const { startHostModules } = await import('../../host-lifecycle.js');
await startHostModules({
  db: {} as never, // the n8n start hook takes no DB
  signal: new AbortController().signal,
});

// Captured before beforeEach's clearAllMocks can wipe the import-time call.
const envKeysAtImport = readEnvFile.mock.calls[0]?.[0] ?? [];

async function post(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/n8n`, {
        method,
        headers: { 'X-N8N-Secret': SECRET, ...headers },
        body: method === 'POST' ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.N8N_AGENT_GROUP;
});

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
  delete process.env.N8N_INBOUND_SECRET;
});

describe('n8n inbound webhook', () => {
  it('reads config through readEnvFile, not process.env', () => {
    // Regression: reading process.env directly made the module refuse to
    // register on a real install, because .env is deliberately never loaded
    // into the process environment (it would leak to agent containers).
    expect(envKeysAtImport).toContain('N8N_INBOUND_SECRET');
    expect(envKeysAtImport).toContain('N8N_REPLY_TO_PLATFORM_ID');
    expect(envKeysAtImport).toContain('N8N_AGENT_GROUP');
  });

  it('rejects a request with no secret header, without routing', async () => {
    const res = await post({ entity: 'homelab-monitoring' }, { 'X-N8N-Secret': '' });
    expect(res.status).toBe(401);
    expect(routeInbound).not.toHaveBeenCalled();
  });

  it('rejects a wrong secret', async () => {
    const res = await post({ entity: 'homelab-monitoring' }, { 'X-N8N-Secret': 'wrong-secret-but-long' });
    expect(res.status).toBe(401);
    expect(routeInbound).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const res = await post(undefined, {}, 'GET');
    expect(res.status).toBe(405);
    expect(routeInbound).not.toHaveBeenCalled();
  });

  it.each(['Bad-Entity', 'has space', '-leading', '', 'a'.repeat(65)])(
    'rejects invalid entity %j before it becomes a platform_id',
    async (entity) => {
      const res = await post({ entity });
      expect(res.status).toBe(400);
      expect(routeInbound).not.toHaveBeenCalled();
    },
  );

  it('routes a valid event as kind=webhook with isMention and replyTo', async () => {
    const res = await post({
      entity: 'homelab-monitoring',
      event: 'disk_full',
      payload: { host: 'nas', pct: 96 },
    });
    expect(res.status).toBe(202);
    expect(routeInbound).toHaveBeenCalledTimes(1);

    const event = routeInbound.mock.calls[0][0];
    expect(event.channelType).toBe('n8n');
    expect(event.platformId).toBe('homelab-monitoring');
    // One messaging group per workflow — the entity is the identity axis.
    expect(event.instance).toBe('n8n');
    expect(event.message.kind).toBe('webhook');
    // Without this the router returns silently and the message disappears.
    expect(event.message.isMention).toBe(true);
    // Without this the reply is written to outbound.db and delivered nowhere.
    expect(event.replyTo).toEqual({
      channelType: 'whatsapp',
      platformId: '972523968011@s.whatsapp.net',
      threadId: null,
    });

    const content = JSON.parse(event.message.content);
    // formatWebhookMessage reads exactly these three fields.
    expect(content.source).toBe('homelab-monitoring');
    expect(content.event).toBe('disk_full');
    expect(content.payload).toEqual({ host: 'nas', pct: 96 });
    expect(content.senderId).toBe('n8n:homelab-monitoring');
  });

  it('defaults the event name when omitted', async () => {
    await post({ entity: 'rss', payload: { title: 'x' } });
    const event = routeInbound.mock.calls[0][0];
    expect(JSON.parse(event.message.content).event).toBe('notification');
  });

  it('lets a request override the reply address', async () => {
    await post({
      entity: 'rss',
      reply_to: { channelType: 'slack', platformId: 'C123', threadId: '1.2' },
    });
    const event = routeInbound.mock.calls[0][0];
    expect(event.replyTo).toEqual({ channelType: 'slack', platformId: 'C123', threadId: '1.2' });
  });

  it('auto-provisions a messaging group and wiring for a new entity', async () => {
    process.env.N8N_AGENT_GROUP = 'dm-with-amit';
    getAgentGroup.mockReturnValue(undefined);
    getAgentGroupByFolder.mockReturnValue({ id: 'ag-edna' });
    getMessagingGroupByPlatform.mockReturnValue(undefined);
    getMessagingGroupAgentByPair.mockReturnValue(undefined);

    const res = await post({ entity: 'newthing', event: 'ping' });
    expect(res.status).toBe(202);

    expect(createMessagingGroup).toHaveBeenCalledTimes(1);
    const mg = createMessagingGroup.mock.calls[0][0] as Record<string, unknown>;
    expect(mg.channel_type).toBe('n8n');
    expect(mg.platform_id).toBe('newthing');
    // The shared secret is the auth boundary; without 'public' the router's
    // fallback policy would hold every event behind an approval card.
    expect(mg.unknown_sender_policy).toBe('public');

    expect(createMessagingGroupAgent).toHaveBeenCalledTimes(1);
    const mga = createMessagingGroupAgent.mock.calls[0][0] as Record<string, unknown>;
    expect(mga.agent_group_id).toBe('ag-edna');
    // '.' short-circuits to always-engage; webhook content has no text to match.
    expect(mga.engage_mode).toBe('pattern');
    expect(mga.engage_pattern).toBe('.');
    expect(mga.session_mode).toBe('shared');
  });

  it('does not re-create an existing group or wiring', async () => {
    process.env.N8N_AGENT_GROUP = 'ag-edna';
    getAgentGroup.mockReturnValue({ id: 'ag-edna' });
    getMessagingGroupByPlatform.mockReturnValue({ id: 'mg-n8n-existing' });
    getMessagingGroupAgentByPair.mockReturnValue({ id: 'mga-n8n-existing' });

    const res = await post({ entity: 'existing', event: 'ping' });
    expect(res.status).toBe(202);
    expect(createMessagingGroup).not.toHaveBeenCalled();
    expect(createMessagingGroupAgent).not.toHaveBeenCalled();
    expect(routeInbound).toHaveBeenCalledTimes(1);
  });

  it('fails loudly when the configured agent group does not exist', async () => {
    process.env.N8N_AGENT_GROUP = 'nope';
    getAgentGroup.mockReturnValue(undefined);
    getAgentGroupByFolder.mockReturnValue(undefined);

    const res = await post({ entity: 'orphan' });
    expect(res.status).toBe(500);
    expect(routeInbound).not.toHaveBeenCalled();
  });
});
