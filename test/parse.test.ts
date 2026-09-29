import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMessage } from '../src/domain/parse.js'

const names = ['เอ', 'บี']
const exp = (merchant: string, amount: number, mode: 'treat' | null = null, forName: string | null = null) => ({ kind: 'expense', merchant, amount, mode, forName })

test('parse: รายการ', () => {
  const cases: [string, unknown][] = [
    ['กาแฟ 90', exp('กาแฟ', 9000)],
    ['ข้าว 1,250', exp('ข้าว', 125000)],
    ['ข้าวเย็น 420 เลี้ยง', exp('ข้าวเย็น', 42000, 'treat')],
    ['เลี้ยง ชานม 120', exp('ชานม', 12000, 'treat')],
    ['ครีมกันแดดของบี 359', exp('ครีมกันแดด', 35900, null, 'บี')],
    ['ของเอ แชมพู 199', exp('แชมพู', 19900, null, 'เอ')],
    ['90', exp('ไม่ระบุ', 9000)],
    ['7-Eleven 127', exp('7-Eleven', 12700)],
    ['กาแฟ ฿90', exp('กาแฟ', 9000)],
    ['กาแฟ 90บ', exp('กาแฟ', 9000)],
    ['กาแฟ 90 บาท', exp('กาแฟ', 9000)],
    ['ค่าแท็กซี่ 63.5', exp('ค่าแท็กซี่', 6350)],
    ['  ข้าวมันไก่   60  ', exp('ข้าวมันไก่', 6000)],
    ['Grab 245.50', exp('Grab', 24550)],
    ['ข้าวกลางวัน 240', exp('ข้าวกลางวัน', 24000)],
    ['รองเท้า 990', exp('รองเท้า', 99000)],
    ['ปีกไก่ทอด 50', exp('ปีกไก่ทอด', 5000)],
    ['ค่าห้องพัก 1,200', exp('ค่าห้องพัก', 120000)],
    ['ข้าวเย็น 420', exp('ข้าวเย็น', 42000)],
  ]
  for (const [t, want] of cases) assert.deepEqual(parseMessage(t, names), want, t)
})

test('parse: คำสั่ง', () => {
  assert.deepEqual(parseMessage('สรุป'), { kind: 'command', command: 'summary' })
  assert.deepEqual(parseMessage('ยกเลิก'), { kind: 'command', command: 'undo' })
  assert.deepEqual(parseMessage('ช่วยด้วย'), { kind: 'command', command: 'help' })
  assert.deepEqual(parseMessage(' สรุป '), { kind: 'command', command: 'summary' })
})

test('parse: ข้อความปกติต้องเงียบ', () => {
  const silent = [
    'สวัสดี', 'กินข้าวยัง', '555', '55555', 'เจอกัน 18.30', 'ถึงบ้าน 5 นาที', 'รอ 10', 'ห้อง 304', 'อีก 2 วัน',
    'ไปกี่คน 3', 'เท่าไหร่ 90?', 'ราคาเท่าไหร่ 90', 'ส่วนลด 10% 50', 'ตี 2', 'อีก 3', 'โทร 0800000001', '0', 'กาแฟ 0', 'กาแฟ 90 แก้ว', 'ปี 2026',
    'สรุปยอดให้หน่อย', 'x'.repeat(61) + ' 90', 'บรรทัด 1\nบรรทัด 2 90', '', '12345678', 'ราคา 1.234', 'รอบ 2',
  ]
  for (const t of silent) assert.equal(parseMessage(t, names), null, JSON.stringify(t))
})
