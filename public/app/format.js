// @ts-check
// ตัวช่วยแสดงผล (pure) — ใช้ทั้งแอปจริงและเดโม และเทสต์ด้วย node:test ได้
import { formatBaht, parseAmount } from '#domain/money.js'
import { effect, modeLabel, splitShares } from '#domain/split.js'

export { formatBaht as baht, parseAmount }

/** @typedef {{ id: number, display_name: string, promptpay_id?: string | null, bank_names?: string[] }} Member */

const TH_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม']
const TH_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
export const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']

/** "2026-09-29" → "29 ก.ย." */
export function thaiDate(date) {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${TH_SHORT[m - 1]}`
}

/** "2026-09" → "กันยายน 2569" */
export function thaiMonth(month) {
  const [y, m] = month.split('-').map(Number)
  return `${TH_MONTHS[m - 1]} ${y + 543}`
}

/** "2026-09" ± n เดือน */
export function shiftMonth(month, n) {
  const [y, m] = month.split('-').map(Number)
  const t = y * 12 + (m - 1) + n
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`
}

/**
 * ตารางปฏิทิน (สัปดาห์เริ่มวันอาทิตย์) · ช่องว่าง = null
 * @param {string} month YYYY-MM
 * @returns {(string | null)[][]}
 */
export function monthGrid(month) {
  const first = new Date(`${month}-01T00:00:00Z`)
  const days = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate()
  /** @type {(string | null)[]} */
  const cells = Array(first.getUTCDay()).fill(null)
  for (let d = 1; d <= days; d++) cells.push(`${month}-${String(d).padStart(2, '0')}`)
  while (cells.length % 7) cells.push(null)
  const weeks = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))
  return weeks
}

/**
 * ยอดสุทธิ → ประโยค (บวก = คนที่ 2 โอนให้คนที่ 1)
 * @param {number} net @param {Member[]} members
 */
export function netSentence(net, members) {
  if (!net) return 'ไม่มีใครติดใคร'
  const [from, to] = net > 0 ? [members[1], members[0]] : [members[0], members[1]]
  return `${from.display_name} โอนให้ ${to.display_name}`
}

/**
 * ปุ่มโหมดหารในหน้าจอ: "half" | "0" (ของคนที่ 1) | "1" (ของคนที่ 2) | "t0" (คนที่ 1 เลี้ยง) | "t1" (คนที่ 2 เลี้ยง) → split_mode ตามคนจ่าย
 * @param {'half' | '0' | '1' | 't0' | 't1' | 'treat'} chip @param {0 | 1} payer
 * @returns {'half' | 'mine' | 'theirs' | 'treat'}
 */
export function chipToMode(chip, payer) {
  if (chip === 'half' || chip === 'treat') return chip
  if (chip === 't0' || chip === 't1') return Number(chip[1]) === payer ? 'treat' : 'theirs'
  return Number(chip) === payer ? 'mine' : 'theirs'
}

/** คนเลี้ยง (member id) ของปุ่ม t0/t1 · ปุ่มอื่น = null @param {string} chip @param {Member[]} members */
export function chipTreatedBy(chip, members) {
  return chip === 't0' || chip === 't1' ? members[Number(chip[1])].id : null
}

/**
 * @param {string} mode @param {0 | 1} payer @param {number} [treaterSlot] slot ของคนเลี้ยง (-1 = ไม่มี)
 * @returns {'half' | '0' | '1' | 't0' | 't1' | 'ratio'}
 */
export function modeToChip(mode, payer, treaterSlot = -1) {
  if (mode === 'treat') return /** @type {'t0' | 't1'} */ (`t${payer}`)
  if (mode === 'theirs' && treaterSlot >= 0 && treaterSlot !== payer) return /** @type {'t0' | 't1'} */ (`t${treaterSlot}`)
  if (mode === 'mine') return /** @type {'0' | '1'} */ (String(payer))
  if (mode === 'theirs') return /** @type {'0' | '1'} */ (String(1 - payer))
  return /** @type {any} */ (mode)
}

export { modeLabel }

/**
 * พรีวิวก่อนบันทึก: ผลต่อยอดของรายการนี้ + ยอดใหม่ (ใช้ splitShares ตัวเดียวกับ server)
 * @param {{ amount: number, payer: 0 | 1, mode: any, ratio?: number, net: number, seq?: number }} p
 */
export function preview({ amount, payer, mode, ratio = 50, net, seq = 0 }) {
  const shares = splitShares(amount, mode, payer, seq, ratio)
  const eff = effect(payer, shares)
  return { shares, effect: eff, net: net + eff }
}

/** ป้องกัน HTML injection ในชื่อรายการ/ชื่อคน @param {unknown} s */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c)
}
