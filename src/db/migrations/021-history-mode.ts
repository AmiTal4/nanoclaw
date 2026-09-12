import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'history-mode',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'push';`);
  },
};
