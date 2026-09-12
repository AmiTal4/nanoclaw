import { describe, expect, it } from 'vitest';

import { seenReactionContent } from './router.js';

describe('seenReactionContent — host 👀 on routed messages', () => {
  it('builds a seen-flagged 👀 reaction for WhatsApp messages', () => {
    expect(JSON.parse(seenReactionContent('whatsapp', '3EB0ABC')!)).toEqual({
      operation: 'reaction',
      messageId: '3EB0ABC',
      emoji: '👀',
      seen: true,
    });
  });

  it('skips other channels and messages without a platform id', () => {
    expect(seenReactionContent('slack', '1789.0001')).toBeNull();
    expect(seenReactionContent('whatsapp', undefined)).toBeNull();
    expect(seenReactionContent('whatsapp', '')).toBeNull();
  });
});
