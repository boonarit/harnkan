// ใส่ข้อมูลคู่สมมติ เอ & บี (ตัวอย่าง 1 วัน) ลง DB ของ dev — ใช้กับ npm run dev แล้วเปิด /app/?as=U_fake_a
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { Repo } from '../src/db/repo.ts'
import { openDb } from '../src/db/schema.ts'
import { businessDay } from '../src/domain/time.js'

const cfg = loadConfig()
if (!cfg.fakeLine) throw new Error('seed-dev ใช้ได้เฉพาะโหมด FAKE_LINE=1')
const repo = new Repo(openDb(join(cfg.dataDir, 'harnkan.db')))
const couple = repo.createCouple('C_fake_group')
const [a, b] = repo.members(couple.id).length ? repo.members(couple.id) : [repo.addMember(couple.id, 'U_fake_a', 'เอ'), repo.addMember(couple.id, 'U_fake_b', 'บี')]
repo.updateMember(a.id, { promptpay_id: '0800000001' })
repo.updateMember(b.id, { promptpay_id: '0800000002' })
const day = businessDay(Date.now(), couple.settle_time)
if (!repo.expensesByDay(couple.id, day).length) {
  const rows: [number, number, string, 'half' | 'theirs' | 'treat', string][] = [
    [a.id, 9000, 'กาแฟ 2 แก้ว', 'half', '08:10'], [b.id, 24000, 'ข้าวกลางวัน', 'half', '12:30'], [a.id, 12700, '7-Eleven', 'half', '18:45'],
    [a.id, 35900, 'ครีมกันแดด', 'theirs', '19:10'], [b.id, 42000, 'ข้าวเย็น', 'treat', '20:00'],
  ]
  for (const [paidBy, amount, merchant, mode, hm] of rows) {
    repo.createExpense({ coupleId: couple.id, paidBy, amount, merchant, occurredAt: `${day}T${hm}:00+07:00`, day, mode, source: 'text', createdBy: paidBy })
  }
}
console.log(`seed: couple=${couple.id} day=${day} net=${repo.ledger(couple.id, day).net} (${cfg.dataDir})`)
