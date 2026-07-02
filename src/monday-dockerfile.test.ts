/**
 * Dependency guard for the monday.com MCP server (host/vitest tree).
 *
 * `@mondaydotcomorg/monday-api-mcp` is a stdio CLI installed globally in the
 * image, not an imported module, so no behavior test can drive it and `tsc`
 * never sees it. The only in-tree footprint of this skill is the Dockerfile
 * edit, so the guard is structural: assert the pinned `ARG` and the pnpm
 * global-install line both exist. Drop either Phase 2 Dockerfile edit and
 * this goes red.
 */
import fs from 'fs';
import path from 'path';

import { describe, it, expect } from 'vitest';

function dockerfile(): string {
  const p = path.resolve(process.cwd(), 'container/Dockerfile');
  return fs.readFileSync(p, 'utf8');
}

describe('container/Dockerfile installs @mondaydotcomorg/monday-api-mcp', () => {
  const text = dockerfile();

  it('pins the version via an ARG', () => {
    expect(text).toMatch(/^\s*ARG\s+MONDAY_MCP_VERSION=/m);
  });

  it('installs the package pinned to that ARG in a pnpm global-install block', () => {
    // Match `pnpm install -g ... "@mondaydotcomorg/monday-api-mcp@${MONDAY_MCP_VERSION}"`,
    // tolerating line continuations between `install -g` and the package.
    const installsMonday = /pnpm\s+install\s+-g[\s\S]*?@mondaydotcomorg\/monday-api-mcp@\$\{MONDAY_MCP_VERSION\}/.test(
      text,
    );
    expect(installsMonday).toBe(true);
  });
});
