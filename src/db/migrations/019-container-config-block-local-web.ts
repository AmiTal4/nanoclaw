import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration019: Migration = {
  version: 19,
  name: 'container-config-block-local-web',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disabled_tools TEXT NOT NULL DEFAULT '[]'").run();
    db.prepare('ALTER TABLE container_configs ADD COLUMN block_local_web_fetch INTEGER NOT NULL DEFAULT 0').run();
  },
};
