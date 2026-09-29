import type { Ctx } from './app.ts'
import type { Couple, Expense } from './db/repo.ts'
import type { Message } from './line/client.ts'

export const DUP_WINDOW_MINUTES = 10

/**
 * เตือนว่าอาจซ้ำ (บันทึกตามปกติ ไม่บล็อก): คนจ่ายเดียวกัน ยอดเท่ากัน ภายใน N นาที · N = 0 ปิด
 * สลิปซ้ำจริงกันด้วย transRef อยู่แล้ว (flow.ts) — อันนี้จับพิมพ์ซ้ำ/พิมพ์แล้วส่งสลิปของรายการเดียวกัน
 */
export function dupNote(ctx: Ctx, couple: Couple, e: Expense): Message[] {
  const n = couple.dup_window_minutes ?? DUP_WINDOW_MINUTES
  if (n <= 0) return []
  const since = new Date(Date.parse(e.created_at) - n * 60_000).toISOString()
  const prev = ctx.repo.similarBefore(e, since)
  if (!prev) return []
  const mins = Math.round((Date.parse(e.created_at) - Date.parse(prev.created_at)) / 60_000)
  return [{ type: 'text', text: `ดูเหมือนซ้ำกับ "${prev.merchant}" ${mins < 1 ? 'เมื่อสักครู่' : `เมื่อ ${mins} นาทีก่อน`} · พิมพ์ ยกเลิก ถ้าซ้ำ` }]
}
