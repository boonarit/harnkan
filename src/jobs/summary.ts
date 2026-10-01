import type { Ctx } from '../app.ts'
import type { Couple } from '../db/repo.ts'
import { decide } from '../domain/balance.js'
import { bangkokDate, businessDay, summaryDay } from '../domain/time.js'
import { appUrl, summaryCard, thaiDate } from '../line/flex.ts'
import { makeQrPng } from '../promptpay/qr.ts'
import { log } from '../log.ts'

export type SummaryResult = { coupleId: number; date: string; action: 'zero' | 'carry' | 'request' | 'skip'; pushed: boolean }

/** หัวข้อสรุปที่บอกวันที่เสมอ · "วันนี้" ใช้กับวันที่ตรงกับวันนี้ (เวลาไทย) เท่านั้น */
export function summaryTitle(date: string, now: number) {
  return date === bangkokDate(now) ? `สรุปวันนี้ (${thaiDate(date)})` : `สรุปย้อนหลัง ${thaiDate(date)}`
}

/**
 * สรุปยอดของคู่เดียว · launchd รันทุก SUMMARY_EVERY_MIN นาที → สรุปเมื่อเลยเวลาสรุปของคู่แล้ว (summaryDay) และวันนั้นยังไม่มีสรุป
 * idempotent: มีแถวของวันนั้นแล้วไม่ส่งซ้ำ (ยกเว้น push รอบก่อนล้ม)
 */
export async function summarizeCouple(ctx: Ctx, couple: Couple): Promise<SummaryResult> {
  const { repo } = ctx
  const members = repo.members(couple.id)
  const date = summaryDay(ctx.now(), couple.settle_time)
  const skip = { coupleId: couple.id, date, action: 'skip' as const, pushed: false }
  if (members.length < 2) return skip
  // ไม่สรุปวันก่อนคู่ถูกสร้าง (เช่นหลังลบข้อมูลทั้งหมด) · ไม่ย้อนไปสรุปวันที่เก่ากว่าสรุปล่าสุด (เพิ่งเลื่อนเวลาสรุป)
  if (date < businessDay(Date.parse(couple.created_at), couple.settle_time)) return skip
  if ((repo.latestSummary(couple.id)?.date ?? '') > date) return skip

  let s = repo.summary(couple.id, date)
  const ledger = repo.ledger(couple.id, date)
  if (!s) {
    const d = decide(ledger.net, couple.min_transfer)
    s = repo.createSummary({ coupleId: couple.id, date, net: ledger.net, carriedIn: ledger.carriedIn, action: d.action, createdAt: new Date(ctx.now()).toISOString() })
    if (!s) return skip // มีอีก process สร้างไปก่อน
  } else if (s.sent_message_id || s.action === 'carry' || (s.action === 'zero' && !ledger.expenses.length)) {
    return skip
  }
  const title = summaryTitle(date, ctx.now())

  if (s.action === 'carry') return { coupleId: couple.id, date, action: 'carry', pushed: false }
  if (s.action === 'zero') {
    // ไม่มีรายการเลยทั้งวัน → ไม่ push (ประหยัดโควตา ไม่รบกวน)
    if (!ledger.expenses.length) return { coupleId: couple.id, date, action: 'zero', pushed: false }
    const id = await ctx.line.push(couple.line_group_id, [{ type: 'text', text: `${title}: ไม่มีใครติดใคร 🎉` }])
    repo.updateSummary(s.id, { sent_message_id: id ?? 'sent' })
    return { coupleId: couple.id, date, action: 'zero', pushed: true }
  }

  const d = decide(s.net_satang, couple.min_transfer)
  const from = members[d.from]
  const to = members[d.to]
  let qrUrl: string | null = null
  if (to.promptpay_id) {
    const token = s.qr_token ?? (await makeQrPng(ctx.cfg.dataDir, to.promptpay_id, d.amount))
    if (!s.qr_token) repo.updateSummary(s.id, { qr_token: token })
    qrUrl = `${ctx.cfg.publicBaseUrl}/qr/${token}.png`
  }
  const card = summaryCard({ summaryId: s.id, title, amount: d.amount, from, to, bills: ledger.expenses.length, carriedIn: s.carried_in, qrUrl, appLink: appUrl(ctx.cfg.liffId, '/settle') })
  const id = await ctx.line.push(couple.line_group_id, [card])
  repo.updateSummary(s.id, { sent_message_id: id ?? 'sent' })
  return { coupleId: couple.id, date, action: 'request', pushed: true }
}

export async function runSummary(ctx: Ctx): Promise<SummaryResult[]> {
  const out: SummaryResult[] = []
  for (const c of ctx.repo.allCouples()) {
    try {
      out.push(await summarizeCouple(ctx, c))
    } catch (e) {
      log.error('summary_error', { couple: c.id, message: (e as Error).message })
    }
  }
  return out
}

if (process.argv[1]?.endsWith('summary.ts')) {
  const { bootstrap } = await import('../app.ts')
  const ctx = bootstrap()
  const res = await runSummary(ctx)
  log.info('summary_done', { results: res })
  console.log(JSON.stringify({ job: 'summary', results: res }))
}
