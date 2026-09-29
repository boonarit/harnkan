import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { DatabaseSync } from 'node:sqlite'
import { log } from '../log.ts'

const NAME = /^harnkan-\d{8}-\d{6}\.db\.gz$/

/**
 * สำรอง DB: VACUUM INTO (ได้ snapshot ที่ consistent แม้ bot เขียนอยู่) → gzip → BACKUP_DIR
 * ลบชุดเก่าเกิน keep **หลัง** ตรวจว่าไฟล์ใหม่เป็น SQLite จริงเท่านั้น
 */
export function runBackup(db: DatabaseSync, backupDir: string, keep: number, now = Date.now()) {
  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const raw = join(backupDir, `.tmp-${stamp}.db`)
  const out = join(backupDir, `harnkan-${stamp}.db.gz`)
  rmSync(raw, { force: true })
  try {
    db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`)
    const gz = gzipSync(readFileSync(raw), { level: 9 })
    if (gunzipSync(gz).subarray(0, 15).toString('latin1') !== 'SQLite format 3') throw new Error('ไฟล์สำรองไม่ใช่ SQLite')
    writeFileSync(`${out}.part`, gz, { mode: 0o600 })
    renameSync(`${out}.part`, out)
  } finally {
    rmSync(raw, { force: true })
  }
  const all = readdirSync(backupDir).filter((f) => NAME.test(f)).sort()
  const removed = all.slice(0, Math.max(0, all.length - keep))
  for (const f of removed) rmSync(join(backupDir, f))
  log.info('backup_done', { file: out, kept: all.length - removed.length, removed: removed.length })
  return { file: out, removed }
}

if (process.argv[1]?.endsWith('backup.ts')) {
  // ไม่ผ่าน bootstrap/openDb เพราะนั่น migrate ก่อน — update.sh สำรองก่อน migrate ต้องได้ schema เดิม
  const { loadConfig } = await import('../config.ts')
  const { initLog } = await import('../log.ts')
  const { DatabaseSync } = await import('node:sqlite')
  const cfg = loadConfig()
  initLog(join(cfg.dataDir, 'logs'))
  const db = new DatabaseSync(join(cfg.dataDir, 'harnkan.db'))
  const r = runBackup(db, cfg.backupDir, cfg.backupKeep)
  db.close()
  console.log(JSON.stringify({ job: 'backup', ...r }))
}
