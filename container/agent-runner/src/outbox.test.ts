import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { enqueueFileOut } from './outbox.js';

let outboxDir: string;
let srcDir: string;

beforeEach(() => {
  initTestSessionDb();
  outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-outbox-'));
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-src-'));
  process.env.NANOCLAW_OUTBOX_DIR = outboxDir;
});

afterEach(() => {
  closeSessionDb();
  delete process.env.NANOCLAW_OUTBOX_DIR;
  fs.rmSync(outboxDir, { recursive: true, force: true });
  fs.rmSync(srcDir, { recursive: true, force: true });
});

function writeSrc(name: string, bytes: string): string {
  const p = path.join(srcDir, name);
  fs.writeFileSync(p, bytes);
  return p;
}

describe('enqueueFileOut', () => {
  it('stages the file under the outbox and enqueues a messages_out row with files[]', async () => {
    const src = writeSrc('ig_abc.png', 'PNGDATA');

    const { id, filename } = await enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'chan-1', channel_type: 'discord', thread_id: 'thr-9', in_reply_to: 'm1' },
      text: 'here you go',
    });

    const staged = path.join(outboxDir, id, filename);
    expect(fs.readFileSync(staged, 'utf8')).toBe('PNGDATA');

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].thread_id).toBe('thr-9');
    expect(out[0].in_reply_to).toBe('m1');
    expect(JSON.parse(out[0].content)).toEqual({ text: 'here you go', files: ['ig_abc.png'] });
  });

  it('defaults filename to the basename and text to empty', async () => {
    const src = writeSrc('chart.png', 'X');

    const { filename } = await enqueueFileOut({
      srcPath: src,
      routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
    });

    expect(filename).toBe('chart.png');
    expect(JSON.parse(getUndeliveredMessages()[0].content)).toEqual({ text: '', files: ['chart.png'] });
  });

  it('throws when the source file is missing and enqueues nothing', async () => {
    await expect(
      enqueueFileOut({
        srcPath: path.join(srcDir, 'does-not-exist.png'),
        routing: { platform_id: 'C-1', channel_type: 'slack', thread_id: null },
      }),
    ).rejects.toThrow();
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});
