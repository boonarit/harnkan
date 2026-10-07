import type { Member } from '../db/repo.ts'
import type { SlipAi } from './vision.ts'

export const MIN_CONFIDENCE = 0.8
/** ค่าเริ่มต้นเมื่อคู่ยังไม่ได้ตั้งเอง (couples.stale_slip_hours / pending_answer_hours) · stale 0 = ปิดการถามสลิปเก่า */
export const STALE_SLIP_HOURS = 24
export const PENDING_ANSWER_HOURS = 24

/** payment gateway: ชื่อบนสลิปเป็นตัวกลาง ไม่ใช่ร้านจริง (แหล่งเดียว เทียบแบบไม่สนตัวพิมพ์/ช่องว่าง) */
export const GATEWAYS = ['2C2P', 'KShop', 'TrueMoney', 'ทรูมันนี่', 'Rabbit LINE Pay', 'LINE Pay', 'ShopeePay', 'Omise', 'GB Prime Pay', 'Ksher', 'Pay Solutions', 'ChillPay']
/** คำที่บอกว่าเป็นการเติมเงินเข้า e-wallet ของตัวเอง (แหล่งเดียว) */
export const TOPUP_WORDS = ['เติมเงิน', 'top up', 'topup', 'top-up', 'wallet', 'วอลเล็ท']

export const PERSON_MERCHANT = 'โอนให้บุคคล'
export const SELF_MERCHANT = 'เติมเงิน/โอนเข้าบัญชีตัวเอง'

/**
 * กฎ (B17): partner = โอนให้อีกคนในคู่ → เคลียร์ยอด · shop = ร้าน → ค่าใช้จ่าย · person = บุคคลอื่น → ค่าใช้จ่าย (ไม่ใช้ชื่อบนสลิป)
 * self = โอนเข้าตัวเอง/เติมเงิน → ไม่นับ · stale = สลิปเก่า/ไม่มีวันที่ → ถามก่อน (กรณีเดียว)
 */
export type Rule = 'partner' | 'shop' | 'person' | 'self'
export type Classified =
  | { kind: 'ignore' }
  | { kind: 'ask_amount' }
  | { kind: 'stale'; amount: number }
  | { kind: 'settlement'; rule: 'partner'; amount: number; from: Member; to: Member; ask: boolean }
  | { kind: 'expense'; rule: 'shop' | 'person'; amount: number; merchant: string; category: string | null; ask: boolean }
  | { kind: 'self'; rule: 'self'; amount: number; merchant: string; ask: boolean }

const TITLES = /^(นางสาว|นาง|นาย|น\.ส\.|ด\.ช\.|ด\.ญ\.|mrs?\.?|ms\.?|miss)\s*/i

/** ชื่อบนสลิปมักถูกปิดบางส่วน ("นาย เอ ส***") → เทียบเฉพาะคำแรกหลังคำนำหน้า */
export function firstName(name: string | null | undefined): string {
  if (!name) return ''
  return name.trim().replace(TITLES, '').split(/\s+/)[0].replace(/[*.x]+$/i, '').toLowerCase()
}

export function nameMatches(slipName: string | null, m: Member): boolean {
  const n = firstName(slipName)
  if (!n) return false
  const candidates = [m.display_name, ...(JSON.parse(m.bank_names || '[]') as string[])]
  return candidates.some((c) => firstName(c) === n)
}

const suffixesOf = (m: Member) => JSON.parse(m.account_suffixes || '[]') as string[]
const last4 = (n: string | null | undefined) => (n && n.length >= 4 ? n.slice(-4) : null)

/** เลขท้าย 4 หลักทุกบัญชีที่สมาชิกตั้งไว้: เลขท้ายบัญชี + พร้อมเพย์ + บัญชีรับเงิน (สลิปโชว์แค่เลขท้ายแบบปิดบัง) */
export function knownAccounts(m: Member): string[] {
  return [...new Set([...suffixesOf(m), last4(m.promptpay_id), last4(m.bank_account)].filter((x): x is string => !!x))]
}

/** เลขบัญชีบนสลิปขัดกับที่ตั้งไว้: ตั้งเลขท้ายบัญชีไว้ (= รายการบัญชีครบ) แต่เลขบนสลิปไม่อยู่ในบัญชีที่รู้จัก */
function accountConflicts(account: string | null, m: Member) {
  return !!account && suffixesOf(m).length > 0 && !knownAccounts(m).includes(account)
}

/** เป็นคนนี้ในคู่ไหม: ชื่อต้นตรง **และ** ถ้าตั้งเลขท้ายบัญชีไว้ เลขท้ายบนสลิปต้องเป็นบัญชีของเขา (กันโอนให้คนชื่อซ้ำ) */
export function isMember(slipName: string | null, account: string | null, m: Member): boolean {
  if (!nameMatches(slipName, m)) return false
  return !suffixesOf(m).length || (!!account && knownAccounts(m).includes(account))
}

const squash = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/\s+/g, '')
export function findGateway(s: string | null | undefined): string | null {
  const t = squash(s)
  return (t && GATEWAYS.find((g) => t.includes(squash(g)))) || null
}
const isTopup = (s: string | null | undefined) => !!s && TOPUP_WORDS.some((w) => squash(s).includes(squash(w)))

/**
 * โอนเข้าบัญชีตัวเอง / เติม e-wallet ตัวเอง · ตัดสินจากตัวตนผู้รับก่อน คำบนสลิปและคำตอบ AI ใช้เฉพาะเมื่อผู้รับไม่มีชื่อคน/ร้าน
 * - ผู้รับมีชื่อ (คนหรือร้าน) → ตัวเองเฉพาะเมื่อชื่อเดียวกับผู้โอน และเลขบัญชีไม่ขัดกับที่ตั้งไว้ของผู้ส่งรูป
 *   (ร้านที่รับเงินผ่านพร้อมเพย์ e-Wallet ทำให้ AI ตอบ topup / สลิปมีคำว่า wallet ได้ จึงไม่ใช้สัญญาณพวกนั้นตรงนี้)
 * - ผู้รับไม่มีชื่อ หรือเป็นผู้ให้บริการ wallet (gateway) → ตัวเองเมื่อเลขบัญชีตรงบัญชีที่ตั้งไว้ หรือมีสัญญาณเติมเงิน
 */
export function isSelfTransfer(ai: SlipAi, poster: Member): boolean {
  const receiver = firstName(ai.receiver_name)
  if (receiver && !findGateway(ai.receiver_name)) {
    return receiver === firstName(ai.sender_name) && !accountConflicts(ai.receiver_account, poster)
  }
  const ownAccount = !!ai.receiver_account && knownAccounts(poster).includes(ai.receiver_account)
  return ownAccount || ai.receiver_kind === 'topup' || isTopup(ai.receiver_name) || isTopup(ai.merchant)
}

/** สลิปเก่ากว่า hours ชม. หรือไม่มีวันที่ · hours = 0 ปิด · วันที่ในอนาคต (นาฬิกาเพี้ยน) ไม่นับว่าเก่า */
export function isStale(datetime: string | null, now: number, hours: number) {
  if (hours <= 0) return false
  const t = datetime ? Date.parse(datetime) : NaN
  return Number.isNaN(t) || now - t > hours * 3600_000
}

/**
 * ผล AI → จะบันทึกเป็นอะไร (ฟังก์ชันเดียว ใช้ทั้งตอนรับรูป ตอบปุ่ม และนับทีหลังจากแอป)
 * stale ตรวจเฉพาะเมื่อส่ง opts.now (ตอนรับรูป) — ตอบ "นับเป็นรายการวันนี้" แล้วเรียกใหม่โดยไม่ส่ง now
 */
export function classify(ai: SlipAi, poster: Member, members: Member[], opts: { now?: number; staleHours?: number } = {}): Classified {
  const other = members.find((m) => m.id !== poster.id)
  if (ai.type === 'other') return { kind: 'ignore' }
  if (ai.amount === null) return { kind: 'ask_amount' }
  const amount = Math.round(ai.amount * 100)
  const ask = ai.confidence < MIN_CONFIDENCE
  if (opts.now !== undefined && isStale(ai.datetime, opts.now, opts.staleHours ?? STALE_SLIP_HOURS)) return { kind: 'stale', amount }

  if (ai.type === 'transfer_slip') {
    if (isSelfTransfer(ai, poster)) return { kind: 'self', rule: 'self', amount, merchant: SELF_MERCHANT, ask }
    if (other) {
      if (isMember(ai.receiver_name, ai.receiver_account, other)) return { kind: 'settlement', rule: 'partner', amount, from: poster, to: other, ask }
      // คนรับเป็นคนส่งรูปเข้ากลุ่มเอง
      if (isMember(ai.receiver_name, ai.receiver_account, poster) && isMember(ai.sender_name, ai.sender_account, other)) {
        return { kind: 'settlement', rule: 'partner', amount, from: other, to: poster, ask }
      }
    }
    const gateway = findGateway(ai.receiver_name) ?? findGateway(ai.merchant)
    if (gateway) {
      const merchant = ai.merchant && !findGateway(ai.merchant) ? ai.merchant : `จ่ายผ่าน ${gateway}`
      return { kind: 'expense', rule: 'shop', amount, merchant: merchant.slice(0, 60), category: ai.category, ask }
    }
    const person = ai.receiver_kind ? ai.receiver_kind === 'person' : TITLES.test((ai.receiver_name ?? '').trim())
    if (person) return { kind: 'expense', rule: 'person', amount, merchant: PERSON_MERCHANT, category: null, ask }
  }
  return { kind: 'expense', rule: 'shop', amount, merchant: (ai.merchant || ai.receiver_name || 'สลิป').slice(0, 60), category: ai.category, ask }
}
