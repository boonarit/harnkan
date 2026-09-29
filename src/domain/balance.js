// @ts-check
import { effect } from './split.js'

/**
 * N = Σ ส่วนของ B ในบิลที่ A จ่าย − Σ ส่วนของ A ในบิลที่ B จ่าย + ยอดยกมา − ที่ B โอนให้ A + ที่ A โอนให้ B (+ ยอดปรับปรุง)
 * บวก = B ต้องโอนให้ A
 * @param {{
 *   expenses?: { payer: 0 | 1, shares: [number, number] }[],
 *   settlements?: { from: 0 | 1, amount: number }[],
 *   carriedIn?: number,
 *   adjustments?: number,
 * }} input
 */
export function dailyNet({ expenses = [], settlements = [], carriedIn = 0, adjustments = 0 }) {
  let n = carriedIn + adjustments
  for (const e of expenses) n += effect(e.payer, e.shares)
  for (const s of settlements) n += s.from === 1 ? -s.amount : s.amount
  return n
}

/**
 * ตัดสินว่าจะเรียกเก็บหรือทบ · ต่ำกว่า min (ค่าเริ่ม ฿50) ทบวันถัดไป
 * @param {number} net
 * @param {number} min
 * @returns {{ action: 'zero' | 'carry' | 'request', amount: number, from: 0 | 1, to: 0 | 1 }}
 */
export function decide(net, min = 5000) {
  const amount = Math.abs(net)
  const from = net > 0 ? 1 : 0
  const to = from === 1 ? 0 : 1
  if (net === 0) return { action: 'zero', amount, from, to }
  return { action: amount < min ? 'carry' : 'request', amount, from, to }
}
