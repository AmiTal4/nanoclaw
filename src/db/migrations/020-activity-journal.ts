import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration020: Migration = {
  version: 20,
  name: 'activity-journal',
  up(db: Database.Database) {
    // 'on' | 'off' — per-group switch for the host-written activity journal
    // (activity-log.md in the group workspace). See src/activity-journal.ts.
    db.prepare("ALTER TABLE container_configs ADD COLUMN activity_journal TEXT NOT NULL DEFAULT 'on'").run();
  },
};
