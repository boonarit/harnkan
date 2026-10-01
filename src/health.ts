import type { Ctx } from './app.ts'
import { addDays, businessDay, summaryDay } from './domain/time.js'

export const STALE_EXPENSE_DAYS = 3
export const STALE_SUMMARY_NIGHTS = 2

/**
 * สัญญาณว่าระบบตาย: ไม่มีรายการใหม่เกิน 3 วัน หรืองานสรุปไม่ได้รัน (ไม่มีแถว daily_summaries) ตั้งแต่ 2 คืนขึ้นไปตามเวลาสรุปของแต่ละคู่
 * ยังไม่มีคู่เลย = ไม่ stale (เพิ่งติดตั้ง)
 */
export function health(ctx: Ctx) {
  const db = ctx.repo.db
  const now = ctx.now()
  const q = (sql: string) => (db.prepare(sql).get() as { v: string | null }).v
  const couples = Number(q('SELECT COUNT(*) AS v FROM couples'))
  const lastExpense = q('SELECT MAX(created_at) AS v FROM expenses')
  const lastSummarySent = q('SELECT MAX(created_at) AS v FROM daily_summaries')
  const reasons: string[] = []
  if (couples > 0) {
    const since = lastExpense ?? q('SELECT MIN(created_at) AS v FROM couples')!
    if (now - Date.parse(since) > STALE_EXPENSE_DAYS * 86400_000) reasons.push(`ไม่มีรายการใหม่เกิน ${STALE_EXPENSE_DAYS} วัน`)
    // จำนวนคืนที่ควรมีสรุปแต่ไม่มี ต่อคู่ ตามเวลาสรุปของคู่นั้น (นับจากคืนหลังสรุปล่าสุด/วันที่สร้างคู่ ถึงคืนล่าสุดที่เลยเวลาสรุปแล้ว) · คู่ที่ยังลงทะเบียนไม่ครบไม่นับ
    let missed = 0
    for (const c of ctx.repo.allCouples()) {
      if (ctx.repo.members(c.id).length < 2) continue
      const last = ctx.repo.latestSummary(c.id)?.date
      const firstDay = last ? addDays(last, 1) : businessDay(Date.parse(c.created_at), c.settle_time)
      let n = 0
      for (let d = firstDay; d <= summaryDay(now, c.settle_time); d = addDays(d, 1)) n++
      missed = Math.max(missed, n)
    }
    if (missed >= STALE_SUMMARY_NIGHTS) reasons.push(`ไม่ได้สรุปยอด ${missed} คืน`)
  }
  return {
    ok: true, mode: ctx.cfg.fakeLine || ctx.cfg.fakeAi ? 'fake' : 'real', couples,
    last_expense_at: lastExpense, last_summary_sent_at: lastSummarySent, stale: reasons.length > 0, reasons,
  }
}
