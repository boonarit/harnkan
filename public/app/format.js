// @ts-check
// ตัวช่วยแสดงผล (pure) — ใช้ทั้งแอปจริงและเดโม และเทสต์ด้วย node:test ได้
import { formatBaht, parseAmount } from '#domain/money.js'
import { effect, splitShares } from '#domain/split.js'

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
 * ปุ่มโหมดหารในหน้าจอ: "half" | "0" (ของคนที่ 1) | "1" (ของคนที่ 2) | "treat" → split_mode ตามคนจ่าย
 * @param {'half' | '0' | '1' | 'treat'} chip @param {0 | 1} payer
 * @returns {'half' | 'mine' | 'theirs' | 'treat'}
 */
export function chipToMode(chip, payer) {
  if (chip === 'half' || chip === 'treat') return chip
  return Number(chip) === payer ? 'mine' : 'theirs'
}

/** @param {string} mode @param {0 | 1} payer @returns {'half' | '0' | '1' | 'treat' | 'ratio'} */
export function modeToChip(mode, payer) {
  if (mode === 'mine') return /** @type {'0' | '1'} */ (String(payer))
  if (mode === 'theirs') return /** @type {'0' | '1'} */ (String(1 - payer))
  return /** @type {any} */ (mode)
}

/**
 * ป้ายโหมดหาร
 * @param {{ split_mode: string, ratio?: number | null, payer: 0 | 1 }} e @param {Member[]} members
 */
export function modeLabel(e, members) {
  const payer = members[e.payer]?.display_name ?? '?'
  const other = members[1 - e.payer]?.display_name ?? '?'
  switch (e.split_mode) {
    case 'half': return 'หารครึ่ง'
    case 'mine': return `ของ${payer}`
    case 'theirs': return `ของ${other}`
    case 'treat': return `${payer}เลี้ยง`
    case 'ratio': return `${payer} ${e.ratio}% / ${other} ${100 - (e.ratio ?? 50)}%`
    default: return e.split_mode
  }
}

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
