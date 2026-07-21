/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction, send_poll, send_event, send_contact.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { findByName, getAllDestinations } from '../destinations.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { getCurrentInReplyTo } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * Look up the explicitly named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
function resolveRouting(
  to: string,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description: 'Send a message to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "family", "worker-1").',
        },
        text: { type: 'string', description: 'Message content' },
      },
      required: ['to', 'text'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const text = args.text as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!text) return err('text is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text }),
    });

    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['to', 'path'],
    },
  },
  async handler(args) {
    const to = args.to as string;
    const filePath = args.path as string;
    if (!to) return err(`to is required. Options: ${destinationList()}`);
    if (!filePath) return err('path is required');

    const routing = resolveRouting(to);
    if ('error' in routing) return err(routing.error);

    const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve('/workspace/agent', filePath);
    if (!fs.existsSync(resolvedPath)) return err(`File not found: ${filePath}`);

    const id = generateId();
    const filename = (args.filename as string) || path.basename(resolvedPath);

    const outboxDir = path.join('/workspace/outbox', id);
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.copyFileSync(resolvedPath, path.join(outboxDir, filename));

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [filename] }),
    });

    log(`send_file: ${id} → ${routing.resolvedName} (${filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

export const sendPoll: McpToolDefinition = {
  tool: {
    name: 'send_poll',
    description:
      'Send a poll to a named destination (renders as a native poll on WhatsApp). Recipients tap options to vote. The `to` destination is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Required destination name.' },
        name: { type: 'string', description: 'The poll question shown at the top of the poll.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Answer options (2-12 short strings).',
        },
        allowMultipleAnswers: {
          type: 'boolean',
          description: 'Allow voters to pick more than one option (default false = single choice).',
        },
      },
      required: ['to', 'name', 'options'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!args.to) return err('to is required');
    const rawOptions = args.options as unknown;
    if (!name) return err('name is required');
    if (!Array.isArray(rawOptions) || rawOptions.length < 2) {
      return err('options must be an array of at least 2 strings');
    }
    const values = rawOptions.map((o) => String(o).trim()).filter(Boolean);
    if (values.length < 2) return err('at least 2 non-empty options are required');
    const allowMultiple = args.allowMultipleAnswers === true;

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        operation: 'poll',
        name,
        values,
        selectableCount: allowMultiple ? values.length : 1,
      }),
    });

    log(`send_poll: #${seq} -> ${routing.resolvedName} (${values.length} options)`);
    return ok(`Poll sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendEvent: McpToolDefinition = {
  tool: {
    name: 'send_event',
    description:
      'Send an event invite to a named destination (renders as a native event card on WhatsApp). The `to` destination is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Required destination name.' },
        name: { type: 'string', description: 'Event title.' },
        startTime: {
          type: 'string',
          description: 'Event start time as an ISO 8601 timestamp (e.g. 2026-07-01T18:00:00Z).',
        },
        endTime: { type: 'string', description: 'Optional end time as an ISO 8601 timestamp.' },
        description: { type: 'string', description: 'Optional event description.' },
        location: { type: 'string', description: 'Optional location name or address.' },
        call: {
          type: 'string',
          enum: ['audio', 'video'],
          description: 'Optionally attach a WhatsApp call link of this type.',
        },
      },
      required: ['to', 'name', 'startTime'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!args.to) return err('to is required');
    const startTime = args.startTime as string;
    if (!name) return err('name is required');
    if (!startTime) return err('startTime is required (ISO 8601 timestamp)');
    if (Number.isNaN(new Date(startTime).getTime())) {
      return err('startTime is not a valid ISO 8601 timestamp');
    }
    let endTime: string | undefined;
    if (args.endTime) {
      endTime = args.endTime as string;
      if (Number.isNaN(new Date(endTime).getTime())) {
        return err('endTime is not a valid ISO 8601 timestamp');
      }
    }
    const call = args.call as string | undefined;
    if (call && call !== 'audio' && call !== 'video') {
      return err('call must be "audio" or "video"');
    }

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({
        operation: 'event',
        name,
        startTime,
        ...(endTime && { endTime }),
        ...(args.description && { description: String(args.description) }),
        ...(args.location && { location: String(args.location) }),
        ...(call && { call }),
      }),
    });

    log(`send_event: #${seq} -> ${routing.resolvedName}`);
    return ok(`Event sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

function buildVCard(opts: { name: string; phones: string[]; org?: string; email?: string }): string {
  const clean = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();
  const name = clean(opts.name);
  const lines = ['BEGIN:VCARD', 'VERSION:3.0', `N:;${name};;;`, `FN:${name}`];
  for (const p of opts.phones) {
    const num = p.trim();
    const waid = num.replace(/[^0-9]/g, '');
    lines.push(`TEL;type=CELL;type=VOICE;waid=${waid}:${num}`);
  }
  if (opts.org) lines.push(`ORG:${clean(opts.org)}`);
  if (opts.email) lines.push(`EMAIL;type=INTERNET:${clean(opts.email)}`);
  lines.push('END:VCARD');
  return lines.join('\n');
}

export const sendContact: McpToolDefinition = {
  tool: {
    name: 'send_contact',
    description:
      'Send a contact card (vCard) to a named destination. On WhatsApp it renders as a tappable contact. The `to` destination is required.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Required destination name.' },
        name: { type: 'string', description: "Contact's full display name." },
        phone: { type: 'string', description: 'Phone number in international format, e.g. +972501234567.' },
        phones: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional additional phone numbers (international format).',
        },
        org: { type: 'string', description: 'Optional organization / company.' },
        email: { type: 'string', description: 'Optional email address.' },
      },
      required: ['to', 'name', 'phone'],
    },
  },
  async handler(args) {
    const name = args.name as string;
    if (!args.to) return err('to is required');
    const phone = args.phone as string;
    if (!name) return err('name is required');
    if (!phone) return err('phone is required');
    const extra = Array.isArray(args.phones) ? (args.phones as unknown[]).map(String) : [];
    const phones = [phone, ...extra].map((p) => p.trim()).filter(Boolean);
    if (phones.length === 0) return err('at least one phone number is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const vcard = buildVCard({
      name,
      phones,
      org: args.org as string | undefined,
      email: args.email as string | undefined,
    });
    const id = generateId();
    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'contact', displayName: name, vcard }),
    });

    log(`send_contact: #${seq} -> ${routing.resolvedName} (${name})`);
    return ok(`Contact "${name}" sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction, sendPoll, sendEvent, sendContact]);
