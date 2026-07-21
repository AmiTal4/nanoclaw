import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration021: Migration = {
  version: 21,
  name: 'history-mode',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN history_mode TEXT NOT NULL DEFAULT 'push'").run();
  },
};
