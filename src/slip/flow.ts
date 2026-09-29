import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../app.ts'
import type { Couple, Member, Slip } from '../db/repo.ts'
import { formatBaht } from '../domain/money.js'
import { bangkokDate, bangkokTime, businessDay } from '../domain/time.js'
import { expenseCard } from '../line/flex.ts'
import type { LineEvent } from '../line/router.ts'
import { recordSettlement } from '../settle.ts'
import { classify } from './classify.ts'
import { readSlipQr } from './qr.ts'
import { saveSlipImage } from './store.ts'
import { log } from '../log.ts'
import type { SlipAi } from './vision.ts'

type Who = { couple: Couple; member: Member; members: Member[] }

async function replyText(ctx: Ctx, ev: LineEvent, text: string, extra: Record<string, unknown> = {}) {
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [{ type: 'text', text, ...extra }])
}

const dupText = (createdAt: string) => `สลิปนี้บันทึกแล้วเมื่อ ${bangkokTime(Date.parse(createdAt))} 👌`
const ASK_AMOUNT = 'อ่านยอดจากรูปไม่ออก 🙏 พิมพ์ยอดที่ถูกได้เลย เช่น 90'

/** เริ่มวันตามเวลาไทย เป็น ISO UTC (ใช้นับงบ AI รายวัน) */
function bangkokMidnightIso(ms: number) {
  return new Date(Date.parse(`${bangkokDate(ms)}T00:00:00+07:00`)).toISOString()
}

/** รูปเข้ามา → ถอด QR กันซ้ำ → เก็บรูป → AI อ่าน → จัดประเภท → บันทึก/ถามกลับ */
export async function onImage(ctx: Ctx, ev: LineEvent, who: Who): Promise<Slip | null> {
  const { repo } = ctx
  const buf = await ctx.line.getContent(ev.message!.id)
  const qr = await readSlipQr(buf)
  if (qr) {
    const dup = repo.slipByTransRef(qr.transRef)
    if (dup) return void (await replyText(ctx, ev, dupText(dup.created_at))), null
  }
  const imagePath = saveSlipImage(ctx.cfg.dataDir, who.couple.id, bangkokDate(ctx.now()), buf)
  let slip: Slip
  try {
    slip = repo.createSlip({
      couple_id: who.couple.id, member_id: who.member.id, image_path: imagePath,
      qr_trans_ref: qr?.transRef ?? null, bank: qr?.sendingBank ?? null, status: 'pending', created_at: new Date(ctx.now()).toISOString(),
    })
  } catch (e) {
    // ส่งสลิปเดียวกันพร้อมกันสองครั้ง → unique constraint
    const dup = qr && repo.slipByTransRef(qr.transRef)
    if (dup) {
      rmSync(join(ctx.cfg.dataDir, imagePath), { force: true })
      await replyText(ctx, ev, dupText(dup.created_at))
      return null
    }
    throw e
  }

  const cap = who.couple.ai_daily_cap ?? ctx.cfg.aiDailyCap
  if (repo.aiCountSince(who.couple.id, bangkokMidnightIso(ctx.now())) >= cap) {
    repo.updateSlip(slip.id, { status: 'done' })
    await replyText(ctx, ev, `วันนี้อ่านสลิปครบ ${cap} รูปแล้ว 🙏 พิมพ์ยอดแทนได้เลย เช่น "กาแฟ 90"`)
    return repo.slip(slip.id)!
  }

  let ai: SlipAi
  try {
    ai = await ctx.slips.read(buf)
  } catch (e) {
    log.error('slip_ai_error', { slip: slip.id, message: (e as Error).message })
    repo.updateSlip(slip.id, { status: 'await_amount', kind: 'expense' })
    await replyText(ctx, ev, ASK_AMOUNT)
    return repo.slip(slip.id)!
  }
  repo.updateSlip(slip.id, {
    ai_json: JSON.stringify(ai), amount_satang: ai.amount === null ? null : Math.round(ai.amount * 100),
    sender_name: ai.sender_name, receiver_name: ai.receiver_name, confidence: ai.confidence,
  })

  const c = classify(ai, who.member, who.members)
  if (c.kind === 'ignore' && !qr) {
    // รูปทั่วไปในแชท → เงียบ และไม่เก็บรูป
    rmSync(join(ctx.cfg.dataDir, imagePath), { force: true })
    repo.updateSlip(slip.id, { status: 'done', kind: 'unknown', image_path: null })
    return repo.slip(slip.id)!
  }
  if (c.kind === 'ignore' || c.kind === 'ask_amount') {
    repo.updateSlip(slip.id, { status: 'await_amount', kind: 'expense' })
    await replyText(ctx, ev, ASK_AMOUNT)
    return repo.slip(slip.id)!
  }
  repo.updateSlip(slip.id, { kind: c.kind })
  if (c.ask) {
    const label = `ใช่ ${formatBaht(c.amount)}`
    await replyText(ctx, ev, `อ่านได้ ${formatBaht(c.amount)} แต่ไม่ค่อยแน่ใจ ถูกไหม?`, {
      quickReply: { items: [
        { type: 'action', action: { type: 'postback', label, data: `slip:${slip.id}:ok`, displayText: label } },
        { type: 'action', action: { type: 'postback', label: 'แก้ยอด', data: `slip:${slip.id}:edit`, displayText: 'แก้ยอด' } },
      ] },
    })
    return repo.slip(slip.id)!
  }
  await finalizeSlip(ctx, ev, who, repo.slip(slip.id)!, c.amount)
  return repo.slip(slip.id)!
}

/** ยืนยันยอดแล้ว → สร้าง expense หรือ settlement */
export async function finalizeSlip(ctx: Ctx, ev: LineEvent, who: Who, slip: Slip, amount: number) {
  const { repo } = ctx
  const poster = repo.member(slip.member_id)!
  const ai: SlipAi | null = slip.ai_json ? JSON.parse(slip.ai_json) : null
  repo.updateSlip(slip.id, { status: 'done', amount_satang: amount })
  if (slip.kind === 'settlement' && ai) {
    const c = classify({ ...ai, amount: amount / 100 }, poster, who.members)
    if (c.kind === 'settlement') {
      return replyText(ctx, ev, recordSettlement(ctx, who.couple, c.from, c.to, amount, slip.id, poster.id))
    }
  }
  const day = businessDay(ctx.now(), who.couple.settle_time)
  const e = repo.createExpense({
    coupleId: who.couple.id, paidBy: poster.id, amount, merchant: (ai?.merchant || ai?.receiver_name || 'สลิป').slice(0, 60), category: ai?.category ?? null,
    occurredAt: new Date(ctx.now()).toISOString(), day, mode: who.couple.default_split, source: 'slip', slipId: slip.id, createdBy: poster.id, createdAt: new Date(ctx.now()).toISOString(),
  })
  repo.updateSlip(slip.id, { kind: 'expense' })
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [expenseCard(e, who.members, repo.ledger(who.couple.id, day).net)])
}

/** postback slip:<id>:ok|edit · คืน true ถ้าจัดการแล้ว */
export async function onSlipPostback(ctx: Ctx, ev: LineEvent, who: Who, data: string) {
  const m = data.match(/^slip:(\d+):(ok|edit)$/)
  if (!m) return false
  const slip = ctx.repo.slip(Number(m[1]))
  if (!slip || slip.couple_id !== who.couple.id) return true
  if (slip.status === 'done') return void (await replyText(ctx, ev, 'สลิปนี้บันทึกไปแล้ว')), true
  if (m[2] === 'ok' && slip.amount_satang) await finalizeSlip(ctx, ev, who, slip, slip.amount_satang)
  else {
    ctx.repo.updateSlip(slip.id, { status: 'await_amount' })
    await replyText(ctx, ev, 'พิมพ์ยอดที่ถูกได้เลย เช่น 85')
  }
  return true
}

/** ข้อความตัวเลขล้วนหลังบอทขอยอด → ใช้เป็นยอดของสลิปที่รออยู่ · คืน true ถ้าจัดการแล้ว */
export async function onAwaitingAmount(ctx: Ctx, ev: LineEvent, who: Who, amount: number | null) {
  if (amount === null) return false
  const slip = ctx.repo.awaitingSlip(who.couple.id, who.member.id)
  if (!slip) return false
  await finalizeSlip(ctx, ev, who, slip, amount)
  return true
}
