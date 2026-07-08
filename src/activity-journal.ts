/**
 * Host-written per-agent-group activity journal.
 *
 * One agent group runs many sessions (one per chat/thread), each in its own
 * container with its own message history and scheduled tasks. The sessions
 * share a workspace but otherwise cannot see each other, so an agent's own
 * parallel activity (a sibling session writing memory files, scheduling a
 * task, or messaging a chat) reads as unexplained — and security-minded
 * agents escalate it as tampering (this happened; see the cross-session
 * mirror work in delivery.ts for the message-level half of the fix).
 *
 * The journal closes that gap: the host appends one line per routed/delivered
 * message and per task lifecycle change to `activity-log.md` in the group
 * workspace. Containers get it as a nested READ-ONLY mount (container-runner),
 * which is what makes it trustworthy provenance — only the host can write it,
 * same principle as the formatter's host-only message attributes.
 *
 * Invariants:
 *  - Never throws: journaling must not break routing or delivery.
 *  - Appends and rotations keep the same inode (append / in-place truncate,
 *    never rename), so the container's bind mount stays live.
 *  - Never creates the group folder: an unprovisioned group has no workspace
 *    for a journal, and tests that don't set up folders stay side-effect free.
 *  - Per-group opt-out via `container_configs.activity_journal = 'off'`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';

export const ACTIVITY_LOG_FILENAME = 'activity-log.md';

const MAX_BYTES = 256 * 1024;
const KEEP_BYTES = 128 * 1024;
const EXCERPT_CHARS = 120;

const HEADER =
  "<!-- activity-log.md — journal of this agent group's activity across ALL of its sessions,\n" +
  '     written by the NanoClaw host (read-only inside containers; agents cannot edit it).\n' +
  '     Format: <utc-time> [in|out|task-*] <chat> [from_session=<sender session>] session=<receiving session> :: <excerpt> -->\n';

export function activityLogPath(groupFolder: string): string {
  return path.join(GROUPS_DIR, groupFolder, ACTIVITY_LOG_FILENAME);
}

export function journalEnabled(agentGroupId: string): boolean {
  return (getContainerConfig(agentGroupId)?.activity_journal ?? 'on') !== 'off';
}

/**
 * Ensure the journal file exists for a provisioned group. Called by the
 * container runner before mounting so the RO bind mount has a target.
 * Returns the host path, or null when disabled/unprovisioned.
 */
export function ensureActivityLog(agentGroupId: string): string | null {
  try {
    if (!journalEnabled(agentGroupId)) return null;
    const group = getAgentGroup(agentGroupId);
    if (!group) return null;
    const dir = path.join(GROUPS_DIR, group.folder);
    if (!fs.existsSync(dir)) return null;
    const file = activityLogPath(group.folder);
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
    return file;
  } catch (err) {
    log.warn('Activity journal ensure failed', { agentGroupId, err });
    return null;
  }
}

export function journalMessageIn(
  agentGroupId: string,
  sessionId: string,
  msg: {
    channelType?: string | null;
    platformId?: string | null;
    content: string;
    trigger?: 0 | 1;
    sourceSessionId?: string | null;
  },
): void {
  const content = parseContent(msg.content);
  const sender = firstString(content.senderName, content.sender, content.author?.fullName);
  // `session=` is the RECEIVING session; `from_session=` (a2a only) is the
  // sender's session. Without the latter, a reader comparing [in] lines sees
  // the same session id on every row and wrongly concludes one peer session
  // sent them all — browser "proved" a forgery from exactly that misreading.
  const fromSession = msg.sourceSessionId ? ` from_session=${msg.sourceSessionId}` : '';
  append(
    agentGroupId,
    `[in] ${chatLabel(msg.channelType, msg.platformId)}${fromSession}${sender ? ` sender=${JSON.stringify(sender)}` : ''}` +
      `${msg.trigger === 0 ? ' (context-only)' : ''} session=${sessionId} :: ${excerpt(content)}`,
  );
}

export function journalMessageOut(
  agentGroupId: string,
  sessionId: string,
  chat: { channelType?: string | null; platformId?: string | null; name?: string | null },
  rawContent: string,
): void {
  const label = chat.name || chatLabel(chat.channelType, chat.platformId);
  append(agentGroupId, `[out] ${label} session=${sessionId} :: ${excerpt(parseContent(rawContent))}`);
}

export function journalTask(
  agentGroupId: string,
  sessionId: string,
  verb: 'scheduled' | 'cancelled' | 'paused' | 'resumed' | 'updated',
  taskId: string,
  detail?: string,
): void {
  append(agentGroupId, `[task-${verb}] ${taskId}${detail ? ` ${detail}` : ''} session=${sessionId}`);
}

function append(agentGroupId: string, line: string): void {
  try {
    if (!journalEnabled(agentGroupId)) return;
    const group = getAgentGroup(agentGroupId);
    if (!group) return;
    if (!fs.existsSync(path.join(GROUPS_DIR, group.folder))) return;
    const file = activityLogPath(group.folder);
    if (!fs.existsSync(file)) fs.writeFileSync(file, HEADER);
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch (err) {
    log.warn('Activity journal write failed', { agentGroupId, err });
  }
}

/**
 * In-place rotation: drop the oldest half once the file exceeds MAX_BYTES.
 * writeFileSync truncates the existing inode rather than replacing it, so
 * running containers' bind mounts keep seeing the live file.
 */
function rotateIfNeeded(file: string): void {
  if (fs.statSync(file).size <= MAX_BYTES) return;
  const text = fs.readFileSync(file, 'utf8');
  let tail = text.slice(-KEEP_BYTES);
  const firstNewline = tail.indexOf('\n');
  if (firstNewline !== -1) tail = tail.slice(firstNewline + 1);
  fs.writeFileSync(file, `${HEADER}<!-- rotated: older entries dropped -->\n${tail}`);
}

function chatLabel(channelType?: string | null, platformId?: string | null): string {
  if (!channelType && !platformId) return 'unknown';
  return `${channelType ?? '?'}:${platformId ?? '?'}`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseContent(json: string): any {
  try {
    return JSON.parse(json);
  } catch {
    return { text: json };
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function excerpt(content: any): string {
  let text: string;
  const op = content.operation as string | undefined;
  if (op === 'poll') text = `[poll] ${String(content.name ?? '')}`;
  else if (op === 'event') text = `[event] ${String(content.name ?? '')}`;
  else if (op === 'reaction') text = `[reaction] ${String(content.emoji ?? '')}`;
  else if (op === 'contact') text = `[contact] ${String(content.displayName ?? '')}`;
  else text = typeof content.text === 'string' ? content.text : '';
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat); // code points — never split surrogate pairs
  if (chars.length <= EXCERPT_CHARS) return flat || '(no text)';
  return `${chars.slice(0, EXCERPT_CHARS).join('')}…`;
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) if (typeof v === 'string' && v) return v;
  return null;
}
