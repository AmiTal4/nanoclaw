/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getAgentMailbox } from './mailbox/index.js';
import type { Destination } from './mailbox/types.js';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

export type SessionMode = { kind: 'chat' } | { kind: 'task'; taskId: string };

function destinationEntry(destination: Destination): DestinationEntry {
  return {
    name: destination.name,
    displayName: destination.displayName ?? destination.name,
    type: destination.type,
    channelType: destination.channelType ?? undefined,
    platformId: destination.platformId ?? undefined,
    agentGroupId: destination.agentGroupId ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  return getAgentMailbox().operations.getDestinations().map(destinationEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const destination = getAgentMailbox().operations.findDestinationByName(name);
  return destination && destinationEntry(destination);
}

export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const destination = getAgentMailbox().operations.findDestinationByRouting(channelType, platformId);
  return destination && destinationEntry(destination);
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string, mode: SessionMode = { kind: 'chat' }): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection(mode));

  return sections.join('\n\n');
}

function buildDestinationsSection(mode: SessionMode): string {
  const all = getAllDestinations();
  const lines = ['## Sending messages', ''];

  if (all.length === 0) {
    lines.push('You currently have no configured destinations. You cannot send messages until an admin wires one up.');
    if (mode.kind === 'chat') return lines.join('\n');
  } else if (all.length === 1) {
    const d = all[0];
    lines.push(`Your destination is \`${d.name}\`${destinationLabel(d)}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      lines.push(`- \`${d.name}\`${destinationLabel(d)}`);
    }
  }

  lines.push('');

  if (mode.kind === 'task') {
    lines.push(
      'This is an isolated task run with no attached chat. Only notify someone when the task asks you to. For a user-visible message, call `send_message({ to: "name", text: "..." })`; for a file, call `send_file` with `to`. Always pass the explicit named destination.',
    );
    const channelDestinations = all.filter((destination) => destination.type === 'channel');
    if (channelDestinations.length > 0) {
      const channelNames = channelDestinations.map((destination) => `\`${destination.name}\``).join(', ');
      lines.push(
        '',
        `For user-visible escalation output, default to your own channel destination(s): ${channelNames} — that's the operator's actual conversation with you. Use an agent-type destination like \`parent\` only when the task explicitly calls for routing through another agent, not as your default escalation path.`,
      );
    }
    lines.push(
      '',
      `Your final output is not sent to the user. End with a concise work-log summary. It is recorded automatically in \`tasks/${mode.taskId}.md\`. Read that file when you need context from earlier runs. Use \`ncl tasks append-log --msg "…"\` only for optional mid-run notes.`,
    );
    return lines.join('\n');
  }

  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  const whatsapp = all.filter((d) => d.channelType === 'whatsapp');
  lines.push(
    'The `send_message` MCP tool is the same delivery, available mid-turn — handy for a quick acknowledgment ("on it") before a slow tool call. Always pass its explicit `to` destination. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence rather than as one combined reply.' +
      (whatsapp.length > 0 ? ' On WhatsApp destinations, acknowledge with a reaction instead (see below).' : ''),
  );
  lines.push('');
  lines.push(
    'For a short turn, do not narrate. For longer work, send one acknowledgment and then updates only at meaningful milestones, especially before slow operations. Never narrate micro-steps; finish with the outcome, not a play-by-play.',
  );
  if (whatsapp.length > 0) lines.push('', buildWhatsAppReactionGuidance(whatsapp));
  return lines.join('\n');
}

function buildWhatsAppReactionGuidance(destinations: DestinationEntry[]): string {
  const names = destinations.map((d) => `\`${d.name}\``).join(', ');
  return [
    '### Reactions on WhatsApp',
    '',
    `For messages from WhatsApp destinations (${names}), reactions are part of how you talk. React with \`add_reaction({ messageId, emoji })\`, where \`messageId\` is the inbound message's \`id\` and \`emoji\` is the emoji character itself (\`"🔍"\`, not a name like \`"mag"\` — names may not render).`,
    '',
    "The host automatically puts 👀 on the newest message it hands you and removes it when your reply is delivered — never react 👀 yourself. Your own reaction on that message replaces the 👀.",
    '',
    '1. **A reaction can be the whole reply.** When a message only needs an acknowledgment or a yes/no, react instead of writing — "is everything ok?" / "you there?" → 👍, "thanks!" → ❤️, "done, sent it" → 👌. After a reaction-only reply, end your turn with no `<message>` block: output nothing, or only `<internal>…</internal>` — any other plain text is treated as an undelivered reply. Write a text reply when there is real information to give.',
    '2. **For a task, react first, then work.** When a message asks you to do something, your first action is `add_reaction` on that message — before reading files, searching, or planning. Pick an emoji that shows what you understood: 🔍 looking into it, 🛠️ fixing/building, 📅 scheduling, ✍️ writing, 🤔 needs thought. The reaction replaces an "on it" message — never send both. For longer tasks you may react ✅ when done; WhatsApp replaces your earlier reaction.',
  ].join('\n');
}

function destinationLabel(d: DestinationEntry): string {
  const parts: string[] = [];
  if (d.channelType) parts.push(d.channelType);
  if (d.displayName && d.displayName !== d.name) parts.push(d.displayName);
  return parts.length > 0 ? ` (${parts.join(' · ')})` : '';
}
