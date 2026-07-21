/**
 * Slack channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Supports multiple bot identities ("teammates") as named instances:
 * SLACK_INSTANCES=haim,moshe registers `slack-haim` / `slack-moshe`, each
 * reading SLACK_BOT_TOKEN_<NAME> / SLACK_SIGNING_SECRET_<NAME> and serving
 * its own webhook route (/webhook/slack-<name>). The default instance keeps
 * the legacy env vars and route so single-bot installs are unchanged.
 */
import { createSlackAdapter } from '@chat-adapter/slack';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const SLACK_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
function registerSlackInstance(registryKey: string, envSuffix: string, instance?: string): void {
  registerChannelAdapter(registryKey, {
    factory: () => {
      const tokenKey = `SLACK_BOT_TOKEN${envSuffix}`;
      const secretKey = `SLACK_SIGNING_SECRET${envSuffix}`;
      const appKey = `SLACK_APP_TOKEN${envSuffix}`;
      const env = readEnvFile([tokenKey, secretKey, appKey]);
      if (!env[tokenKey]) return null;
      const useSocketMode = Boolean(env[appKey]);
      const slackAdapter = createSlackAdapter({
        botToken: env[tokenKey],
        appToken: useSocketMode ? env[appKey] : undefined,
        mode: useSocketMode ? 'socket' : 'webhook',
        signingSecret: env[secretKey],
      });
      const bridge = createChatSdkBridge({
        adapter: slackAdapter,
        concurrency: 'concurrent',
        supportsThreads: true,
        defaults: SLACK_DEFAULTS,
        instance,
      });
      bridge.resolveChannelName = async (platformId: string) => {
        try {
          const info = await slackAdapter.fetchThread(platformId);
          return (info as { channelName?: string }).channelName ?? null;
        } catch {
          return null;
        }
      };
      return bridge;
    },
    defaults: SLACK_DEFAULTS,
  });
}

// Default instance — legacy env vars, registry key = channelType.
registerSlackInstance('slack', '');

// Named instances. Registration must happen at import time, so the instance
// list itself lives in env; each entry's credentials are read lazily by the
// factory (missing creds skip that instance without failing the others).
const { SLACK_INSTANCES } = readEnvFile(['SLACK_INSTANCES']);
for (const raw of (SLACK_INSTANCES ?? '').split(',')) {
  const name = raw.trim().toLowerCase();
  if (!name) continue;
  const suffix = `_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  registerSlackInstance(`slack-${name}`, suffix, `slack-${name}`);
}
