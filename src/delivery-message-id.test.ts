import { describe, expect, it } from 'vitest';

import { toPlatformMessageContent } from './delivery.js';

const AG = 'ag-1781724069056-npjd5z';

describe('toPlatformMessageContent — agent-scoped inbound ids', () => {
  it('strips this agent group suffix from a reaction target', () => {
    const raw = JSON.stringify({ operation: 'reaction', messageId: `3EB06B74D2ADB443CF133C:${AG}`, emoji: '👍' });
    expect(JSON.parse(toPlatformMessageContent(raw, AG))).toEqual({
      operation: 'reaction',
      messageId: '3EB06B74D2ADB443CF133C',
      emoji: '👍',
    });
  });

  it('strips the suffix from an edit target', () => {
    const raw = JSON.stringify({ operation: 'edit', messageId: `1789.0001:${AG}`, text: 'x' });
    expect(JSON.parse(toPlatformMessageContent(raw, AG)).messageId).toBe('1789.0001');
  });

  it('keeps colons that belong to the platform id itself', () => {
    const raw = JSON.stringify({ operation: 'reaction', messageId: `chat:42:${AG}`, emoji: '👍' });
    expect(JSON.parse(toPlatformMessageContent(raw, AG)).messageId).toBe('chat:42');
  });

  it("leaves another agent group's suffix and unsuffixed ids untouched", () => {
    const other = JSON.stringify({ operation: 'reaction', messageId: 'MSG:ag-other', emoji: '👍' });
    const plain = JSON.stringify({ operation: 'reaction', messageId: 'MSG', emoji: '👍' });
    expect(toPlatformMessageContent(other, AG)).toBe(other);
    expect(toPlatformMessageContent(plain, AG)).toBe(plain);
  });

  it('passes ordinary messages and non-JSON content through unchanged', () => {
    const text = JSON.stringify({ text: `hello :${AG}` });
    expect(toPlatformMessageContent(text, AG)).toBe(text);
    expect(toPlatformMessageContent('not json', AG)).toBe('not json');
  });
});
