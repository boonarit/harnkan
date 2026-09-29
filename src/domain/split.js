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
 * ผลต่อยอดสุทธิ (บวก = B ต้องโอนให้ A)
 * @param {Slot} payer
 * @param {[number, number]} shares
 */
export function effect(payer, shares) {
  return payer === 0 ? shares[1] : 0 - shares[0] // 0 - x กัน -0
}
