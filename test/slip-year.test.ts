import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isStale, slipTime } from '../src/slip/classify.ts'
import { slipPrompt } from '../src/slip/vision.ts'

const at = (s: string) => Date.parse(s)
const H = 24

// ค่าจริงจาก ai_json ที่ AI อ่านปีผิด (วัน/เดือน/เวลาถูก) · now = เวลาที่บอทรับรูป
test('AI อ่านปีผิดเป็น 2024 แต่สลิปเป็นของวันนี้ → ไม่ถือว่าเก่า', () => {
  assert.equal(isStale('2024-10-19T18:58:00+07:00', at('2026-10-19T15:05:15Z'), H), false, 'กรุงไทย CP Axtra')
  assert.equal(isStale('2024-10-13T16:11:00+07:00', at('2026-10-13T09:33:26Z'), H), false, 'ใบเสร็จ 852.50')
  assert.equal(isStale('2024-10-11T14:46:00+07:00', at('2026-10-11T07:49:52Z'), H), false, 'Starbucks')
})

test('AI ไม่ลบ 543 (ปี พ.ศ.) → ใช้ปีปัจจุบัน', () => {
  assert.equal(isStale('2569-10-19T18:58:00+07:00', at('2026-10-19T15:05:15Z'), H), false)
})

test('สลิปเก่าจริงยังถาม แม้ปีผิด', () => {
  assert.equal(isStale('2024-10-15T12:00:00+07:00', at('2026-10-19T15:05:15Z'), H), true, '4 วันก่อน')
  assert.equal(isStale('2026-10-15T12:00:00+07:00', at('2026-10-19T15:05:15Z'), H), true, 'ปีถูก 4 วันก่อน')
  assert.equal(isStale(null, at('2026-10-19T15:05:15Z'), H), true, 'ไม่มีวันที่')
  assert.equal(isStale('ไม่ใช่วันที่', at('2026-10-19T15:05:15Z'), H), true)
})

test('ข้ามปี: สลิป 31 ธ.ค. ส่งตอน 1 ม.ค. AI ให้ปีผิด → ปีที่แล้ว ไม่ใช่ปีหน้า', () => {
  const now = at('2027-01-01T01:00:00+07:00')
  assert.equal(slipTime('2024-12-31T23:30:00+07:00', now), at('2026-12-31T23:30:00+07:00'))
  assert.equal(isStale('2024-12-31T23:30:00+07:00', now, H), false)
})

test('ปีถูกอยู่แล้ว → ไม่แตะ', () => {
  assert.equal(slipTime('2026-10-19T18:58:00+07:00', at('2026-10-20T00:00:00Z')), at('2026-10-19T18:58:00+07:00'))
})

test('prompt บอกวันนี้เป็นทั้ง ค.ศ. และ พ.ศ.', () => {
  const p = slipPrompt(at('2026-10-19T15:05:15Z'))
  assert.match(p, /2026-10-19/)
  assert.match(p, /2569/)
})
