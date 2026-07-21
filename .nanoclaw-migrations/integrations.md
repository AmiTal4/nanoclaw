# Integrations, container, and operations

## Bitwarden Secrets Manager

Source commits: `8376b321`, `854c7562`, `dd2cf5fd`.

Reapply `/add-bitwarden-secrets`, then preserve any differences not present in
the current skill: multi-architecture BWS binary installation and reading the
machine token from a mounted file rather than an environment variable. Verify
no raw secret enters logs, environment snapshots, or chat context.

## monday.com tool

Source commits: `10332a92`, `834355bb`.

Reapply `/add-monday-tool`. Retain its removal recipe, Dockerfile/package test,
OneCLI OAuth model, and the documented per-group image rebuild caveat.

## Slack multi-instance identities

Source commits: `42afe435`, `355aece6`.

After `/add-slack`, preserve distinct adapter-instance bot identities,
destination-safe routing, and teammate automation in
`scripts/create-slack-teammate.ts`. Service-unit discovery must use the current
install slug helpers. Reconcile with declarative channel defaults and Chat SDK
4.29.0.

## Telegram and WhatsApp Cloud

Reapply `/add-telegram` and `/add-whatsapp-cloud`. Preserve only fork-specific
Telegram pairing/Markdown sanitization behavior not already in current channel
branch tests. Confirm WhatsApp Cloud registration; do not add duplicate barrel
imports.

## AWS and GitHub operational helpers

Source commits: `4787ee73`, `5f8047ea`.

- Preserve `GH_APP_PERMISSIONS` override support in the GitHub App manifest
  server with secure defaults and validation.
- Preserve AWS STS token refresh for agent containers without persisting token
  values in logs or committed files.
- Treat these as operational utilities; do not couple them to upstream core
  startup unless their current behavior requires it.

## Public agent import and setup additions

Review `public-agent-import/` and `setup/groups.ts` against current upstream
group templates/setup. Port intent and supported data only; do not overwrite
new upstream setup flows or restore deleted bespoke channel installers.

## Container behavior

Preserve the committed container changes only after comparison with current
upstream:

- Channel-history configuration and tool exposure.
- Provider-limit throttling and tests.
- Formatter support for trusted reply/quote and session provenance metadata.
- Container instructions explaining cross-session workspace/task visibility.
- Required packages and MCP entrypoints for retained integrations.

Regenerate `pnpm-lock.yaml` and `bun.lock` through their correct package
managers. Never copy the old lockfile over upstream.

