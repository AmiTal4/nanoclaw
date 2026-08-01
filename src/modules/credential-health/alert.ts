/**
 * Credential-expiry alerting.
 *
 * When a provider's vaulted credential dies, the container is structurally
 * unable to fix it — OneCLI holds the real secret and injects it on the wire,
 * so only an operator can re-authenticate. The agent-runner detects the
 * condition (`AgentProvider.isAuthFailure`) and raises a `credential_alert`
 * system message; this module turns that into the two things that were
 * missing when it happened for real:
 *
 *   1. An ERROR line in `logs/nanoclaw.error.log`. Before this, a dead
 *      credential reached the host only as absolute-ceiling container kills
 *      half an hour later, with the causing 401 visible nowhere outside the
 *      provider's own log database.
 *   2. A DM to the operator who can actually fix it, naming the provider and
 *      the command that fixes it.
 *
 * Alerts are keyed by PROVIDER, not by agent group: one vault credential
 * backs every group on that provider, so five groups failing is one incident.
 * Without that, the 2026-08-01 expiry would have fanned out an alert per
 * group per turn — the shape of the flood incidents this codebase already
 * carries suppressors for.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { pickApprovalDelivery, pickApprover } from '../approvals/primitive.js';

/**
 * One alert per provider per window. A dead credential stays dead until
 * someone acts, and every turn against it re-raises — the window is what
 * keeps a days-long outage from becoming a days-long stream of DMs. Long
 * enough to be quiet, short enough to re-surface an ignored outage daily.
 */
export const ALERT_COOLDOWN_MS = 6 * 60 * 60_000;

/** Last alert time per provider. In-memory: a host restart re-alerts, which is the safe direction. */
const lastAlertAt = new Map<string, number>();

/** Test seam — reset between cases. */
export function resetCredentialAlertState(): void {
  lastAlertAt.clear();
}

/**
 * Cap on the provider error text echoed into the DM. The string originates
 * inside the container, so it is untrusted: bounded here so a forged or
 * runaway row cannot turn one alert into a wall of attacker-chosen text in
 * the owner's DM, and rendered as an attributed quote below rather than as
 * part of the instructions.
 */
const MAX_DETAIL_CHARS = 300;

export interface CredentialAlert {
  provider: string;
  /** Raw provider error text. Untrusted container output — quoted, never instructions. */
  detail: string;
  session: Session;
}

/** One line, bounded, no leading markers that could pass for our own prose. */
function sanitizeDetail(detail: string): string {
  const flat = detail.replace(/\s+/g, ' ').trim();
  if (!flat) return '(none reported)';
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}…` : flat;
}

/**
 * How an operator fixes it, per provider. Unknown providers get generic
 * wording rather than a wrong command — a confidently wrong runbook line is
 * worse than none.
 */
function remediation(provider: string): string {
  if (provider === 'codex') {
    return (
      'Re-authenticate with:\n' +
      '  onecli secrets delete --id <codex-secret-id>\n' +
      '  pnpm exec tsx setup/index.ts --step provider-auth codex\n' +
      'The auth step short-circuits while any OpenAI secret exists, so the stale one must go first.'
    );
  }
  return `Re-authenticate the ${provider} credential in the OneCLI vault.`;
}

/**
 * Raise a credential alert. Returns true when an alert was actually sent
 * (false = suppressed by the per-provider cooldown).
 */
export async function raiseCredentialAlert(alert: CredentialAlert, nowMs: number = Date.now()): Promise<boolean> {
  const { provider, detail, session } = alert;

  const group = getAgentGroup(session.agent_group_id);
  const groupName = group?.name ?? session.agent_group_id;

  // Log every occurrence, alert on the first per window: the log is the
  // operator's forensic trail (which groups, how often, since when) and
  // costs nothing, while the DM is the interrupt.
  log.error('Provider credential failed — agent cannot authenticate', {
    provider,
    agentGroupId: session.agent_group_id,
    agentGroup: groupName,
    sessionId: session.id,
    detail,
  });

  const last = lastAlertAt.get(provider);
  if (last !== undefined && nowMs - last < ALERT_COOLDOWN_MS) {
    log.info('Credential alert suppressed by cooldown', { provider, agentGroup: groupName });
    return false;
  }
  lastAlertAt.set(provider, nowMs);

  const approvers = pickApprover(session.agent_group_id);
  if (approvers.length === 0) {
    log.error('Credential alert has no owner or admin to notify', { provider });
    return false;
  }

  const originChannelType = session.messaging_group_id
    ? (getMessagingGroup(session.messaging_group_id)?.channel_type ?? '')
    : '';
  const target = await pickApprovalDelivery(approvers, originChannelType);
  if (!target) {
    log.error('Credential alert has no reachable DM for any approver', { provider, approvers });
    return false;
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    log.error('Credential alert could not be delivered — no delivery adapter', { provider });
    return false;
  }

  const text =
    `⚠️ The ${provider} credential has expired.\n\n` +
    `${groupName} could not authenticate, and every agent group on ${provider} is affected — ` +
    `they share one vault credential. Agents will keep queueing messages until it's renewed.\n\n` +
    `${remediation(provider)}\n\n` +
    `Reported by the ${groupName} container: "${sanitizeDetail(detail)}"`;

  try {
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      target.messagingGroup.instance ?? undefined,
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- an alert that cannot be delivered must never take down the turn that raised it; the credential failure is already logged above
  } catch (err) {
    // Let the next occurrence retry rather than staying quiet for the whole
    // window on one delivery hiccup.
    lastAlertAt.delete(provider);
    log.error('Failed to deliver credential alert', { provider, approver: target.userId, err });
    return false;
  }

  log.info('Credential alert delivered', { provider, approver: target.userId, agentGroup: groupName });
  return true;
}
