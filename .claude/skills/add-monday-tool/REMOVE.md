# Remove monday.com Tool

Idempotent — safe to run even if some steps were never applied.

## 1. Unregister the MCP server (per group)

For each group that had monday.com wired (`ncl groups list` to enumerate):

```bash
ncl groups config remove-mcp-server --id <group-id> --name monday
```

## 2. Delete the copied test file

```bash
rm -f src/monday-dockerfile.test.ts
```

## 3. Revert the Dockerfile edit

Remove the `ARG MONDAY_MCP_VERSION=...` line and the `@mondaydotcomorg/monday-api-mcp@${MONDAY_MCP_VERSION}` entry from the pnpm global-install block in `container/Dockerfile`. Leave the other packages in that block (gmail/calendar/gworkspace) intact if present.

## 4. Rebuild and restart

```bash
pnpm run build && ./container/build.sh
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

Kill any running agent containers so they respawn without the `monday` MCP server:

```bash
docker ps -q --filter 'name=nanoclaw-v2-' | xargs -r docker kill
```

## 5. Optional: disconnect OneCLI

```bash
onecli apps disconnect --provider monday
```

There are no local stub files to clean up — this skill never wrote any (env-var-only credential).

## Verification

After removal, in a wired agent asking it "what boards do I have on monday.com?" should report no monday.com tool, and the dependency-guard test is gone:

```bash
ls src/monday-dockerfile.test.ts 2>&1   # No such file or directory
```
