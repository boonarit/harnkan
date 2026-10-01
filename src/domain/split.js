// @ts-check
/** @typedef {'half' | 'mine' | 'theirs' | 'treat' | 'ratio'} SplitMode */
/** @typedef {0 | 1} Slot สมาชิกคนที่ 1 (A) = 0, คนที่ 2 (B) = 1 */

/** @type {SplitMode[]} */
export const MODES = ['half', 'mine', 'theirs', 'treat', 'ratio']

/**
 * ส่วนที่แต่ละคนต้องรับผิดชอบ [A, B] รวมกันเท่ายอดบิลพอดีเสมอ
 * @param {number} amount สตางค์
 * @param {SplitMode} mode
 * @param {Slot} payer
 * @param {number} seq ลำดับรายการ (expense id) — เศษสตางค์คี่ของ half ตกกับ slot seq % 2 สลับกันไป
 * @param {number} ratio % ของคนจ่าย (โหมด ratio เช่น 60 = คนจ่าย 60 อีกคน 40)
 * @returns {[number, number]}
 */
export function splitShares(amount, mode, payer, seq = 0, ratio = 50) {
  if (!Number.isInteger(amount) || amount < 0) throw new Error('amount ต้องเป็นสตางค์จำนวนเต็ม')
  const other = /** @type {Slot} */ (1 - payer)
  /** @type {[number, number]} */
  const s = [0, 0]
  switch (mode) {
    case 'half': {
      const base = Math.floor(amount / 2)
      s[0] = s[1] = base
      s[Math.abs(seq) % 2] += amount - 2 * base
      break
    }
    case 'mine':
    case 'treat': // เลี้ยง: ไม่นับเข้ายอด = คนจ่ายรับเองทั้งหมด
      s[payer] = amount
      break
    case 'theirs':
      s[other] = amount
      break
    case 'ratio': {
      if (!Number.isInteger(ratio) || ratio < 0 || ratio > 100) throw new Error('ratio ต้องเป็น 0–100')
      const o = Math.floor((amount * (100 - ratio) + 50) / 100)
      s[other] = o
      s[payer] = amount - o
      break
    }
    default:
      throw new Error(`โหมดหารไม่รู้จัก: ${mode}`)
  }
  return s
}

/**
 * ใครเลี้ยง (member id) ที่เก็บใน expenses.treated_by — ปรับให้สอดคล้องกับโหมดเสมอ
 * treat = คนจ่ายเลี้ยง · theirs + อีกคนเลี้ยง = อีกคนรับทั้งก้อน (เงินเท่า "ของ<อีกคน>" แต่ป้ายบอกว่าเลี้ยง) · โหมดอื่น = ไม่มี
 * @param {SplitMode} mode @param {number} paidBy @param {number | null | undefined} treatedBy
 * @returns {number | null}
 */
export function treaterOf(mode, paidBy, treatedBy) {
  if (mode === 'treat') return paidBy
  return mode === 'theirs' && treatedBy != null && treatedBy !== paidBy ? treatedBy : null
}

/**
 * ปุ่ม "<X>เลี้ยง" → โหมดเงิน: X เป็นคนจ่าย = treat (ไม่นับเข้ายอด) · X เป็นอีกคน = theirs (X รับทั้งก้อน)
 * @param {number} treater member id ของคนเลี้ยง @param {number} paidBy
 * @returns {{ mode: SplitMode, treatedBy: number }}
 */
export function treatSplit(treater, paidBy) {
  return { mode: treater === paidBy ? 'treat' : 'theirs', treatedBy: treater }
}

/**
 * ป้ายโหมดหาร (การ์ด LINE · แอป · เดโม) · ชื่อดึงจาก display_name ปัจจุบันตอนแสดง ไม่เก็บชื่อลง expense
 * @param {{ split_mode: string, ratio?: number | null, payer: number, paid_by?: number, treated_by?: number | null }} e
 * @param {{ id: number, display_name: string }[]} members
 */
export function modeLabel(e, members) {
  const payer = members[e.payer]?.display_name ?? '?'
  const other = members[1 - e.payer]?.display_name ?? '?'
  const treater = e.split_mode === 'theirs' && e.treated_by != null ? members.find((m) => m.id === e.treated_by)?.display_name : null
  if (treater) return `${treater}เลี้ยง`
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
 * ผลต่อยอดสุทธิ (บวก = B ต้องโอนให้ A)
 * @param {Slot} payer
 * @param {[number, number]} shares
 */
export function effect(payer, shares) {
  return payer === 0 ? shares[1] : 0 - shares[0] // 0 - x กัน -0
}
