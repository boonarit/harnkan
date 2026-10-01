// @ts-check
// เวลาไทย (UTC+7 ไม่มี DST)
const TZ = 7 * 3600_000

/** launchd รันงานสรุปทุกกี่นาที (StartInterval ใน deploy/com.harnkan.summary.plist ต้องตรง · มีเทสต์) → การ์ดมาภายใน N นาทีหลังเวลาสรุป */
export const SUMMARY_EVERY_MIN = 10

/** @param {number} ms @returns {string} YYYY-MM-DD ตามเวลาไทย */
export function bangkokDate(ms = Date.now()) {
  return new Date(ms + TZ).toISOString().slice(0, 10)
}

/** @param {number} ms @returns {string} HH:MM ตามเวลาไทย */
export function bangkokTime(ms = Date.now()) {
  return new Date(ms + TZ).toISOString().slice(11, 16)
}

/** @param {string} date YYYY-MM-DD @param {number} n */
export function addDays(date, n) {
  return new Date(Date.parse(date + 'T00:00:00Z') + n * 86400_000).toISOString().slice(0, 10)
}

/**
 * วันทางบัญชี: รายการหลังเวลาปิดยอด (เช่น 21:00) นับเป็นของวันถัดไป
 * @param {number} ms @param {string} settleTime HH:MM
 */
export function businessDay(ms = Date.now(), settleTime = '21:00') {
  const d = bangkokDate(ms)
  return bangkokTime(ms) >= settleTime ? addDays(d, 1) : d
}

/** วันที่งานสรุปควรปิด = วันทางบัญชีก่อนหน้า (เลยเวลาสรุปของวันนี้แล้ว → วันนี้ · ยังไม่ถึง → เมื่อวาน) */
export function summaryDay(ms = Date.now(), settleTime = '21:00') {
  return addDays(businessDay(ms, settleTime), -1)
}
