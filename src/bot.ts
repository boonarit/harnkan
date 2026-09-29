import type { Ctx } from './app.ts'
import type { Couple, Member } from './db/repo.ts'
import { formatBaht } from './domain/money.js'
import { validateName } from './domain/name.js'
import { parseMessage } from './domain/parse.js'
import { MODES } from './domain/split.js'
import type { SplitMode } from './domain/split.js'
import { businessDay } from './domain/time.js'
import { expenseCard, netText } from './line/flex.ts'
import type { Handlers, LineEvent } from './line/router.ts'
import { onAwaitingAmount, onImage, onSlipPostback } from './slip/flow.ts'
import { carrySummary } from './settle.ts'
import { onWipePostback, startWipe } from './wipe.ts'

type Who = { couple: Couple; member: Member; members: Member[] }

export const HELP = [
  'วิธีใช้หารกัน 🧾',
  '• พิมพ์ "กาแฟ 90" → หารครึ่ง',
  '• "ข้าวเย็น 420 เลี้ยง" → เลี้ยง ไม่นับเข้ายอด',
  '• "ครีมกันแดดของบี 359" → ของอีกคนทั้งหมด',
  '• ส่งรูปสลิป/ใบเสร็จ → อ่านยอดให้',
  '• "สรุป" ดูยอดตอนนี้ · "ยกเลิก" ลบรายการล่าสุดของคุณ',
  '• "ตั้งชื่อ ส้ม" เปลี่ยนชื่อที่บอทใช้เรียกคุณ',
  '• 21:00 สรุปยอดโอนเดียว + QR พร้อมเพย์',
].join('\n')

export async function replyText(ctx: Ctx, ev: LineEvent, text: string, extra: Record<string, unknown> = {}) {
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [{ type: 'text', text, ...extra }])
}

export const today = (ctx: Ctx, couple: Couple) => businessDay(ctx.now(), couple.settle_time)

export function nowIso(ctx: Ctx) {
  return new Date(ctx.now()).toISOString()
}

/** โหมดหารจาก "ของ<ชื่อ>" เทียบกับคนจ่าย */
export function modeFor(forName: string | null, payer: Member, members: Member[], fallback: SplitMode): SplitMode {
  if (!forName) return fallback
  const owner = members.find((m) => m.display_name === forName)
  if (!owner) return fallback
  return owner.id === payer.id ? 'mine' : 'theirs'
}

async function needPartner(ctx: Ctx, ev: LineEvent, who: Who) {
  if (who.members.length >= 2) return false
  await replyText(ctx, ev, 'รออีกคนพิมพ์อะไรก็ได้ในกลุ่มนี้ก่อนนะ แล้วบอทจะเริ่มหารให้ 🙌')
  return true
}

async function onText(ctx: Ctx, ev: LineEvent, who: Who) {
  const text = ev.message?.text ?? ''
  const intent = parseMessage(text, who.members.map((m) => m.display_name))
  const bare = intent?.kind === 'expense' && intent.merchant === 'ไม่ระบุ' && !intent.forName && !intent.mode ? intent.amount : null
  if (await onAwaitingAmount(ctx, ev, who, bare)) return
  if (!intent) return // ไม่ใช่รายการ → เงียบ
  const { repo } = ctx
  const day = today(ctx, who.couple)

  if (intent.kind === 'command') {
    if (intent.command === 'help') return replyText(ctx, ev, HELP)
    if (intent.command === 'rename') {
      const r = validateName(intent.name, who.members.filter((m) => m.id !== who.member.id).map((m) => m.display_name))
      if (!r.ok) return replyText(ctx, ev, `เปลี่ยนชื่อไม่ได้: ${r.error}`)
      const after = repo.updateMember(who.member.id, { display_name: r.name })
      repo.audit(who.couple.id, 'member', who.member.id, who.member.id, 'rename', who.member, after)
      return replyText(ctx, ev, `เปลี่ยนชื่อเป็น "${r.name}" แล้ว ✓`)
    }
    if (await needPartner(ctx, ev, who)) return
    if (intent.command === 'summary') {
      const l = repo.ledger(who.couple.id, day)
      const extra = l.carriedIn ? `\nยอดยกมา ${formatBaht(l.carriedIn)}` : ''
      return replyText(ctx, ev, `ยอดตอนนี้: ${netText(l.net, who.members)}\n(${l.expenses.length} รายการวันนี้)${extra}`)
    }
    if (intent.command === 'undo') {
      const last = repo.lastExpenseBy(who.couple.id, who.member.id)
      if (!last) return replyText(ctx, ev, 'ยังไม่มีรายการของคุณให้ยกเลิก')
      repo.deleteExpense(last.id, who.member.id, day)
      return replyText(ctx, ev, `ลบ "${last.merchant} ${formatBaht(last.amount_satang)}" แล้ว\nยอดตอนนี้: ${netText(repo.ledger(who.couple.id, day).net, who.members)}`)
    }
    if (ev.replyToken) await ctx.line.reply(ev.replyToken, [startWipe(ctx, who.couple)])
    return
  }

  if (await needPartner(ctx, ev, who)) return
  const mode = intent.mode ?? modeFor(intent.forName, who.member, who.members, who.couple.default_split)
  const e = repo.createExpense({
    coupleId: who.couple.id, paidBy: who.member.id, amount: intent.amount, merchant: intent.merchant.slice(0, 60),
    occurredAt: nowIso(ctx), day, mode, source: 'text', createdBy: who.member.id, createdAt: nowIso(ctx),
  })
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [expenseCard(e, who.members, repo.ledger(who.couple.id, day).net)])
}

async function onPostback(ctx: Ctx, ev: LineEvent, who: Who) {
  const data = ev.postback?.data ?? ''
  if (await onSlipPostback(ctx, ev, who, data)) return
  const wipe = onWipePostback(ctx, who.couple, who.member.id, data)
  if (wipe) return void (ev.replyToken && (await ctx.line.reply(ev.replyToken, [wipe])))
  const carry = data.match(/^carry:(\d+)$/)
  if (carry) {
    const text = carrySummary(ctx, who.couple, Number(carry[1]), who.member.id)
    return text ? replyText(ctx, ev, text) : undefined
  }
  const m = data.match(/^split:(\d+):(\w+)$/)
  if (!m || !MODES.includes(m[2] as SplitMode)) return
  const e = ctx.repo.expense(Number(m[1]))
  if (!e || e.couple_id !== who.couple.id || e.status !== 'active') return replyText(ctx, ev, 'ไม่พบรายการนี้แล้ว')
  const day = today(ctx, who.couple)
  const updated = e.split_mode === m[2] ? e : ctx.repo.updateExpense(e.id, { mode: m[2] as SplitMode }, who.member.id, day)
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [expenseCard(updated, who.members, ctx.repo.ledger(who.couple.id, day).net, '✓ เปลี่ยนการหารแล้ว')])
}

export const handlers: Handlers = {
  text: onText,
  postback: onPostback,
  image: async (ctx, ev, who) => void (await onImage(ctx, ev, who)),
}
