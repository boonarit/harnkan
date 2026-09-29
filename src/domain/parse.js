// @ts-check
import { parseAmount } from './money.js'

/**
 * @typedef {{ kind: 'expense', merchant: string, amount: number, mode: 'treat' | 'half' | null, forName: string | null }} ExpenseIntent
 * @typedef {{ kind: 'command', command: 'summary' | 'undo' | 'help' | 'deleteAll' | 'setup' }} CommandIntent
 * @typedef {{ kind: 'command', command: 'rename', name: string }} RenameIntent
 */

// ---- คำที่ parser ใช้ (แหล่งเดียว: ตัวตรวจชื่อ domain/name.js ดึงจาก PARSER_WORDS) ----
const COMMANDS = /** @type {const} */ ({ สรุป: 'summary', ยกเลิก: 'undo', ช่วยด้วย: 'help', ลบข้อมูลทั้งหมด: 'deleteAll', ตั้งค่า: 'setup' })
const RENAME = 'ตั้งชื่อ'
const OWNER = 'ของ'
/** คำหน้า/ท้ายรายการที่กำหนดโหมดหาร */
const MODE_WORDS = /** @type {const} */ ({ เลี้ยง: 'treat', หารครึ่ง: 'half', ครึ่ง: 'half' })
const CURRENCY = ['฿', 'บาท', 'บ']

export const PARSER_WORDS = Object.freeze({
  commands: [...Object.keys(COMMANDS), RENAME],
  markers: [OWNER, ...Object.keys(MODE_WORDS)],
  currency: CURRENCY,
})

/** @param {string} s */
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const MODE_ALT = Object.keys(MODE_WORDS).sort((a, b) => b.length - a.length).map(rx).join('|')
const SUFFIX_ALT = CURRENCY.filter((c) => /\p{L}/u.test(c)).map(rx).join('|')
const PREFIX_SYM = CURRENCY.filter((c) => !/\p{L}/u.test(c)).map(rx).join('')

// คำ (ทั้งคำ ติดหน้าตัวเลข) ที่บอกว่าตัวเลขไม่ใช่เงิน: เวลา ระยะ จำนวน ห้อง ฯลฯ → เงียบ
// ต้องเทียบทั้งคำ ไม่ใช่ substring — "ข้าวกลางวัน" "รองเท้า" "ปีกไก่" เป็นรายการจริง
const NOT_MONEY_WORDS = new Set(['นัด', 'เจอกัน', 'ถึง', 'รอ', 'ห้อง', 'ชั้น', 'เบอร์', 'โทร', 'เลขที่', 'บ้านเลขที่', 'ตอน', 'เวลา', 'ตี', 'ทุ่ม', 'โมง', 'นาที', 'ชั่วโมง', 'ชม.', 'วัน', 'เดือน', 'ปี', 'อายุ', 'คะแนน', 'รอบ', 'ข้อ', 'คน', 'ครั้ง', 'กม', 'กม.', 'กิโล', 'ชิ้น', 'อัน', 'ที่', 'อีก'])
const QUESTION = /(กี่\S*|ไหม|มั้ย|เท่าไหร่|เท่าไร|\?|？)$/

/** @param {string} merchant */
function notMoney(merchant) {
  const last = merchant.split(' ').at(-1) ?? ''
  return NOT_MONEY_WORDS.has(last) || QUESTION.test(merchant) || /\d$/.test(merchant) || merchant.includes('%')
}
const AMOUNT_AT_END = new RegExp(`^(?:(.*?)\\s+)?([${PREFIX_SYM}]?\\d[\\d,]*(?:\\.\\d{1,2})?)\\s*(?:(?:${SUFFIX_ALT})\\.?)?\\s*(${MODE_ALT})?$`)
const MODE_PREFIX = new RegExp(`^(${MODE_ALT})\\s+`)

/**
 * แปลงข้อความแชท → รายการ/คำสั่ง · ไม่ใช่ทั้งคู่ → null (บอทต้องเงียบ)
 * @param {string} text
 * @param {string[]} names ชื่อสมาชิกในกลุ่ม ใช้จับ "ของ<ชื่อ>"
 * @returns {ExpenseIntent | CommandIntent | RenameIntent | null}
 */
export function parseMessage(text, names = []) {
  const t = String(text).replace(/\s+/g, ' ').trim()
  if (!t || t.length > 60 || t.includes('\n')) return null
  const cmd = COMMANDS[/** @type {keyof typeof COMMANDS} */ (t)]
  if (cmd) return { kind: 'command', command: cmd }
  if (t === RENAME || t.startsWith(`${RENAME} `)) return { kind: 'command', command: 'rename', name: t.slice(RENAME.length).trim() }

  let body = t
  /** @type {'treat' | 'half' | null} */
  let mode = null
  const pre = body.match(MODE_PREFIX)
  if (pre) {
    mode = MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (pre[1])]
    body = body.slice(pre[0].length)
  }
  const m = body.match(AMOUNT_AT_END)
  if (!m) return null
  let merchant = (m[1] ?? '').trim()
  const amount = parseAmount(m[2])
  if (m[3]) mode = MODE_WORDS[/** @type {keyof typeof MODE_WORDS} */ (m[3])]
  if (amount === null || amount === 0) return null
  if (/^5{3,}$/.test(m[2])) return null // 555 = หัวเราะ
  if (!merchant && (m[2].replace(/\D/g, '').length > 6 || m[2].startsWith('0'))) return null // เลขยาว/เบอร์
  if (merchant && notMoney(merchant)) return null

  /** @type {string | null} */
  let forName = null
  const sorted = [...names].sort((a, b) => b.length - a.length)
  for (const n of sorted) {
    const tag = `${OWNER}${n}`
    if (n && merchant.includes(tag)) {
      forName = n
      merchant = merchant.replace(tag, '').trim()
      break
    }
  }
  return { kind: 'expense', merchant: merchant || 'ไม่ระบุ', amount, mode, forName }
}
