import Database from 'better-sqlite3';
import { config } from '../config.js';
import {
  ACCOUNT_COLUMNS_V2,
  MIGRATION_2_SQL,
  MIGRATION_3_SQL,
  MIGRATION_4_SQL,
  MIGRATION_5_SQL,
  MIGRATION_6_SQL,
  MIGRATION_SQL,
  MIGRATION_VERSION,
} from './migrations.js';

export const db = new Database(config.dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');
db.pragma('synchronous = NORMAL');

function hasColumn(table: string, column: string): boolean {
  const rows = db.pragma(`table_info(${table})`) as Array<{ name: string }>;
  return rows.some((row) => row.name === column);
}

function markVersion(version: number, name: string): void {
  db.prepare('INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
    version,
    name,
    new Date().toISOString(),
  );
  db.pragma(`user_version = ${version}`);
}

export function migrate(): void {
  const current = db.pragma('user_version', { simple: true }) as number;
  if (current >= MIGRATION_VERSION) return;

  const tx = db.transaction(() => {
    db.exec(MIGRATION_SQL);
    if (current < 2) {
      db.exec(MIGRATION_2_SQL);
      for (const column of ACCOUNT_COLUMNS_V2) {
        if (!hasColumn('accounts', column.name)) db.exec(column.ddl);
      }
      markVersion(2, 'login-sessions-and-claim-ledger');
    }
    if (current < 3) {
      db.exec(MIGRATION_3_SQL);
      markVersion(3, 'risk-events-and-circuit-breakers');
    }
    if (current < 4) {
      db.exec(MIGRATION_4_SQL);
      markVersion(4, 'policy-acknowledgements');
    }
    if (current < 5) {
      db.exec(MIGRATION_5_SQL);
      markVersion(5, 'canary-rollout-and-environment-baseline');
    }
    if (current < 6) {
      db.exec(MIGRATION_6_SQL);
      markVersion(6, 'local-login-pairing');
    }
  });

  tx();
}

migrate();

export type Db = Database.Database;
