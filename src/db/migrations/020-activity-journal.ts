import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'activity-journal',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN activity_journal TEXT NOT NULL DEFAULT 'on';`);
  },
};
