import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from '../app.ts'
import type { Couple, Expense, Member, Slip } from '../db/repo.ts'
import { formatBaht } from '../domain/money.js'
import type { SplitMode } from '../domain/split.js'
import { bangkokDate, bangkokTime, businessDay } from '../domain/time.js'
import type { Message } from '../line/client.ts'
import { expenseCard, netText } from '../line/flex.ts'
import type { LineEvent } from '../line/router.ts'
import { nudge } from '../onboard.ts'
import { recordSettlement } from '../settle.ts'
import { classify, PENDING_ANSWER_HOURS, PERSON_MERCHANT, SELF_MERCHANT, STALE_SLIP_HOURS } from './classify.ts'
import type { Classified } from './classify.ts'
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
    log.info('slip_read', { slip: slip.id, qr: qr ? 'yes' : 'no', ai: 'no', cap })
    await replyText(ctx, ev, `วันนี้อ่านสลิปครบ ${cap} รูปแล้ว 🙏 พิมพ์ยอดแทนได้เลย เช่น "กาแฟ 90"`)
    return repo.slip(slip.id)!
  }

  let ai: SlipAi
  try {
    ai = await ctx.slips.read(buf)
  } catch (e) {
    log.error('slip_ai_error', { slip: slip.id, message: (e as Error).message })
    log.info('slip_read', { slip: slip.id, qr: qr ? 'yes' : 'no', ai: 'no' })
    repo.updateSlip(slip.id, { status: 'await_amount', kind: 'expense' })
    await replyText(ctx, ev, ASK_AMOUNT)
    return repo.slip(slip.id)!
  }
  repo.updateSlip(slip.id, {
    ai_json: JSON.stringify(ai), amount_satang: ai.amount === null ? null : Math.round(ai.amount * 100),
    sender_name: ai.sender_name, receiver_name: ai.receiver_name, confidence: ai.confidence,
  })

  log.info('slip_read', { slip: slip.id, qr: qr ? 'yes' : 'no', ai: 'yes', confidence: ai.confidence })

  const c = classify(ai, who.member, who.members, { now: ctx.now(), staleHours: who.couple.stale_slip_hours ?? STALE_SLIP_HOURS })
  log.info('slip_classified', { slip: slip.id, rule: 'rule' in c ? c.rule : c.kind, pending: c.kind === 'stale' })
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
  if (c.kind === 'stale') {
    // กรณีเดียวที่ถามก่อนบันทึก: ยังไม่กระทบยอดจนกว่าจะตอบ
    repo.updateSlip(slip.id, { rule: 'stale' })
    await reply(ctx, ev, [{
      type: 'text', text: `สลิปนี้${ai.datetime ? 'เก่ากว่า ' + (who.couple.stale_slip_hours ?? STALE_SLIP_HOURS) + ' ชม.' : 'ไม่มีวันที่'} (${formatBaht(c.amount)}) นับเป็นรายการวันนี้ไหม?`,
      quickReply: { items: [btn('นับเป็นรายการวันนี้', `fix:${slip.id}:today`), btn('ไม่นับ', `fix:${slip.id}:ignore`)] },
    }])
    return repo.slip(slip.id)!
  }
  await reply(ctx, ev, afterClassify(ctx, who, repo.updateSlip(slip.id, { rule: c.rule }), c))
  return repo.slip(slip.id)!
}

const btn = (label: string, data: string) => ({ type: 'action', action: { type: 'postback', label: label.slice(0, 20), data, displayText: label } })

async function reply(ctx: Ctx, ev: LineEvent, messages: Message[]) {
  if (ev.replyToken && messages.length) await ctx.line.reply(ev.replyToken, messages)
}

/** จัดประเภทแล้ว: ยอดไม่แน่ใจ → ถามยอด (ของเดิม B07) · ไม่งั้นบันทึกทันที */
function afterClassify(ctx: Ctx, who: Who, slip: Slip, c: Exclude<Classified, { kind: 'ignore' | 'ask_amount' | 'stale' }>): Message[] {
  ctx.repo.updateSlip(slip.id, { kind: c.kind === 'settlement' ? 'settlement' : c.kind === 'expense' ? 'expense' : 'unknown' })
  if (!c.ask) return finalizeSlip(ctx, who, ctx.repo.slip(slip.id)!, c.amount)
  const label = `ใช่ ${formatBaht(c.amount)}`
  return [{
    type: 'text', text: `อ่านได้ ${formatBaht(c.amount)} แต่ไม่ค่อยแน่ใจ ถูกไหม?`,
    quickReply: { items: [btn(label, `slip:${slip.id}:ok`), btn('แก้ยอด', `slip:${slip.id}:edit`)] },
  }]
}

const aiOf = (slip: Slip): SlipAi | null => (slip.ai_json ? JSON.parse(slip.ai_json) : null)

/** การ์ดรายการจากสลิป + ปุ่มแก้แตะเดียว (เปลี่ยนการหาร · ไม่นับ · เป็นเคลียร์ยอด) + เตือนตั้งค่าวันละครั้ง */
function slipExpenseReply(ctx: Ctx, who: Who, e: Expense, rule: string | null, title?: string): Message[] {
  const members = ctx.repo.members(who.couple.id)
  const card = expenseCard(e, members, ctx.repo.ledger(who.couple.id, e.day).net, title)
  const qr = card.quickReply as { items: unknown[] }
  qr.items.push(btn('ไม่นับ', `fix:${e.slip_id}:ignore`))
  if (rule === 'person') qr.items.push(btn('เป็นเคลียร์ยอด', `fix:${e.slip_id}:settle`))
  return [card, ...nudge(ctx, who.couple, members, e.day)]
}

function settlementReply(ctx: Ctx, who: Who, slipId: number, text: string): Message[] {
  return [{ type: 'text', text, quickReply: { items: [btn('ไม่ใช่เคลียร์ยอด', `fix:${slipId}:notsettle`)] } }]
}

function createSlipExpense(ctx: Ctx, who: Who, slip: Slip, paidBy: number, amount: number, merchant: string, category: string | null, mode: SplitMode, actor: number) {
  const now = new Date(ctx.now()).toISOString()
  const e = ctx.repo.createExpense({
    coupleId: who.couple.id, paidBy, amount, merchant: merchant.slice(0, 60), category, occurredAt: now, day: businessDay(ctx.now(), who.couple.settle_time),
    mode, source: 'slip', slipId: slip.id, createdBy: actor, createdAt: now,
  })
  ctx.repo.updateSlip(slip.id, { kind: 'expense' })
  return e
}

/** ยืนยันยอดแล้ว → บันทึกตามกฎ (ไม่ตรวจสลิปเก่าซ้ำ) · คืนข้อความที่จะ reply */
export function finalizeSlip(ctx: Ctx, who: Who, slip: Slip, amount: number): Message[] {
  const { repo } = ctx
  const poster = repo.member(slip.member_id)!
  const ai = aiOf(slip)
  repo.updateSlip(slip.id, { status: 'done', amount_satang: amount })
  const c = ai ? classify({ ...ai, amount: amount / 100 }, poster, who.members) : null
  if (c?.kind === 'settlement') {
    return settlementReply(ctx, who, slip.id, recordSettlement(ctx, who.couple, c.from, c.to, amount, slip.id, poster.id))
  }
  if (c?.kind === 'self') {
    repo.updateSlip(slip.id, { ignored: 1, kind: 'unknown' })
    return [{
      type: 'text', text: `${SELF_MERCHANT} ${formatBaht(amount)} — ไม่นับเข้ายอด`,
      quickReply: { items: [btn('นับเป็นค่าใช้จ่าย', `fix:${slip.id}:count`)] },
    }]
  }
  const x = c?.kind === 'expense' ? c : { merchant: ai?.merchant || 'สลิป', category: ai?.category ?? null, rule: 'shop' }
  const e = createSlipExpense(ctx, who, slip, poster.id, amount, x.merchant, x.category, who.couple.default_split, poster.id)
  return slipExpenseReply(ctx, who, e, x.rule)
}

export type FixOp = 'today' | 'ignore' | 'count' | 'notsettle' | 'settle' | 'half' | 'mine' | 'theirs'

/**
 * แก้สลิปแตะเดียว (ปุ่มในแชท และ "นับ" จากแอป) · สลิปมีรายการที่นับได้อย่างมากหนึ่งอย่าง: expense หรือ settlement หรือไม่นับ
 * คืนข้อความที่จะ reply
 */
export function fixSlip(ctx: Ctx, who: Who, slip: Slip, op: FixOp, actor: number): Message[] {
  const { repo } = ctx
  const day = businessDay(ctx.now(), who.couple.settle_time)
  const members = repo.members(who.couple.id)
  const poster = repo.member(slip.member_id)!
  const text = (t: string, items: unknown[] = []) => [{ type: 'text', text: t, ...(items.length ? { quickReply: { items } } : {}) }]
  const net = () => netText(repo.ledger(who.couple.id, day).net, members)
  const stalePending = slip.status === 'pending' && slip.rule === 'stale'
  const rec = repo.recordOfSlip(slip.id)
  const amount = slip.amount_satang ?? 0
  const ai = aiOf(slip)
  const c = ai && amount ? classify({ ...ai, amount: amount / 100 }, poster, members) : null
  log.info('slip_fix', { slip: slip.id, op, member: actor })

  if (op === 'today') {
    if (!stalePending) return text('สลิปนี้ตอบไปแล้ว')
    const hours = who.couple.pending_answer_hours ?? PENDING_ANSWER_HOURS
    if (ctx.now() - Date.parse(slip.created_at) > hours * 3600_000) {
      repo.updateSlip(slip.id, { status: 'done', ignored: 1 })
      return text(`เกิน ${hours} ชม. แล้ว สลิปนี้ไม่นับ · กดนับทีหลังได้จากแอป`)
    }
    if (!c || c.kind === 'ignore' || c.kind === 'ask_amount' || c.kind === 'stale') {
      repo.updateSlip(slip.id, { status: 'await_amount', kind: 'expense', rule: null })
      return text(ASK_AMOUNT)
    }
    return afterClassify(ctx, who, repo.updateSlip(slip.id, { rule: c.rule }), c)
  }
  if (stalePending && op !== 'ignore') return text('ตอบก่อนว่าจะนับสลิปนี้ไหม')

  if (op === 'ignore') {
    if (rec?.entity === 'expense') repo.deleteExpense(rec.row.id, actor, day)
    else if (rec?.entity === 'settlement') repo.deleteSettlement(rec.row.id, actor, day)
    repo.updateSlip(slip.id, { status: 'done', ignored: 1 })
    return text(`ไม่นับสลิปนี้แล้ว (${formatBaht(amount)})\nยอดตอนนี้: ${net()}`, [btn('นับเป็นค่าใช้จ่าย', `fix:${slip.id}:count`)])
  }
  if (op === 'notsettle') {
    if (rec?.entity !== 'settlement') return text('สลิปนี้ไม่ได้เป็นเคลียร์ยอดแล้ว')
    const payer = repo.member(rec.row.from_member)!
    const other = members.find((m) => m.id !== payer.id)!
    return text('เป็นอะไรดี?', [btn('หารครึ่ง', `fix:${slip.id}:half`), btn(`ของ${payer.display_name}`, `fix:${slip.id}:mine`), btn(`ของ${other.display_name}`, `fix:${slip.id}:theirs`), btn('ไม่นับ', `fix:${slip.id}:ignore`)])
  }
  if (op === 'settle') {
    if (rec?.entity === 'settlement') return text('สลิปนี้เป็นเคลียร์ยอดอยู่แล้ว')
    const from = rec?.entity === 'expense' ? repo.member(rec.row.paid_by)! : poster
    if (rec?.entity === 'expense') repo.deleteExpense(rec.row.id, actor, day)
    const to = members.find((m) => m.id !== from.id)!
    return settlementReply(ctx, who, slip.id, recordSettlement(ctx, who.couple, from, to, amount, slip.id, actor))
  }
  // count / half / mine / theirs → เป็นค่าใช้จ่าย
  const mode: SplitMode = op === 'count' ? who.couple.default_split : op
  if (rec?.entity === 'expense') {
    if (op === 'count') return text('สลิปนี้นับอยู่แล้ว')
    const e = rec.row.split_mode === mode ? rec.row : repo.updateExpense(rec.row.id, { mode }, actor, day)
    return slipExpenseReply(ctx, who, e, slip.rule, '✓ เปลี่ยนการหารแล้ว')
  }
  let paidBy = poster.id
  if (rec?.entity === 'settlement') {
    paidBy = rec.row.from_member
    repo.deleteSettlement(rec.row.id, actor, day)
  } else if (c?.kind === 'settlement') paidBy = c.from.id
  const merchant = c?.kind === 'expense' || c?.kind === 'self' ? c.merchant : c?.kind === 'settlement' ? PERSON_MERCHANT : ai?.merchant || 'สลิป'
  const category = c?.kind === 'expense' ? c.category : null
  repo.updateSlip(slip.id, { status: 'done', ignored: 0 })
  const e = createSlipExpense(ctx, who, slip, paidBy, amount, merchant, category, mode, actor)
  return slipExpenseReply(ctx, who, e, c && 'rule' in c ? c.rule : slip.rule, '✓ นับเป็นค่าใช้จ่ายแล้ว')
}

/** postback slip:<id>:ok|edit และ fix:<id>:<op> · คืน true ถ้าจัดการแล้ว */
export async function onSlipPostback(ctx: Ctx, ev: LineEvent, who: Who, data: string) {
  const f = data.match(/^fix:(\d+):(today|ignore|count|notsettle|settle|half|mine|theirs)$/)
  if (f) {
    const slip = ctx.repo.slip(Number(f[1]))
    if (!slip || slip.couple_id !== who.couple.id) return true
    await reply(ctx, ev, fixSlip(ctx, who, slip, f[2] as FixOp, who.member.id))
    return true
  }
  const m = data.match(/^slip:(\d+):(ok|edit)$/)
  if (!m) return false
  const slip = ctx.repo.slip(Number(m[1]))
  if (!slip || slip.couple_id !== who.couple.id) return true
  if (slip.status === 'done') return void (await replyText(ctx, ev, 'สลิปนี้บันทึกไปแล้ว')), true
  if (m[2] === 'ok' && slip.amount_satang) await reply(ctx, ev, finalizeSlip(ctx, who, slip, slip.amount_satang))
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
  await reply(ctx, ev, finalizeSlip(ctx, who, slip, amount))
  return true
}
