// @ts-check
// ข้อมูลคู่สมมติ เอ & บี: วันตัวอย่าง (วันนี้) + ย้อนหลัง 3 สัปดาห์ (เคลียร์แล้ว) — กำหนดตายตัว ไม่สุ่ม
import { addDays, businessDay } from '#domain/time.js'

const HISTORY = [
  ['กาแฟ', 9000], ['ข้าวมันไก่', 12000], ['Grab', 18500], ['ชานม', 11000], ['ข้าวเย็น', 32000], ['7-Eleven', 8900],
  ['ค่าน้ำ', 21000], ['ส้มตำ', 15000], ['ซูเปอร์มาร์เก็ต', 64500], ['ขนมปัง', 6500], ['หนัง', 44000], ['ค่าที่จอด', 4000],
]

/** @param {number} now */
export function demoSeed(now = Date.now()) {
  const today = businessDay(now, '21:00')
  /** @type {import('../public/app/data/adapter.js').LocalExpense[]} */
  const expenses = []
  let seq = 0
  /** @param {string} day @param {string} hm @param {number} paid_by @param {string} merchant @param {number} amount @param {string} split_mode */
  const add = (day, hm, paid_by, merchant, amount, split_mode, source = 'text') => {
    expenses.push({ id: ++seq, merchant, amount, paid_by, split_mode, ratio: null, day, occurred_at: `${day}T${hm}:00+07:00`, source, slip_id: null, category: null, status: 'active', created_by: paid_by })
  }
  /** @type {string[]} */
  const settled = []
  for (let d = 21; d >= 1; d--) {
    const day = addDays(today, -d)
    const n = 2 + (d % 3)
    for (let i = 0; i < n; i++) {
      const [merchant, amount] = HISTORY[(d * 3 + i) % HISTORY.length]
      add(day, `${String(9 + i * 4).padStart(2, '0')}:15`, (d + i) % 2 ? 1 : 2, /** @type {string} */ (merchant), /** @type {number} */ (amount), i === 2 && d % 5 === 0 ? 'treat' : 'half')
    }
    settled.push(day)
  }
  // วันตัวอย่างใน PLAN → บี โอนให้ เอ ฿347.50
  add(today, '08:10', 1, 'กาแฟ 2 แก้ว', 9000, 'half')
  add(today, '12:30', 2, 'ข้าวกลางวัน', 24000, 'half')
  add(today, '18:45', 1, '7-Eleven', 12700, 'half', 'slip')
  add(today, '19:10', 1, 'ครีมกันแดด', 35900, 'theirs', 'slip')
  add(today, '20:00', 2, 'ข้าวเย็น', 42000, 'treat')
  return {
    members: [
      { id: 1, display_name: 'เอ', promptpay_id: '0800000001', bank_names: ['เอ สมมติ'] },
      { id: 2, display_name: 'บี', promptpay_id: '0800000002', bank_names: ['บี สมมติ'] },
    ],
    settings: { settle_time: '21:00', min_transfer: 5000, default_split: 'half', ai_daily_cap: 30, slip_retention_days: 365 },
    expenses, settlements: [], settled_days: settled, audit: [], seq, me: 1,
  }
}
