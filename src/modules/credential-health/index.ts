/**
 * Credential-health module.
 *
 * Registers the `credential_alert` delivery action: the agent-runner raises
 * one when a provider reports that its vaulted credential is dead, and this
 * turns it into an operator-facing log line plus a DM to whoever can renew it.
 *
 * See ./alert.ts for why alerts are keyed by provider rather than by group.
 */
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/types.js';
import { log } from '../../log.js';
import { raiseCredentialAlert } from './alert.js';

registerDeliveryAction(
  'credential_alert',
  async (content, session) => {
    const provider = typeof content.provider === 'string' ? content.provider : '';
    if (!provider) {
      log.warn('credential_alert missing provider', { sessionId: session.id });
      return;
    }
    const detail = typeof content.detail === 'string' ? content.detail : '';
    await raiseCredentialAlert({ provider, detail, session });
  },
  // Raised by the runner itself, never by agent tool-calls, and it grants
  // nothing: the effect is a log line and a DM to an existing owner/admin,
  // both on paths the agent could already reach. Nothing to gate.
  unguarded('diagnostic notification — no privileged effect to authorize'),
);
