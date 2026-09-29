import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { MIGRATIONS, openDb } from '../src/db/schema.ts'
import { seeded, tmpDir } from './helpers/db.ts'

const DAY = '2026-09-29'
const at = (hm: string) => `${DAY}T${hm}:00+07:00`

test('schema: WAL + foreign keys + migrate ซ้ำได้', () => {
  const p = join(tmpDir(), 'x.db')
  const db = openDb(p)
  assert.equal((db.prepare('PRAGMA journal_mode').get() as any).journal_mode, 'wal')
  assert.equal((db.prepare('PRAGMA foreign_keys').get() as any).foreign_keys, 1)
  db.close()
  const db2 = openDb(p)
  assert.equal((db2.prepare('PRAGMA user_version').get() as any).user_version, MIGRATIONS.length)
})

test('ตัวอย่าง 1 วันผ่าน repository → 34750', () => {
  const { repo, couple, a, b } = seeded()
  const add = (paidBy: number, amount: number, merchant: string, mode: any, hm: string) =>
    repo.createExpense({ coupleId: couple.id, paidBy, amount, merchant, occurredAt: at(hm), day: DAY, mode, source: 'text', createdBy: paidBy })
  add(a.id, 9000, 'กาแฟ 2 แก้ว', 'half', '08:10')
  add(b.id, 24000, 'ข้าวกลางวัน', 'half', '12:30')
  add(a.id, 12700, '7-Eleven', 'half', '18:45')
  add(a.id, 35900, 'ครีมกันแดด', 'theirs', '19:10')
  add(b.id, 42000, 'ข้าวเย็น', 'treat', '20:00')
  assert.equal(repo.ledger(couple.id, DAY).net, 34750)
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 5)
})

test('ลบ = soft delete + audit_log', () => {
  const { repo, couple, a } = seeded()
  const e = repo.createExpense({ coupleId: couple.id, paidBy: a.id, amount: 9000, merchant: 'กาแฟ', occurredAt: at('08:00'), day: DAY, mode: 'half', source: 'text', createdBy: a.id })
  repo.deleteExpense(e.id, a.id, DAY)
  assert.equal(repo.expense(e.id)!.status, 'deleted')
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 0)
  assert.equal(repo.ledger(couple.id, DAY).net, 0)
  assert.deepEqual(repo.auditFor('expense', e.id).map((r) => r.action), ['create', 'delete'])
})

test('แก้รายการวันนี้ = แก้ตรง + audit_log', () => {
  const { repo, couple, a } = seeded()
  const e = repo.createExpense({ coupleId: couple.id, paidBy: a.id, amount: 9000, merchant: 'กาแฟ', occurredAt: at('08:00'), day: DAY, mode: 'half', source: 'text', createdBy: a.id })
  repo.updateExpense(e.id, { mode: 'theirs' }, a.id, DAY)
  assert.equal(repo.ledger(couple.id, DAY).net, 9000)
  const log = repo.auditFor('expense', e.id)
  assert.equal(log[1].action, 'update')
  assert.equal(JSON.parse(log[1].before_json!).split_mode, 'half')
  assert.equal(JSON.parse(log[1].after_json!).split_mode, 'theirs')
})

test('แก้ย้อนหลังวันที่ปิดยอดแล้ว → ยอดปรับปรุงเข้าวันนี้ ไม่แตะ daily_summaries เดิม', () => {
  const { repo, couple, a } = seeded()
  const e = repo.createExpense({ coupleId: couple.id, paidBy: a.id, amount: 9000, merchant: 'กาแฟ', occurredAt: at('08:00'), day: DAY, mode: 'half', source: 'text', createdBy: a.id })
  const s = repo.createSummary({ coupleId: couple.id, date: DAY, net: 4500, carriedIn: 0, action: 'carry' })!
  assert.equal(repo.createSummary({ coupleId: couple.id, date: DAY, net: 1, carriedIn: 0, action: 'carry' }), null, 'unique ต่อวัน')

  const TOMORROW = '2026-09-30'
  repo.updateExpense(e.id, { mode: 'theirs' }, a.id, TOMORROW)
  assert.deepEqual(repo.summary(couple.id, DAY), s)
  const t = repo.ledger(couple.id, TOMORROW)
  assert.equal(t.carriedIn, 4500)
  assert.equal(t.adjustments, 4500)
  assert.equal(t.net, 9000)

  repo.deleteExpense(e.id, a.id, TOMORROW)
  assert.equal(repo.ledger(couple.id, TOMORROW).net, 0)
})

test('การโอนที่จับคู่กับสรุปแล้ว ลดยอดยกมา', () => {
  const { repo, couple, a, b } = seeded()
  const s = repo.createSummary({ coupleId: couple.id, date: DAY, net: 34750, carriedIn: 0, action: 'request' })!
  repo.createSettlement({ coupleId: couple.id, from: b.id, to: a.id, amount: 30000, day: '2026-09-30', summaryId: s.id, createdBy: b.id })
  repo.updateSummary(s.id, { paid_satang: 30000 })
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, 4750)
  // โอนระหว่างวันที่ไม่ผูกกับสรุป นับในวันนั้นเลย
  repo.createSettlement({ coupleId: couple.id, from: b.id, to: a.id, amount: 4750, day: '2026-09-30', summaryId: null, createdBy: b.id })
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, 0)
})

test('ต้องมีสมาชิก 2 คนก่อนบันทึก', () => {
  const { repo } = seeded()
  const c = repo.createCouple('C_fake_other')
  const m = repo.addMember(c.id, 'U_fake_a', 'เอ')
  assert.throws(() => repo.createExpense({ coupleId: c.id, paidBy: m.id, amount: 100, merchant: 'x', occurredAt: at('08:00'), day: DAY, mode: 'half', source: 'text', createdBy: m.id }), /2 คน/)
})
