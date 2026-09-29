import type { Member } from '../db/repo.ts'
import type { SlipAi } from './vision.ts'

export const MIN_CONFIDENCE = 0.8

export type Classified =
  | { kind: 'ignore' }
  | { kind: 'expense'; amount: number; ask: boolean }
  | { kind: 'settlement'; amount: number; from: Member; to: Member; ask: boolean }
  | { kind: 'ask_amount' }

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

/** ผล AI → เป็นการโอนเคลียร์ยอด / ค่าใช้จ่าย / ต้องถามกลับ / ไม่ใช่สลิป */
export function classify(ai: SlipAi, poster: Member, members: Member[]): Classified {
  const other = members.find((m) => m.id !== poster.id)
  if (ai.type === 'other') return { kind: 'ignore' }
  if (ai.amount === null) return { kind: 'ask_amount' }
  const amount = Math.round(ai.amount * 100)
  const ask = ai.confidence < MIN_CONFIDENCE
  if (ai.type === 'transfer_slip' && other) {
    if (nameMatches(ai.receiver_name, other)) return { kind: 'settlement', amount, from: poster, to: other, ask }
    // คนรับเป็นคนส่งรูปเข้ากลุ่มเอง
    if (nameMatches(ai.receiver_name, poster) && nameMatches(ai.sender_name, other)) return { kind: 'settlement', amount, from: other, to: poster, ask }
  }
  return { kind: 'expense', amount, ask }
}
