# Host customizations

## Cross-session delivery and provenance

Source commits: `71524a84`, `b8791901`, `7994544d`.

- Mirror an outbound send into the session wired to the destination so the
  receiving session has conversational continuity.
- Store provenance as trusted host/database metadata, never agent-controlled
  content. Preserve the `origin` model and tests preventing forged mirrors.
- Resolve multi-instance outbound delivery from the authorized destination
  grant rather than choosing an adapter by channel type alone.
- Preserve thread-targeted sends.
- Adapt registration and replay to upstream's guard seam and approval grants.
  Re-run permission/destination checks at execution time.

## Activity journal and agent-to-agent provenance

Source commits: `072de284`, `4d20077b`, `11e3306d`.

- Maintain an append-only per-agent-group `activity-log.md` covering inbound,
  outbound, and agent-to-agent sends.
- Stamp sender session identity on inbound lines and `from_session` on
  agent-to-agent messages.
- Escape or structure agent-controlled text so it cannot forge journal records.
- Preserve bounded writes and tests in `src/activity-journal.test.ts`.
- Reconcile storage with upstream's provider-agnostic memory layout; the
  activity journal is operational history, not provider memory.

## Pull-based channel history

Source commit: `0b1f76a5`.

- Preserve per-messaging-group `history_mode` configuration and its migration,
  but allocate a new migration number on upstream.
- Preserve the `fetch_channel_history` tool and inbound DB pull semantics.
- Ensure pulled history is read-only context, is scoped to the authorized
  messaging/agent group, and cannot bypass sender or destination guards.
- Port `messages-in-pull.test.ts` and all tool/config tests.

## Provider-limit and repeated-output containment

Source commit: `ab07e208`.

- Preserve classification/throttling that prevents provider quota/rate-limit
  failures from forming poll-loop or delivery retry storms.
- Reconcile with upstream's newer distinction between rejected
  `rate_limit_event`, transient rate limiting, and quota exhaustion.
- Preserve repeat suppression only where upstream does not already cover it;
  retain regression tests for bounded retries and recovery.

## Unicode-safe task previews

Source commits: `42801da8`, `fcb06c70`.

Do not restore removed scheduling MCP tools. Apply the surrogate-pair-safe
truncation helper only to the corresponding current `ncl tasks` list/preview
surface if upstream still truncates by UTF-16 code unit.

## CLI group configuration bootstrap

Source commit: `85119f30`.

Confirm whether current upstream already provisions `container_configs` through
its CRUD post-create hook. If it does, mark this customization superseded. If
not, preserve atomic creation and its test without duplicating rows.

## Rejected webhook observability

Source commit: `73b7f36d`.

Retain structured, secret-free logging for rejected webhook requests. Log the
reason and safe routing metadata; never log credentials, signatures, raw
authorization headers, or full payloads.

