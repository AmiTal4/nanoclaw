---
name: add-bitwarden-secrets
description: Add Bitwarden Secrets Manager as an MCP tool so container agents can retrieve secrets from scoped machine accounts.
---

# Add Bitwarden Secrets Manager

This skill adds a stdio-based MCP server that lets container agents retrieve secrets from [Bitwarden Secrets Manager](https://bitwarden.com/products/secrets-manager/). Each agent group gets its own machine account with access to only its assigned projects — Bitwarden enforces the isolation server-side.

Tools exposed:
- `bitwarden_list_secrets` — list available secret names and IDs (no values)
- `bitwarden_get_secret` — retrieve a secret's value by name or UUID

The access-control model:
1. One Bitwarden Organization with Secrets Manager enabled
2. A **Project** per agent group (e.g. `browser-agent`, `email-agent`)
3. A **Machine Account** per agent group, granted read access to only its project
4. An **Access Token** per machine account, injected into the container via `BWS_ACCESS_TOKEN`

The machine account can only decrypt secrets in its assigned project. Even if two agents share the same Bitwarden organization, they cannot see each other's secrets.

## Phase 1: Pre-flight

### Check if already applied

Check if `container/agent-runner/src/bitwarden-secrets-mcp-stdio.ts` exists. If it does, skip to Phase 3 (Configure).

### Check prerequisites

1. **Bitwarden Organization** with Secrets Manager enabled (Teams or Enterprise plan)
2. At least one **Project** created in Secrets Manager
3. At least one **Machine Account** with an access token

Ask the user to confirm these exist. If not, direct them to the [Secrets Manager Quick Start](https://bitwarden.com/help/secrets-manager-quick-start/).

## Phase 2: Apply Code Changes

### Copy the MCP server source into the container tree

```bash
S=.claude/skills/add-bitwarden-secrets
cp $S/bitwarden-secrets-mcp-stdio.ts container/agent-runner/src/bitwarden-secrets-mcp-stdio.ts
```

### Install the `bws` CLI in the Dockerfile

Edit `container/Dockerfile`. Add a build arg near the other pinned versions:

```dockerfile
ARG BWS_VERSION=2.1.0
```

Add a new layer after the Bun install block (after the `rm -rf /root/.bun` line) to download and install the `bws` binary:

```dockerfile
# ---- Bitwarden Secrets Manager CLI (bws) ------------------------------------
ARG BWS_VERSION
RUN curl -fsSL "https://github.com/bitwarden/sdk-sm/releases/download/bws-v${BWS_VERSION}/bws-x86_64-unknown-linux-gnu-${BWS_VERSION}.zip" \
        -o /tmp/bws.zip && \
    unzip -o /tmp/bws.zip -d /usr/local/bin && \
    chmod +x /usr/local/bin/bws && \
    rm /tmp/bws.zip
```

> **Note:** This installs the x86_64 binary. For arm64 hosts, change `x86_64-unknown-linux-gnu` to `aarch64-unknown-linux-gnu`. If multi-arch is needed, use a build-arg or detect `$(uname -m)` at build time.

### Validate code changes

```bash
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

Both must pass before proceeding.

## Phase 3: Configure

This step is repeated **per agent group** that needs secrets access.

### Create the Bitwarden project and machine account

If not already done, ask the user to:

1. Open Bitwarden Secrets Manager (web vault → Secrets Manager)
2. Create a **Project** for this agent group (e.g. `browser-agent-secrets`)
3. Add the relevant secrets to the project
4. Create a **Machine Account** (or reuse one), grant it **Can read** access to the project
5. Generate an **Access Token** for the machine account

The user should provide the access token.

### Wire the MCP server for the agent group

Register the MCP server with the group's access token:

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name bitwarden_secrets \
  --command bun \
  --args '["run", "/app/src/bitwarden-secrets-mcp-stdio.ts"]' \
  --env '{"BWS_ACCESS_TOKEN":"<access-token>"}'
```

> **Security note:** The access token is stored in the `container_configs` DB table and written to `container.json` at spawn time (mounted read-only into the container). It is not exposed to the agent as an env var — only the MCP server subprocess receives it. For stronger isolation, store the token in the OneCLI vault and inject it at request time.

### Restart the agent group

```bash
ncl groups restart --id <agent-group-id> --rebuild --message "Bitwarden Secrets Manager is now available. Use bitwarden_list_secrets to see your secrets."
```

### Repeat for additional agent groups

Each group gets its own machine account and access token, scoped to its own project. Run the wire + restart steps for each group.

## Phase 4: Verify

### Test listing

Tell the user:

> Send a message to the agent like: "list my available secrets"
>
> The agent should call `bitwarden_list_secrets` and show the secret names.

### Test retrieval

Tell the user:

> Send a message like: "get the value of the secret named DATABASE_URL"
>
> The agent should call `bitwarden_get_secret` and return the value.

### Check logs if needed

```bash
tail -f logs/nanoclaw.log | grep -i BWS
```

Look for:
- `[BWS] Listing secrets...` — list request started
- `[BWS] Found N secrets` — secrets discovered
- `[BWS] Getting secret: <name>` — retrieval started
- `[BWS] Retrieved: <key>` — secret retrieved
- `[BWS] List failed:` or `[BWS] Get failed:` — errors

## Troubleshooting

### "BWS_ACCESS_TOKEN is not configured"

The MCP server was registered without the `BWS_ACCESS_TOKEN` env var, or it's empty. Re-run:

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name bitwarden_secrets \
  --command bun \
  --args '["run", "/app/src/bitwarden-secrets-mcp-stdio.ts"]' \
  --env '{"BWS_ACCESS_TOKEN":"<access-token>"}'
```

Then restart the group.

### "bws: command not found"

The container image wasn't rebuilt after adding the `bws` install step to the Dockerfile. Run:

```bash
./container/build.sh
ncl groups restart --id <agent-group-id> --rebuild
```

### Agent can't see secrets that exist

The machine account doesn't have access to the project containing those secrets. In Bitwarden Secrets Manager:
1. Open the machine account
2. Verify it has **Can read** access to the correct project
3. Generate a new access token if the old one was revoked

### Token expired or revoked

Generate a new access token for the machine account in Bitwarden, then update the MCP server config:

```bash
ncl groups config add-mcp-server \
  --id <agent-group-id> \
  --name bitwarden_secrets \
  --command bun \
  --args '["run", "/app/src/bitwarden-secrets-mcp-stdio.ts"]' \
  --env '{"BWS_ACCESS_TOKEN":"<new-access-token>"}'

ncl groups restart --id <agent-group-id>
```

### Agent sees secrets from wrong project

Each machine account should be scoped to exactly one project. If the machine account has access to multiple projects, all their secrets are visible. To restrict:
1. Remove the machine account's access to unwanted projects in Bitwarden
2. Or create a separate machine account with narrower access
