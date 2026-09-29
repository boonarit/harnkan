import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { gunzipSync } from 'node:zlib'
import { handlers } from '../src/bot.ts'
import { health } from '../src/health.ts'
import { runBackup } from '../src/jobs/backup.ts'
import { runRetention } from '../src/jobs/retention.ts'
import { runSummary } from '../src/jobs/summary.ts'
import { handleEvent } from '../src/line/router.ts'
import { Logger } from '../src/log.ts'
import { makeQrPng } from '../src/promptpay/qr.ts'
import { A_ID, B_ID, ev, makeCtx } from './helpers/app.ts'
import { seeded, tmpDir } from './helpers/db.ts'

test('log: หมุนไฟล์เมื่อเกินขนาด เก็บ 5 ไฟล์ ไม่มีไฟล์ไหนเกิน', () => {
  const dir = tmpDir()
  const lg = new Logger(dir, 2000, 5)
  for (let i = 0; i < 300; i++) lg.info('tick', { i, note: 'x'.repeat(50) })
  const files = readdirSync(dir).sort()
  assert.deepEqual(files, ['harnkan.log', 'harnkan.log.1', 'harnkan.log.2', 'harnkan.log.3', 'harnkan.log.4'])
  for (const f of files) assert.ok(statSync(join(dir, f)).size <= 2000, f)
  const last = readFileSync(join(dir, 'harnkan.log'), 'utf8').trim().split('\n').at(-1)!
  assert.equal(JSON.parse(last).i, 299)
})

test('log: ไม่มี token / รูป / ข้อมูลสลิปเต็ม', () => {
  const dir = tmpDir()
  const lg = new Logger(dir)
  lg.error('x', { token: 'tok-SECRET-1', headers: { authorization: 'Bearer SECRET-2' }, image: 'A'.repeat(5000), ai_json: '{"sender_name":"SECRET-3"}', buf: Buffer.alloc(10), msg: 'y'.repeat(1000) })
  const text = readFileSync(join(dir, 'harnkan.log'), 'utf8')
  for (const s of ['SECRET-1', 'SECRET-2', 'SECRET-3', 'AAAAAAAAAA']) assert.ok(!text.includes(s), s)
  assert.ok(text.length < 600, `${text.length}`)
})

test('backup: gzip ของ SQLite ที่เปิดได้ · เก็บ BACKUP_KEEP ชุด', () => {
  const { repo, couple, a } = seeded()
  repo.createExpense({ coupleId: couple.id, paidBy: a.id, amount: 9000, merchant: 'กาแฟ', occurredAt: '2026-09-29T08:00:00+07:00', day: '2026-09-29', mode: 'half', source: 'text', createdBy: a.id })
  const dir = join(tmpDir(), 'backups')
  const t0 = Date.parse('2026-09-01T04:00:00Z')
  for (let i = 0; i < 9; i++) runBackup(repo.db, dir, 7, t0 + i * 86400_000)
  const files = readdirSync(dir).sort()
  assert.equal(files.length, 7)
  assert.equal(files[0], 'harnkan-20260903-040000.db.gz')
  const restored = join(tmpDir(), 'r.db')
  writeFileSync(restored, gunzipSync(readFileSync(join(dir, files.at(-1)!))))
  const db = new DatabaseSync(restored)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM expenses').get() as any).n, 1)
})

test('backup ล้ม → ไม่ลบชุดเก่า', () => {
  const { repo } = seeded()
  const dir = join(tmpDir(), 'backups')
  const t0 = Date.parse('2026-09-01T04:00:00Z')
  for (let i = 0; i < 3; i++) runBackup(repo.db, dir, 3, t0 + i * 86400_000)
  const before = readdirSync(dir).sort()
  repo.db.close()
  assert.throws(() => runBackup(repo.db, dir, 3, t0 + 10 * 86400_000))
  assert.deepEqual(readdirSync(dir).sort(), before)
})

test('retention: ลบรูปสลิปเก่า (ค่าจาก DB) เก็บตัวเลขไว้ · ลบ QR หมดอายุ', async () => {
  const t = makeCtx({ now: Date.parse('2026-09-29T10:00:00+07:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  await send(ev.image(A_ID, 'slip-sunscreen'))
  t.clock.t = Date.parse('2026-11-15T10:00:00+07:00')
  await send(ev.image(A_ID, 'slip-coffee'))
  const couple = t.repo.allCouples()[0]
  const [oldSlip, newSlip] = t.repo.db.prepare('SELECT * FROM slips ORDER BY id').all() as any[]
  const oldFile = join(t.dir, oldSlip.image_path)
  assert.ok(existsSync(oldFile))
  t.repo.updateCouple(couple.id, { slip_retention_days: 30 }, null)
  const token = await makeQrPng(t.dir, '0800000001', 100)
  const qrFile = join(t.dir, 'qr', `${token}.png`)
  const old = (t.clock.t - 25 * 3600_000) / 1000
  utimesSync(qrFile, old, old)
  assert.deepEqual(runRetention(t.ctx), { slips: 1, qr: 1 })
  assert.ok(!existsSync(oldFile))
  assert.ok(!existsSync(qrFile))
  assert.equal(t.repo.slip(oldSlip.id)!.image_path, null)
  assert.equal(t.repo.slip(oldSlip.id)!.amount_satang, 35900)
  assert.ok(t.repo.slip(newSlip.id)!.image_path)
  assert.equal(t.repo.expensesByDay(couple.id, '2026-09-29')[0].amount_satang, 35900)
})

test('retention: ตัด stdout log ของ launchd ที่เกิน 5 MB', () => {
  const t = makeCtx()
  mkdirSync(join(t.dir, 'logs'))
  writeFileSync(join(t.dir, 'logs', 'bot.stdout.log'), Buffer.alloc(5 * 1024 * 1024 + 1))
  writeFileSync(join(t.dir, 'logs', 'small.stdout.log'), 'ok')
  runRetention(t.ctx)
  assert.deepEqual(readdirSync(join(t.dir, 'logs')).sort(), ['bot.stdout.log.old', 'small.stdout.log'])
})

test('healthz: stale เมื่อไม่มีรายการเกิน 3 วัน หรือไม่ได้สรุป 2 คืน', async () => {
  const t = makeCtx({ now: Date.parse('2026-09-29T10:00:00+07:00') })
  assert.equal(health(t.ctx).stale, false, 'ยังไม่มีคู่')
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  await send(ev.text(A_ID, 'กาแฟ 90'))
  t.clock.t = Date.parse('2026-09-29T21:00:00+07:00')
  await runSummary(t.ctx)
  let h = health(t.ctx)
  assert.equal(h.stale, false)
  assert.equal(h.last_expense_at, '2026-09-29T03:00:00.000Z')
  assert.equal(h.last_summary_sent_at, '2026-09-29T14:00:00.000Z')
  // คืนถัดไปงานสรุปไม่รัน 1 คืน → ยังไม่ stale
  t.clock.t = Date.parse('2026-09-30T22:00:00+07:00')
  assert.equal(health(t.ctx).stale, false)
  // 2 คืน → stale
  t.clock.t = Date.parse('2026-10-01T22:00:00+07:00')
  h = health(t.ctx)
  assert.equal(h.stale, true)
  assert.match(h.reasons.join(), /ไม่ได้สรุปยอด 2 คืน/)
  // ไม่มีรายการเกิน 3 วัน
  t.clock.t = Date.parse('2026-10-03T12:00:00+07:00')
  assert.match(health(t.ctx).reasons.join(), /ไม่มีรายการใหม่เกิน 3 วัน/)
})
