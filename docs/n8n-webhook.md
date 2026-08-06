# n8n inbound webhook

Lets n8n (or any HTTP client) hand NanoClaw a structured event that wakes an
agent. Implemented as a raw route on the shared webhook server — no new port,
no new process.

- Module: `src/modules/n8n-inbound/index.ts`
- Route: `POST /webhook/n8n`
- Tests: `src/modules/n8n-inbound/index.test.ts`

## Request

```http
POST /webhook/n8n
X-N8N-Secret: <N8N_INBOUND_SECRET>
Content-Type: application/json

{
  "entity":  "homelab-monitoring",
  "event":   "disk_full",
  "payload": { "host": "nas", "pct": 96 }
}
```

Responses: `202 {"ok":true,...}` on accept, `401` bad/missing secret, `400`
bad body or entity, `405` non-POST, `500` misconfiguration.

Optional `reply_to: {channelType, platformId, threadId}` overrides the reply
address for that one event.

## Configuration

| Env var | Required | Meaning |
|---|---|---|
| `N8N_INBOUND_SECRET` | **yes** | Shared secret. Must be ≥16 chars. **Unset → the route is never registered**; too short → registration refused with an error log. |
| `N8N_REPLY_TO_PLATFORM_ID` | yes | Where the agent's reply is delivered, e.g. `972523968011@s.whatsapp.net`. |
| `N8N_REPLY_TO_CHANNEL` | no | Defaults to `whatsapp`. |
| `N8N_AGENT_GROUP` | no | Agent group id or folder. When set, unknown entities are auto-provisioned (messaging group + wiring). When unset, an unknown entity falls through to the router's channel-request approval card. |
| `N8N_WEBHOOK_PATH` | no | Route segment, defaults to `n8n`. |

## The entity model

One `messaging_groups` row per n8n workflow, keyed by `platform_id = entity`:

```
channel_type = 'n8n'
platform_id  = 'homelab-monitoring'   ← the identity axis
instance     = 'n8n'                  ← unused; that dimension is for N adapters of one platform
```

Each entity gets its own session, so the RSS firehose never pollutes the
monitoring context. All entities wire to the same agent group with
`session_mode: 'shared'`, so it stays one agent with one memory and
personality.

Auto-provisioned wirings use `engage_mode: 'pattern'` with the `'.'` sentinel.
That short-circuits to always-engage *before* any regex runs — which matters,
because webhook content has no `text` field and a real regex would test against
`''` and never match.

## What the agent sees

`kind: 'webhook'` renders through `formatWebhookMessage`
(`container/agent-runner/src/formatter.ts`) as a block structurally distinct
from a human chat turn:

```xml
<webhook source="homelab-monitoring" event="disk_full">{
  "host": "nas",
  "pct": 96
}</webhook>
```

Chat turns render as `<message from="...">`. The formatter groups by kind, so
the two can never be confused. Webhook messages also skip the slash-command
gate in `deliverToAgent`, which only classifies human-authored text.

The tag is self-describing, but nothing in the composed CLAUDE.md explains how
to *act* on one. To make the behavior deliberate rather than inferred, add a
stanza to the target agent group's `groups/<folder>/CLAUDE.local.md`:

```markdown
## Automated webhook events

Messages arriving as `<webhook source="..." event="...">` are automated events
from n8n, not a person talking to you. Nobody is waiting in a chat window.

- Do not greet, thank, or ask clarifying questions — there is no one to answer.
- Judge whether the event is worth surfacing. Routine/no-op events can be
  acknowledged with no reply at all.
- When it is worth surfacing, send one short message stating what happened and
  what (if anything) needs a decision. Lead with the impact, not the payload.
- `source` names the n8n workflow; treat distinct sources as distinct topics.
```

## Security

The shared webhook server has **no transport-level auth** and binds `0.0.0.0`.
Every existing route is protected only by its own platform signature check, so
this handler's secret check is the entire authentication boundary. It runs
before any parsing, DB work, or content logging, and uses a constant-time
compare.

Two deployment notes:

1. **Keep it on the tailnet.** n8n should POST to the host's Tailscale address
   rather than a public hostname.
2. **The Cloudflare tunnel is a catch-all.** `/etc/cloudflared/config.yml`
   forwards *every* path on `webhook.edna-ai.online` to `localhost:3000`, so
   adding a route also publishes it to the internet. Scope the ingress so only
   the platform routes are public:

   ```yaml
   ingress:
     - hostname: webhook.edna-ai.online
       path: ^/webhook/(slack|telegram)
       service: http://localhost:3000
     - hostname: webhook.edna-ai.online
       service: http_status:404
     - service: http_status:404
   ```

   Restart `cloudflared` after editing — briefly interrupts Slack/Telegram
   webhook delivery.

Because the secret authenticates the caller at the edge and n8n carries no
per-human sender identity, auto-provisioned messaging groups are created with
`unknown_sender_policy: 'public'`. Without that, the router's fallback policy
for undeclared channel types (`request_approval`) would hold every event behind
an approval card.
