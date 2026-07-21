import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'container', 'cli-tools.json'), 'utf8')) as Array<{
  name: string;
  version: string;
  onlyBuilt?: boolean;
}>;

describe('container CLI manifest installs monday MCP', () => {
  it('pins the expected package and version without a build-script opt-in', () => {
    expect(manifest).toContainEqual({ name: '@mondaydotcomorg/monday-api-mcp', version: '3.2.0' });
  });
});
