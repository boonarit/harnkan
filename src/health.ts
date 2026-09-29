import type { Ctx } from './app.ts'
import { addDays, summaryDay } from './domain/time.js'

export const STALE_EXPENSE_DAYS = 3
export const STALE_SUMMARY_NIGHTS = 2

/**
 * สัญญาณว่าระบบตาย: ไม่มีรายการใหม่เกิน 3 วัน หรืองานสรุปไม่ได้รัน (ไม่มีแถว daily_summaries) ตั้งแต่ 2 คืนขึ้นไป
 * ยังไม่มีคู่เลย = ไม่ stale (เพิ่งติดตั้ง)
 */
export function health(ctx: Ctx) {
  const db = ctx.repo.db
  const now = ctx.now()
  const q = (sql: string) => (db.prepare(sql).get() as { v: string | null }).v
  const couples = Number(q('SELECT COUNT(*) AS v FROM couples'))
  const lastExpense = q('SELECT MAX(created_at) AS v FROM expenses')
  const lastSummaryDate = q('SELECT MAX(date) AS v FROM daily_summaries')
  const lastSummarySent = q('SELECT MAX(created_at) AS v FROM daily_summaries')
  const reasons: string[] = []
  if (couples > 0) {
    const since = lastExpense ?? q('SELECT MIN(created_at) AS v FROM couples')!
    if (now - Date.parse(since) > STALE_EXPENSE_DAYS * 86400_000) reasons.push(`ไม่มีรายการใหม่เกิน ${STALE_EXPENSE_DAYS} วัน`)
    // จำนวนคืนที่ควรมีสรุปแต่ไม่มี (นับจากคืนหลังสรุปล่าสุด ถึงคืนล่าสุดที่ควรรันแล้ว)
    const due = summaryDay(now)
    const firstDay = lastSummaryDate ? addDays(lastSummaryDate, 1) : summaryDay(Date.parse(q('SELECT MIN(created_at) AS v FROM couples')!) + 86400_000)
    let missed = 0
    for (let d = firstDay; d <= due; d = addDays(d, 1)) missed++
    if (missed >= STALE_SUMMARY_NIGHTS) reasons.push(`ไม่ได้สรุปยอด ${missed} คืน`)
  }
  return {
    ok: true, mode: ctx.cfg.fakeLine || ctx.cfg.fakeAi ? 'fake' : 'real', couples,
    last_expense_at: lastExpense, last_summary_sent_at: lastSummarySent, stale: reasons.length > 0, reasons,
  }
}
