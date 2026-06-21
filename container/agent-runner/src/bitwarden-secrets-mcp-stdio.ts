/**
 * Bitwarden Secrets Manager MCP Server for NanoClaw
 *
 * Exposes secrets from a Bitwarden Secrets Manager project as read-only tools
 * for the container agent. Uses the `bws` CLI under the hood, authenticated via
 * a token file mounted read-only into the container.
 *
 * Token resolution order:
 *   1. BWS_ACCESS_TOKEN_FILE env var → read token from that file path
 *   2. BWS_ACCESS_TOKEN env var → use directly (fallback)
 *
 * The machine account's project assignment in Bitwarden is the access-control
 * boundary — the agent can only see secrets the machine account has access to.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

function log(msg: string): void {
  console.error(`[BWS] ${msg}`);
}

function resolveToken(): string {
  const tokenFile = process.env.BWS_ACCESS_TOKEN_FILE;
  if (tokenFile) {
    try {
      return fs.readFileSync(tokenFile, 'utf8').trim();
    } catch {
      log(`Failed to read token file: ${tokenFile}`);
    }
  }
  return process.env.BWS_ACCESS_TOKEN || '';
}

const BWS_ACCESS_TOKEN = resolveToken();

interface BwsSecret {
  id: string;
  key: string;
  value: string;
  note: string;
  projectId: string;
  organizationId: string;
  creationDate: string;
  revisionDate: string;
}

async function bwsExec(args: string[]): Promise<string> {
  const proc = Bun.spawn(['bws', ...args], {
    env: { ...process.env, BWS_ACCESS_TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const msg = stderr.trim() || `bws exited with code ${exitCode}`;
    throw new Error(msg);
  }

  return stdout.trim();
}

const server = new McpServer({
  name: 'bitwarden_secrets',
  version: '1.0.0',
});

server.tool(
  'bitwarden_list_secrets',
  'List all secrets available to this agent. Returns name and ID for each secret (not the secret values). Use bitwarden_get_secret to retrieve a specific value.',
  {},
  async () => {
    if (!BWS_ACCESS_TOKEN) {
      return {
        content: [{ type: 'text', text: 'BWS_ACCESS_TOKEN is not configured. Ask the operator to set up Bitwarden Secrets Manager for this agent group.' }],
        isError: true,
      };
    }

    log('Listing secrets...');
    try {
      const raw = await bwsExec(['secret', 'list']);
      const secrets: BwsSecret[] = JSON.parse(raw);

      if (secrets.length === 0) {
        return {
          content: [{ type: 'text', text: 'No secrets found. The machine account may not have any secrets assigned.' }],
        };
      }

      const listing = secrets.map((s) => `- ${s.key} (id: ${s.id})`).join('\n');
      log(`Found ${secrets.length} secrets`);
      return {
        content: [{ type: 'text', text: `${secrets.length} secret(s) available:\n${listing}` }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`List failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `Failed to list secrets: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  'bitwarden_get_secret',
  'Retrieve a secret value by its name or ID. Returns the key, value, and note.',
  {
    identifier: z
      .string()
      .describe('The secret name (key) or UUID. If a name is given and multiple match, the first is returned.'),
  },
  async ({ identifier }) => {
    if (!BWS_ACCESS_TOKEN) {
      return {
        content: [{ type: 'text', text: 'BWS_ACCESS_TOKEN is not configured.' }],
        isError: true,
      };
    }

    log(`Getting secret: ${identifier}`);
    try {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identifier);

      let secret: BwsSecret;

      if (isUuid) {
        const raw = await bwsExec(['secret', 'get', identifier]);
        secret = JSON.parse(raw);
      } else {
        const raw = await bwsExec(['secret', 'list']);
        const secrets: BwsSecret[] = JSON.parse(raw);
        const match = secrets.find((s) => s.key.toLowerCase() === identifier.toLowerCase());
        if (!match) {
          return {
            content: [{ type: 'text', text: `No secret found with name "${identifier}". Use bitwarden_list_secrets to see available secrets.` }],
            isError: true,
          };
        }
        const raw2 = await bwsExec(['secret', 'get', match.id]);
        secret = JSON.parse(raw2);
      }

      log(`Retrieved: ${secret.key}`);
      const parts = [`Key: ${secret.key}`, `Value: ${secret.value}`];
      if (secret.note) parts.push(`Note: ${secret.note}`);
      return {
        content: [{ type: 'text', text: parts.join('\n') }],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Get failed: ${msg}`);
      return {
        content: [{ type: 'text', text: `Failed to get secret: ${msg}` }],
        isError: true,
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
