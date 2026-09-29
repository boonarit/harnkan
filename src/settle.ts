import type { Ctx } from './app.ts'
import type { Couple, Member } from './db/repo.ts'
import { formatBaht } from './domain/money.js'
import { businessDay } from './domain/time.js'
import { netText } from './line/flex.ts'

/**
 * บันทึกการโอนเคลียร์ยอด · ถ้ามีสรุปล่าสุดที่ยังไม่ปิดและโอนถูกทิศ → จับคู่กับสรุปนั้น
 * ยอดตรง = ปิด · ขาด/เกิน = ส่วนต่างเป็นยอดยกมา (ผ่าน outstanding ของสรุป)
 */
export function recordSettlement(ctx: Ctx, couple: Couple, from: Member, to: Member, amount: number, slipId: number | null, createdBy: number | null): string {
  const { repo } = ctx
  return repo.tx(() => {
    const members = repo.members(couple.id)
    const day = businessDay(ctx.now(), couple.settle_time)
    const signed = members[1].id === from.id ? amount : -amount // ลด N เมื่อ B โอนให้ A
    const open = repo.latestSummary(couple.id, '9999-12-31')
    const owed = open ? repo.outstanding(open) : 0
    const matches = open && !open.settled && owed !== 0 && Math.sign(owed) === Math.sign(signed)

    repo.createSettlement({ coupleId: couple.id, from: from.id, to: to.id, amount, day, summaryId: matches ? open.id : null, slipId, createdBy })
    const head = `รับโอน ${from.display_name} → ${to.display_name} ${formatBaht(amount)} แล้ว`
    if (!matches) return `${head}\nยอดตอนนี้: ${netText(repo.ledger(couple.id, day).net, members)}`

    const paid = open.paid_satang + signed
    const left = open.net_satang - paid
    const settled = left === 0 || Math.sign(left) !== Math.sign(owed)
    repo.updateSummary(open.id, { paid_satang: paid, settled: settled ? 1 : 0 })
    if (left === 0) return `${head}\nเคลียร์แล้ว ✅ ไม่มีใครติดใคร`
    if (!settled) return `${head}\nยังขาด ${formatBaht(Math.abs(left))} ยกไปพรุ่งนี้`
    return `${head}\nโอนเกิน ${formatBaht(Math.abs(left))} ยกไปพรุ่งนี้ (${netText(left, members)})`
  })
}

/** ปุ่ม "ทบไปพรุ่งนี้" */
export function carrySummary(ctx: Ctx, couple: Couple, summaryId: number, memberId: number): string | null {
  const s = ctx.repo.summaryById(summaryId)
  if (!s || s.couple_id !== couple.id) return null
  if (s.settled) return 'ยอดนี้เคลียร์ไปแล้ว'
  ctx.repo.updateSummary(s.id, { action: 'carry' })
  ctx.repo.audit(couple.id, 'daily_summary', s.id, memberId, 'carry', s, ctx.repo.summaryById(s.id))
  return 'โอเค ทบยอดไปรวมกับพรุ่งนี้ 👍'
}
