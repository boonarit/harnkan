import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const NOW = `(strftime('%Y-%m-%dT%H:%M:%SZ','now'))`

// migrations แบบลำดับเลข: index + 1 = user_version · เพิ่มท้ายเท่านั้น ห้ามแก้ของเก่า
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE couples (
    id INTEGER PRIMARY KEY,
    line_group_id TEXT NOT NULL UNIQUE,
    settle_time TEXT NOT NULL DEFAULT '21:00',
    min_transfer INTEGER NOT NULL DEFAULT 5000,
    default_split TEXT NOT NULL DEFAULT 'half',
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE members (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    line_user_id TEXT NOT NULL,
    display_name TEXT NOT NULL,
    promptpay_id TEXT,
    bank_names TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (couple_id, line_user_id)
  );
  CREATE TABLE slips (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    image_path TEXT,
    qr_trans_ref TEXT UNIQUE,
    bank TEXT,
    amount_satang INTEGER,
    sender_name TEXT,
    receiver_name TEXT,
    ai_json TEXT,
    confidence REAL,
    kind TEXT NOT NULL DEFAULT 'unknown' CHECK (kind IN ('expense','settlement','unknown')),
    status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending','await_amount','done')),
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    paid_by INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount_satang INTEGER NOT NULL CHECK (amount_satang >= 0),
    merchant TEXT NOT NULL,
    category TEXT,
    occurred_at TEXT NOT NULL,
    day TEXT NOT NULL,
    split_mode TEXT NOT NULL CHECK (split_mode IN ('half','mine','theirs','treat','ratio')),
    ratio INTEGER CHECK (ratio BETWEEN 0 AND 100),
    source TEXT NOT NULL CHECK (source IN ('text','slip','manual')),
    slip_id INTEGER REFERENCES slips(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
    created_by INTEGER REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE INDEX expenses_couple_day ON expenses (couple_id, day);
  CREATE TABLE expense_shares (
    expense_id INTEGER NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
    member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    share_satang INTEGER NOT NULL,
    PRIMARY KEY (expense_id, member_id)
  );
  CREATE TABLE daily_summaries (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    net_satang INTEGER NOT NULL,
    carried_in INTEGER NOT NULL DEFAULT 0,
    paid_satang INTEGER NOT NULL DEFAULT 0,
    action TEXT NOT NULL CHECK (action IN ('zero','carry','request')),
    qr_token TEXT,
    sent_message_id TEXT,
    settled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT ${NOW},
    UNIQUE (couple_id, date)
  );
  CREATE TABLE settlements (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    from_member INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    to_member INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    amount_satang INTEGER NOT NULL CHECK (amount_satang > 0),
    day TEXT NOT NULL,
    summary_id INTEGER REFERENCES daily_summaries(id) ON DELETE SET NULL,
    slip_id INTEGER REFERENCES slips(id) ON DELETE SET NULL,
    created_by INTEGER REFERENCES members(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE adjustments (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER NOT NULL REFERENCES couples(id) ON DELETE CASCADE,
    day TEXT NOT NULL,
    delta_satang INTEGER NOT NULL,
    expense_id INTEGER REFERENCES expenses(id) ON DELETE CASCADE,
    reason TEXT,
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    couple_id INTEGER REFERENCES couples(id) ON DELETE CASCADE,
    entity TEXT NOT NULL,
    entity_id INTEGER,
    member_id INTEGER,
    action TEXT NOT NULL,
    before_json TEXT,
    after_json TEXT,
    at TEXT NOT NULL DEFAULT ${NOW}
  );
  `,
  // 2: ค่าจูนต่อคู่ (null = ใช้ค่าจาก env)
  `
  ALTER TABLE couples ADD COLUMN ai_daily_cap INTEGER CHECK (ai_daily_cap >= 0);
  ALTER TABLE couples ADD COLUMN slip_retention_days INTEGER CHECK (slip_retention_days >= 1);
  `,
  // 3 (B17): เพิ่มอย่างเดียว — ข้อมูลเดิมได้ค่าเริ่มต้น (settlement เดิม = active/transfer · สลิปเดิม = นับ)
  `
  ALTER TABLE members ADD COLUMN account_suffixes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE settlements ADD COLUMN status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted'));
  ALTER TABLE settlements ADD COLUMN kind TEXT NOT NULL DEFAULT 'transfer' CHECK (kind IN ('transfer','manual_close'));
  ALTER TABLE slips ADD COLUMN rule TEXT;
  ALTER TABLE slips ADD COLUMN ignored INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE couples ADD COLUMN stale_slip_hours INTEGER CHECK (stale_slip_hours >= 0);
  ALTER TABLE couples ADD COLUMN pending_answer_hours INTEGER CHECK (pending_answer_hours >= 1);
  ALTER TABLE couples ADD COLUMN onboard_nudged_on TEXT;
  `,
  // 4 (B18): เพิ่มอย่างเดียว — หน้าต่างเตือนรายการซ้ำ (null = ค่าเริ่ม 10 นาที · 0 = ปิด) · บัญชีรับเงินสำหรับคนที่ไม่ผูกพร้อมเพย์
  `
  ALTER TABLE couples ADD COLUMN dup_window_minutes INTEGER CHECK (dup_window_minutes >= 0);
  ALTER TABLE members ADD COLUMN bank_name TEXT;
  ALTER TABLE members ADD COLUMN bank_account TEXT;
  `,
  // 5 (B19): เพิ่มอย่างเดียว — ใครเลี้ยง (split_mode มี CHECK เดิมแก้ไม่ได้) · ข้อมูลเดิม = null → treat เดิมแสดงเป็น "<คนจ่าย>เลี้ยง" ยอดเท่าเดิม
  `
  ALTER TABLE expenses ADD COLUMN treated_by INTEGER REFERENCES members(id) ON DELETE SET NULL;
  `,
]

export function openDb(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): number {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[v])
      db.exec(`PRAGMA user_version = ${v + 1}`)
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
      throw e
    }
  }
  return MIGRATIONS.length
}

// npm run migrate: เปิด DB (สร้าง/ย้าย schema) แล้วปิด
if (process.argv[1]?.endsWith('schema.ts')) {
  const { loadConfig } = await import('../config.ts')
  const { join } = await import('node:path')
  const cfg = loadConfig()
  const db = openDb(join(cfg.dataDir, 'harnkan.db'))
  console.log(JSON.stringify({ job: 'migrate', user_version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version }))
  db.close()
}
