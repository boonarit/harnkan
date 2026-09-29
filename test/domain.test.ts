import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatBaht, parseAmount } from '../src/domain/money.js'
import { MODES, effect, splitShares } from '../src/domain/split.js'
import { dailyNet, decide } from '../src/domain/balance.js'
import { businessDay, summaryDay } from '../src/domain/time.js'

test('parseAmount รูปแบบต่างๆ', () => {
  const cases: [string, number | null][] = [
    ['90', 9000], ['1,250', 125000], ['฿90', 9000], ['90บ', 9000], ['90 บาท', 9000], ['63.5', 6350],
    ['63.50', 6350], ['0.01', 1], ['12,345.67', 1234567], ['abc', null], ['', null], ['1.234', null], ['-5', null], ['1,25', null],
  ]
  for (const [s, v] of cases) assert.equal(parseAmount(s), v, s)
})

test('formatBaht', () => {
  assert.equal(formatBaht(34750), '฿347.50')
  assert.equal(formatBaht(125000), '฿1,250.00')
  assert.equal(formatBaht(5), '฿0.05')
  assert.equal(formatBaht(-12000), '-฿120.00')
  assert.equal(formatBaht(123456789), '฿1,234,567.89')
})

test('ตัวอย่าง 1 วัน → B โอนให้ A 34750', () => {
  const A = 0 as const, B = 1 as const
  const bills = [
    { amount: 9000, payer: A, mode: 'half' },
    { amount: 24000, payer: B, mode: 'half' },
    { amount: 12700, payer: A, mode: 'half' },
    { amount: 35900, payer: A, mode: 'theirs' },
    { amount: 42000, payer: B, mode: 'treat' },
  ] as const
  const expenses = bills.map((b, i) => ({ payer: b.payer, shares: splitShares(b.amount, b.mode, b.payer, i + 1) }))
  const net = dailyNet({ expenses })
  assert.equal(net, 34750)
  assert.deepEqual(decide(net), { action: 'request', amount: 34750, from: 1, to: 0 })
})

test('เศษสตางค์คี่ สลับกันรับตามลำดับ id', () => {
  assert.deepEqual(splitShares(12700, 'half', 0, 1), [6350, 6350])
  assert.deepEqual(splitShares(101, 'half', 0, 1), [50, 51])
  assert.deepEqual(splitShares(101, 'half', 0, 2), [51, 50])
  assert.deepEqual(splitShares(101, 'half', 1, 3), [50, 51])
})

test('โหมดอื่น', () => {
  assert.deepEqual(splitShares(10000, 'ratio', 0, 1, 60), [6000, 4000])
  assert.deepEqual(splitShares(10000, 'mine', 1), [0, 10000])
  assert.deepEqual(splitShares(10000, 'theirs', 1), [10000, 0])
  assert.equal(effect(1, splitShares(10000, 'treat', 1)), 0)
  assert.throws(() => splitShares(10.5, 'half', 0))
  assert.throws(() => splitShares(100, 'ratio', 0, 1, 101))
})

test('ยอดยกมา การโอน และยอดขั้นต่ำ', () => {
  assert.equal(dailyNet({ carriedIn: 1000, settlements: [{ from: 1, amount: 400 }, { from: 0, amount: 100 }] }), 700)
  assert.equal(decide(4999).action, 'carry')
  assert.equal(decide(5000).action, 'request')
  assert.equal(decide(0).action, 'zero')
  assert.deepEqual(decide(-6000), { action: 'request', amount: 6000, from: 0, to: 1 })
})

test('property: ผลรวม shares = ยอดบิลเสมอ (1000 เคส seed คงที่)', () => {
  let seed = 42
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let i = 0; i < 1000; i++) {
    const amount = Math.floor(rand() * 10_000_000)
    const mode = MODES[Math.floor(rand() * MODES.length)]
    const payer = rand() < 0.5 ? 0 : 1
    const s = splitShares(amount, mode, payer, i, Math.floor(rand() * 101))
    assert.equal(s[0] + s[1], amount, `${amount} ${mode}`)
    assert.ok(s[0] >= 0 && s[1] >= 0)
  }
})

test('วันทางบัญชี: หลัง 21:00 เป็นของวันถัดไป', () => {
  const at = (iso: string) => Date.parse(iso)
  assert.equal(businessDay(at('2026-09-29T20:59:00+07:00')), '2026-09-29')
  assert.equal(businessDay(at('2026-09-29T21:00:00+07:00')), '2026-09-30')
  assert.equal(summaryDay(at('2026-09-29T21:00:05+07:00')), '2026-09-29')
  assert.equal(summaryDay(at('2026-09-30T01:00:00+07:00')), '2026-09-29')
})
