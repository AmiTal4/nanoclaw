/**
 * Credential-health module.
 *
 * Registers the `credential_alert` delivery action: the agent-runner raises
 * one when a provider reports that its vaulted credential is dead, and this
 * turns it into an operator-facing log line plus a DM to whoever can renew it.
 *
 * See ./alert.ts for why alerts are keyed by provider rather than by group.
 *
 * TRUST BOUNDARY. This row crosses container → host, and `outbound.db` lives
 * on a writable mount — so a compromised container can author one directly,
 * not only through the runner. That matters because the alert reaches the
 * OWNER's DM regardless of the agent group's own destination grants, and its
 * body carries a real destructive runbook line (delete this secret). So the
 * payload is treated as untrusted:
 *
 *   - The provider name is NOT read from the payload. It is resolved
 *     host-side from the session's own config, exactly as the spawn path
 *     resolves it. A forged row therefore cannot claim a provider this
 *     session does not run, cannot get a runbook for someone else's
 *     credential in front of the owner, and — since the alert cooldown is
 *     keyed by provider — cannot mint unlimited cooldown buckets by varying
 *     the string to fan out DMs.
 *   - The free-text detail is bounded and rendered as quoted, attributed
 *     text (see ./alert.ts), never as instructions.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { resolveProviderName } from '../../container-runner.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/types.js';
import { log } from '../../log.js';
import { raiseCredentialAlert } from './alert.js';

registerDeliveryAction(
  'credential_alert',
  async (content, session) => {
    // Authoritative provider: same precedence the container-runner uses to
    // decide what to actually spawn (session → container config → claude).
    const provider = resolveProviderName(session.agent_provider, getContainerConfig(session.agent_group_id)?.provider);

    const claimed = typeof content.provider === 'string' ? content.provider : '';
    if (claimed && claimed.toLowerCase() !== provider) {
      // Not fatal — we alert on the real provider anyway — but a mismatch is
      // never expected from the runner, so it is worth a trail.
      log.warn('credential_alert provider mismatch — using resolved provider', {
        sessionId: session.id,
        claimed,
        resolved: provider,
      });
    }

    const detail = typeof content.detail === 'string' ? content.detail : '';
    await raiseCredentialAlert({ provider, detail, session });
  },
  // The payload grants nothing: the provider is re-derived host-side and the
  // detail is quoted, bounded text. What remains is a log line and a DM to an
  // already-privileged user, so there is no capability here to authorize.
  unguarded('diagnostic notification — payload is untrusted input, not a privileged request'),
);
