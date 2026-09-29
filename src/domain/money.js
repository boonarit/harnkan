// เงินเป็นสตางค์ (integer) เสมอ — ไฟล์ domain เป็น JS + JSDoc เพื่อให้ mini app/เดโมในเบราว์เซอร์ใช้ตัวเดียวกันได้โดยไม่มี build
// @ts-check

/**
 * แปลงข้อความยอดเงิน ("1,250", "฿90", "90บ", "63.5", "90 บาท") → สตางค์ · ไม่ใช่ยอด → null
 * @param {string} s
 * @returns {number | null}
 */
export function parseAmount(s) {
  const t = String(s).trim().replace(/^฿/, '').replace(/\s*(บาท|บ\.?)$/, '').replace(/,(?=\d{3}(\D|$))/g, '')
  const m = t.match(/^(\d{1,9})(?:\.(\d{1,2}))?$/)
  if (!m) return null
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0'))
}

/**
 * สตางค์ → "฿1,250.00"
 * @param {number} satang
 */
export function formatBaht(satang) {
  const sign = satang < 0 ? '-' : ''
  const abs = Math.abs(satang)
  const baht = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}฿${baht}.${String(abs % 100).padStart(2, '0')}`
}
