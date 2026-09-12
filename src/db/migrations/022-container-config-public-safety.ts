import type { Migration } from './index.js';

export const migration022: Migration = {
  version: 22,
  name: 'container-config-block-local-web',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]';`);
    await db.exec(`ALTER TABLE container_configs ADD COLUMN block_local_web_fetch INTEGER NOT NULL DEFAULT 0;`);
  },
};
