/**
 * Create a new Slack "teammate" — a separate Slack app/bot identity wired to
 * its own NanoClaw adapter instance.
 *
 * Usage:
 *   pnpm exec tsx scripts/create-slack-teammate.ts <name> \
 *     [--display "Haim"] [--description "Software engineer"] \
 *     [--config-token xoxe.xoxp-...]
 *
 * Non-interactive (two-step) mode:
 *   ... <name> --create-only            # create app, print install URL, exit
 *   ... <name> --app-id A123 --bot-token xoxb-...   # finish after install
 *
 * <name> is the instance slug (lowercase, e.g. "haim") → registry key
 * `slack-<name>`, env vars SLACK_BOT_TOKEN_<NAME>/SLACK_SIGNING_SECRET_<NAME>,
 * webhook route /webhook/slack-<name>.
 *
 * Requires:
 *   - A Slack app configuration token (create at https://api.slack.com/apps
 *     → "Your App Configuration Tokens"; valid 12h). Pass via --config-token
 *     or SLACK_CONFIG_TOKEN in .env.
 *   - WEBHOOK_PUBLIC_URL in .env (e.g. https://webhook.example.com) — the
 *     public HTTPS base that reaches this host's webhook server.
 *
 * Flow: create app via apps.manifest.create (no event subscriptions yet —
 * Slack validates request URLs at manifest time, and the adapter instance
 * can't answer until its signing secret is deployed) → write env + restart →
 * operator installs the app (one click) and pastes the bot token → write
 * token + restart → apps.manifest.update adds event subscriptions and
 * interactivity, whose URL verification the now-live instance answers.
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';

const ROOT = new URL('..', import.meta.url).pathname;
const ENV_PATH = `${ROOT}.env`;

const BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'im:write',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'groups:read',
  'users:read',
  'reactions:write',
  'files:read',
  'files:write',
];
const BOT_EVENTS = ['message.channels', 'message.groups', 'message.im', 'app_mention'];

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      flags[a.slice(2)] = argv[++i] ?? '';
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function readEnv(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_PATH)) return map;
  for (const line of readFileSync(ENV_PATH, 'utf8').split('\n')) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (m) map.set(m[1]!, m[2]!);
  }
  return map;
}

/** Set or replace KEY=value lines in .env, preserving everything else. */
function writeEnvVars(vars: Record<string, string>): void {
  let content = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(vars)) {
    const line = `${key}=${value}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    content = re.test(content)
      ? content.replace(re, line)
      : `${content}${content.endsWith('\n') || content === '' ? '' : '\n'}${line}\n`;
  }
  writeFileSync(ENV_PATH, content);
  mkdirSync(`${ROOT}data/env`, { recursive: true });
  copyFileSync(ENV_PATH, `${ROOT}data/env/env`);
}

async function slackApi(
  method: string,
  token: string,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (!json.ok) {
    const detail = json.errors ? `\n${JSON.stringify(json.errors, null, 2)}` : '';
    throw new Error(`${method} failed: ${json.error}${detail}`);
  }
  return json;
}

function buildManifest(display: string, description: string, requestUrl?: string) {
  const manifest: Record<string, unknown> = {
    display_information: { name: display, description },
    features: {
      app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
      bot_user: { display_name: display, always_online: true },
    },
    oauth_config: { scopes: { bot: BOT_SCOPES } },
    settings: { org_deploy_enabled: false, socket_mode_enabled: false, token_rotation_enabled: false },
  };
  if (requestUrl) {
    (manifest.settings as Record<string, unknown>).event_subscriptions = {
      request_url: requestUrl,
      bot_events: BOT_EVENTS,
    };
    (manifest.settings as Record<string, unknown>).interactivity = {
      is_enabled: true,
      request_url: requestUrl,
    };
  }
  return manifest;
}

function detectServiceUnit(): string | null {
  try {
    const out = execSync("systemctl --user list-units --type=service --all --no-legend 'nanoclaw*'", {
      encoding: 'utf8',
    });
    // Lines may start with a state bullet (●); helper units (e.g. the
    // github-tokens refresher) also match the glob — pick the host service.
    for (const line of out.trim().split('\n')) {
      const unit = line.replace(/^[^a-zA-Z]*/, '').split(/\s+/)[0];
      if (unit?.endsWith('.service') && !unit.includes('github-tokens')) return unit;
    }
    return null;
  } catch {
    return null;
  }
}

function restartService(unit: string): void {
  console.log(`Restarting ${unit} ...`);
  execSync(`systemctl --user restart ${unit}`, { stdio: 'inherit' });
}

async function waitForRoute(name: string, timeoutMs = 90_000): Promise<void> {
  const url = `http://localhost:3000/webhook/slack-${name}`;
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`Waiting for ${url} to come up `);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'POST', body: '{}' });
      if (res.status !== 404) {
        console.log(`— up (HTTP ${res.status})`);
        return;
      }
    } catch {
      /* server restarting */
    }
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error(`webhook route /webhook/slack-${name} did not come up within ${timeoutMs / 1000}s`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const name = positional[0]?.toLowerCase();
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    console.error(
      'Usage: pnpm exec tsx scripts/create-slack-teammate.ts <name> [--display "Haim"] [--description "..."] [--config-token xoxe.xoxp-...]',
    );
    process.exit(1);
  }
  const display = flags.display ?? name.charAt(0).toUpperCase() + name.slice(1);
  const description = flags.description ?? `${display} — NanoClaw agent`;

  const env = readEnv();
  const configToken = flags['config-token'] ?? env.get('SLACK_CONFIG_TOKEN');
  if (!configToken) {
    console.error(
      'Missing app configuration token. Create one at https://api.slack.com/apps ("Your App Configuration Tokens"),',
    );
    console.error('then pass --config-token xoxe.xoxp-... or set SLACK_CONFIG_TOKEN in .env (valid ~12h).');
    process.exit(1);
  }
  const publicBase = env.get('WEBHOOK_PUBLIC_URL')?.replace(/\/$/, '');
  if (!publicBase) {
    console.error('Missing WEBHOOK_PUBLIC_URL in .env (e.g. WEBHOOK_PUBLIC_URL=https://webhook.example.com)');
    process.exit(1);
  }
  const envKey = name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  // Guard only fresh creates — finish/repair runs (--app-id) may legitimately
  // re-run after the token is already stored.
  if (!flags['app-id'] && env.get(`SLACK_BOT_TOKEN_${envKey}`)) {
    console.error(`SLACK_BOT_TOKEN_${envKey} already exists in .env — teammate "${name}" appears to be set up.`);
    process.exit(1);
  }
  const unit = detectServiceUnit();
  if (!unit) {
    console.error("Could not find the NanoClaw systemd user unit (systemctl --user list-units 'nanoclaw*').");
    process.exit(1);
  }

  let appId = flags['app-id'];
  let botToken = flags['bot-token'];

  if (!appId) {
    // Phase 1: create the app (no event subscriptions yet — see header comment).
    console.log(`Creating Slack app "${display}" ...`);
    const created = await slackApi('apps.manifest.create', configToken, {
      manifest: JSON.stringify(buildManifest(display, description)),
    });
    appId = created.app_id as string;
    const credentials = created.credentials as { signing_secret?: string } | undefined;
    const signingSecret = credentials?.signing_secret;
    if (!appId || !signingSecret)
      throw new Error(`unexpected apps.manifest.create response: ${JSON.stringify(created)}`);
    console.log(`Created app ${appId}.`);

    // Phase 2: register the instance + signing secret so the adapter can answer
    // URL verification once the token lands.
    const instances = (env.get('SLACK_INSTANCES') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!instances.includes(name)) instances.push(name);
    writeEnvVars({
      SLACK_INSTANCES: instances.join(','),
      [`SLACK_SIGNING_SECRET_${envKey}`]: signingSecret,
    });

    // Phase 3: operator installs the app — the one step Slack keeps manual.
    console.log('\n─────────────────────────────────────────────');
    console.log('One manual step: install the app to your workspace.');
    console.log(`  1. Open  https://api.slack.com/apps/${appId}/install-on-team`);
    console.log('  2. Click "Install to Workspace" → "Allow"');
    console.log('  3. Copy the "Bot User OAuth Token" (xoxb-...)');
    console.log('─────────────────────────────────────────────\n');
    if ('create-only' in flags) {
      console.log(
        `Then finish with:\n  pnpm exec tsx scripts/create-slack-teammate.ts ${name} --display ${JSON.stringify(display)} --app-id ${appId} --bot-token <xoxb-...>`,
      );
      return;
    }
  }

  if (!botToken) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    botToken = (await rl.question('Paste the bot token (xoxb-...): ')).trim();
    rl.close();
  }
  if (!botToken.startsWith('xoxb-')) throw new Error('that does not look like a bot token (expected xoxb-...)');

  // Phase 4: deploy credentials and bring the instance up.
  writeEnvVars({ [`SLACK_BOT_TOKEN_${envKey}`]: botToken });
  restartService(unit);
  await waitForRoute(name);

  // Phase 5: now that the route answers, add event subscriptions +
  // interactivity (Slack verifies the URL during this call).
  const requestUrl = `${publicBase}/webhook/slack-${name}`;
  console.log(`Enabling event subscriptions → ${requestUrl} ...`);
  await slackApi('apps.manifest.update', configToken, {
    app_id: appId,
    manifest: JSON.stringify(buildManifest(display, description, requestUrl)),
  });

  console.log(`\n✔ Teammate "${display}" is live (instance slack-${name}, app ${appId}).`);
  console.log('\nNext steps:');
  console.log(
    `  - DM @${display} in Slack (or invite it to a channel) — the messaging group auto-creates on first message`,
  );
  console.log(
    '  - Wire it to an agent group: ncl wirings create --messaging-group-id <mg> --agent-group-id <ag> --session-mode agent-shared',
  );
  console.log("    (agent-shared = one context-shared session across all the teammate's channels/DMs/threads)");
  console.log(
    '  - Add a destination: ncl destinations add --agent-group-id <ag> --local-name <name> --target-type channel --target-id <mg>',
  );
}

main().catch((err) => {
  console.error(`\n✖ ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
