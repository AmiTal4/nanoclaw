import { describe, expect, test } from 'bun:test';

import { isLocalOrPrivateUrl } from './claude.js';

describe('Claude WebFetch network safety', () => {
  test.each([
    'http://localhost/admin',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.31.2.3/',
    'http://192.168.1.2/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'file:///etc/passwd',
  ])('blocks %s', async (url) => {
    expect(await isLocalOrPrivateUrl(url)).toBe(true);
  });

  test('allows a literal public address', async () => {
    expect(await isLocalOrPrivateUrl('https://8.8.8.8/')).toBe(false);
  });
});
