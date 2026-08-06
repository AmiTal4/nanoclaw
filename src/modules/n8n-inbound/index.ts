/**
 * n8n inbound webhook.
 *
 * Lets an external automation platform (n8n in the homelab) hand NanoClaw a
 * structured event over HTTP, which routes through the normal router pipeline
 * and wakes an agent. Replies are redirected to a fixed operator address
 * (WhatsApp) via `replyTo`, because the n8n channel has no adapter of its own
 * and therefore nowhere to deliver a response.
 *
 * Shape:
 *   POST /webhook/n8n
 *   X-N8N-Secret: <N8N_INBOUND_SECRET>
 *   { "entity": "homelab-monitoring", "event": "disk_full", "payload": {...} }
 *
 * Entity model: one `messaging_groups` row per n8n workflow, keyed by
 * `platform_id = entity`. Identity is UNIQUE(channel_type, platform_id,
 * instance), so each workflow gets its own row → its own session → its own
 * conversation context, while all of them wire to the same agent group and
 * therefore share one memory/personality (session_mode='shared').
 *
 * `instance` is deliberately left at the default (= channel_type). That
 * dimension exists for N adapters of one platform (three Slack apps with
 * three signing secrets); here there is one handler, so it stays unused.
 *
 * Security: this endpoint is the ONLY authentication boundary. The shared
 * webhook server has no transport-level auth and binds 0.0.0.0, so the
 * secret check below is what stands between the open port and "make the agent
 * do arbitrary things". It runs before any parsing or DB work, and the module
 * refuses to register at all when the secret is unset or too short.
 */
import crypto from 'crypto';
import type http from 'http';

import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import type { MessagingGroup } from '../../types.js';
import { registerWebhookHandler } from '../../webhook-server.js';

/** Channel type for every n8n-originated messaging group. */
const CHANNEL_TYPE = 'n8n';

/** Reject bodies above this size before parsing — the port is world-reachable. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Entity names become `platform_id`, a primary-key component. Constrain them
 * hard: a typo in an n8n node otherwise silently creates a whole new entity
 * (and, with auto-provisioning on, a whole new session).
 */
const ENTITY_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Minimum secret length — a short shared secret on an open port is no secret. */
const MIN_SECRET_LEN = 16;

interface N8nBody {
  entity?: unknown;
  event?: unknown;
  payload?: unknown;
  text?: unknown;
  reply_to?: unknown;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Constant-time compare that doesn't leak length via early return. */
function secretMatches(provided: string | undefined, expected: string): boolean {
  if (typeof provided !== 'string') return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) {
    // Still burn a comparison so timing doesn't distinguish "wrong length"
    // from "wrong value".
    crypto.timingSafeEqual(b, b);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(text);
}

/**
 * Ensure a messaging group exists for this entity and is wired to the target
 * agent group. Returns false when auto-provisioning is off, in which case the
 * router's own auto-create + channel-request-approval path handles unknown
 * entities (operator approves once, per entity).
 *
 * `unknown_sender_policy` is 'public' by design: the shared secret already
 * authenticated the caller at the transport edge, and n8n has no per-human
 * sender identity to gate on. Without this the router's fallback policy
 * ('request_approval' for undeclared channel types) would hold every single
 * event behind an approval card.
 */
function ensureProvisioned(entity: string, agentGroupId: string): void {
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CHANNEL_TYPE, entity, CHANNEL_TYPE);

  if (!mg) {
    const now = new Date().toISOString();
    mg = {
      id: `mg-n8n-${entity}`,
      channel_type: CHANNEL_TYPE,
      platform_id: entity,
      instance: CHANNEL_TYPE,
      name: `n8n/${entity}`,
      is_group: 0,
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: now,
    };
    createMessagingGroup(mg);
    log.info('n8n: auto-created messaging group', { entity, messagingGroupId: mg.id });
  }

  if (getMessagingGroupAgentByPair(mg.id, agentGroupId)) return;

  createMessagingGroupAgent({
    id: `mga-n8n-${entity}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
    // 'pattern' with the '.' sentinel short-circuits to always-engage before
    // any regex runs (evaluateEngage, src/router.ts). That matters here:
    // webhook content has no `text` field, so a real regex would test against
    // '' and never match.
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    // Each entity keeps its own session/context, but they all share the
    // agent group's workspace, memory and personality.
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('n8n: wired entity to agent group', { entity, agentGroupId, messagingGroupId: mg.id });
}

function resolveAgentGroupId(raw: string): string | null {
  return getAgentGroup(raw)?.id ?? getAgentGroupByFolder(raw)?.id ?? null;
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse, secret: string): Promise<void> {
  if (req.method !== 'POST') {
    json(res, 405, { error: 'method not allowed' });
    return;
  }

  // First statement that touches the request: no parsing, no DB, no logging
  // of contents until the caller has proven it holds the secret.
  const provided = req.headers['x-n8n-secret'];
  if (!secretMatches(typeof provided === 'string' ? provided : undefined, secret)) {
    log.warn('n8n: rejected unauthenticated webhook', { remote: req.socket.remoteAddress });
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  let body: N8nBody;
  try {
    body = JSON.parse(await readBody(req)) as N8nBody;
  } catch (err) {
    json(res, 400, { error: 'invalid body', detail: (err as Error).message });
    return;
  }

  const entity = typeof body.entity === 'string' ? body.entity : '';
  if (!ENTITY_RE.test(entity)) {
    json(res, 400, { error: 'invalid entity', detail: 'must match /^[a-z0-9][a-z0-9_-]{0,63}$/' });
    return;
  }

  const eventName = typeof body.event === 'string' && body.event !== '' ? body.event : 'notification';
  const payload = body.payload !== undefined ? body.payload : (body.text ?? null);

  const agentGroupRaw = process.env.N8N_AGENT_GROUP;
  if (agentGroupRaw) {
    const agentGroupId = resolveAgentGroupId(agentGroupRaw);
    if (!agentGroupId) {
      log.error('n8n: N8N_AGENT_GROUP does not resolve to an agent group', { value: agentGroupRaw });
      json(res, 500, { error: 'agent group not found' });
      return;
    }
    ensureProvisioned(entity, agentGroupId);
  }

  // Reply redirection. The n8n channel has no adapter, so without replyTo the
  // agent's response is written to outbound.db and delivered nowhere.
  const replyTo = resolveReplyTo(body.reply_to);
  if (!replyTo) {
    log.error('n8n: no reply address configured — agent replies would be dropped', { entity });
    json(res, 500, { error: 'no reply address configured' });
    return;
  }

  await routeInbound({
    channelType: CHANNEL_TYPE,
    instance: CHANNEL_TYPE,
    platformId: entity,
    threadId: null,
    message: {
      id: `n8n-${entity}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      // Renders as <webhook source=... event=...>{payload}</webhook> in the
      // agent prompt (container/agent-runner/src/formatter.ts), structurally
      // distinct from a <message> chat turn.
      kind: 'webhook',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        source: entity,
        event: eventName,
        payload,
        // Gives the sender resolver a stable identity to upsert, so dropped
        // -message rows and approval cards name the workflow rather than null.
        sender: `n8n/${entity}`,
        senderId: `${CHANNEL_TYPE}:${entity}`,
      }),
      // Required: routeInbound returns silently (no log) on a non-mention when
      // the messaging group or its wiring doesn't exist yet. Every n8n POST is
      // by definition addressed to the agent.
      isMention: true,
      isGroup: false,
    },
    replyTo,
  });

  json(res, 202, { ok: true, entity, event: eventName });
}

function resolveReplyTo(
  fromBody: unknown,
): { channelType: string; platformId: string; threadId: string | null } | null {
  if (typeof fromBody === 'object' && fromBody !== null) {
    const r = fromBody as Record<string, unknown>;
    if (typeof r.channelType === 'string' && typeof r.platformId === 'string') {
      return {
        channelType: r.channelType,
        platformId: r.platformId,
        threadId: typeof r.threadId === 'string' ? r.threadId : null,
      };
    }
  }
  const platformId = process.env.N8N_REPLY_TO_PLATFORM_ID;
  if (!platformId) return null;
  return {
    channelType: process.env.N8N_REPLY_TO_CHANNEL || 'whatsapp',
    platformId,
    threadId: null,
  };
}

const secret = process.env.N8N_INBOUND_SECRET;
if (!secret) {
  log.info('n8n inbound webhook not registered (N8N_INBOUND_SECRET unset)');
} else if (secret.length < MIN_SECRET_LEN) {
  log.error('n8n inbound webhook NOT registered — N8N_INBOUND_SECRET is too short', {
    length: secret.length,
    required: MIN_SECRET_LEN,
  });
} else {
  registerWebhookHandler(process.env.N8N_WEBHOOK_PATH || 'n8n', (req, res) =>
    handle(req, res, secret).catch((err) => {
      log.error('n8n webhook handler threw', { err });
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
    }),
  );
}

export { ENTITY_RE, secretMatches, resolveReplyTo, ensureProvisioned };
