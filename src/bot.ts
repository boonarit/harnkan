import type { Ctx } from './app.ts'
import type { Couple, Member } from './db/repo.ts'
import { formatBaht } from './domain/money.js'
import { validateName } from './domain/name.js'
import { parseMessage } from './domain/parse.js'
import { MODES, treatSplit } from './domain/split.js'
import type { SplitMode } from './domain/split.js'
import { appButton, appUrl, expenseCard, netText } from './line/flex.ts'
import type { Handlers, LineEvent } from './line/router.ts'
import { onAwaitingAmount, onImage, onSlipPostback } from './slip/flow.ts'
import { nudge, onboardCard } from './onboard.ts'
import { dupNote } from './dup.ts'
import { carrySummary } from './settle.ts'
import { onWipePostback, startWipe } from './wipe.ts'

type Who = { couple: Couple; member: Member; members: Member[] }

export const HELP = [
  'วิธีใช้หารกัน 🧾',
  '• พิมพ์ "กาแฟ 90" → หารครึ่ง',
  '• "ข้าวเย็น 420 เลี้ยง" → คนจ่ายเลี้ยง ไม่นับเข้ายอด',
  '• "ราดหน้า 120 บีเลี้ยง" → บีเลี้ยง (บีรับทั้งก้อนแม้คนอื่นจ่าย)',
  '• "ครีมกันแดดของบี 359" → ของอีกคนทั้งหมด',
  '• ส่งรูปสลิป/ใบเสร็จ → อ่านยอดให้',
  '• "สรุป" ดูยอดตอนนี้ · "ยกเลิก" ลบรายการล่าสุดของคุณ (รวมการโอน)',
  '• "ตั้งค่า" ดูเช็กลิสต์ตั้งค่า · "แอป" เปิดแอป',
  '• "ตั้งชื่อ ส้ม" เปลี่ยนชื่อที่บอทใช้เรียกคุณ',
  '• ทุกวันตามเวลาสรุป (ค่าเริ่ม 21:00 แก้ในแอป) สรุปยอดโอนเดียว + QR พร้อมเพย์',
].join('\n')

export async function replyText(ctx: Ctx, ev: LineEvent, text: string, extra: Record<string, unknown> = {}) {
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [{ type: 'text', text, ...extra }])
}

export const today = (ctx: Ctx, couple: Couple) => ctx.repo.dayOf(couple, ctx.now())

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
    if (intent.command === 'app') {
      const url = appUrl(ctx.cfg.liffId, '/')
      if (!url) return replyText(ctx, ev, 'แอปยังไม่พร้อมใช้ (ผู้ติดตั้งยังไม่ได้ตั้ง LIFF_ID)')
      if (ev.replyToken) await ctx.line.reply(ev.replyToken, [{ type: 'flex', altText: 'เปิดแอปหารกัน', contents: { type: 'bubble', size: 'kilo', body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: 'ดูรายการ ประวัติ เคลียร์ยอด และตั้งค่า', size: 'sm', wrap: true }, appButton(url, 'เปิดแอป')] } } }])
      return
    }
    if (intent.command === 'setup') return void (ev.replyToken && (await ctx.line.reply(ev.replyToken, [onboardCard(ctx, who.members)])))
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
      const last = repo.lastRecordBy(who.couple.id, who.member.id)
      if (!last) return replyText(ctx, ev, 'ยังไม่มีรายการของคุณให้ยกเลิก')
      let what: string
      if (last.entity === 'expense') {
        repo.deleteExpense(last.row.id, who.member.id, day)
        what = `${last.row.merchant} ${formatBaht(last.row.amount_satang)}`
      } else {
        repo.deleteSettlement(last.row.id, who.member.id, day)
        const name = (id: number) => who.members.find((m) => m.id === id)?.display_name ?? '?'
        what = `${last.row.kind === 'manual_close' ? 'ปิดยอด' : 'โอน'} ${name(last.row.from_member)} → ${name(last.row.to_member)} ${formatBaht(last.row.amount_satang)}`
      }
      return replyText(ctx, ev, `ลบ "${what}" แล้ว\nยอดตอนนี้: ${netText(repo.ledger(who.couple.id, day).net, who.members)}`)
    }
    if (ev.replyToken) await ctx.line.reply(ev.replyToken, [startWipe(ctx, who.couple)])
    return
  }

  if (await needPartner(ctx, ev, who)) return
  const treater = intent.treatName ? who.members.find((m) => m.display_name === intent.treatName) : undefined
  const { mode, treatedBy } = treater ? treatSplit(treater.id, who.member.id) : { mode: intent.mode ?? modeFor(intent.forName, who.member, who.members, who.couple.default_split), treatedBy: null }
  const e = repo.createExpense({
    coupleId: who.couple.id, paidBy: who.member.id, amount: intent.amount, merchant: intent.merchant.slice(0, 60),
    occurredAt: nowIso(ctx), day, mode, treatedBy, source: 'text', createdBy: who.member.id, createdAt: nowIso(ctx),
  })
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [expenseCard(e, who.members, repo.ledger(who.couple.id, day).net, undefined, appUrl(ctx.cfg.liffId, `/e/${e.id}`)), ...dupNote(ctx, who.couple, e), ...nudge(ctx, who.couple, who.members, day)])
}

async function onPostback(ctx: Ctx, ev: LineEvent, who: Who) {
  const data = ev.postback?.data ?? ''
  if (await onSlipPostback(ctx, ev, who, data)) return
  const wipe = onWipePostback(ctx, who.couple, who.member.id, data)
  if (wipe) return void (ev.replyToken && (await ctx.line.reply(ev.replyToken, wipe)))
  const carry = data.match(/^carry:(\d+)$/)
  if (carry) {
    const text = carrySummary(ctx, who.couple, Number(carry[1]), who.member.id)
    return text ? replyText(ctx, ev, text) : undefined
  }
  // split:<id>:<mode> · split:<id>:treat:<member id> = "<X>เลี้ยง" (การ์ดก่อน B19 ส่ง split:<id>:treat = คนจ่ายเลี้ยง)
  const m = data.match(/^split:(\d+):(\w+?)(?::(\d+))?$/)
  if (!m || !MODES.includes(m[2] as SplitMode) || (m[3] && m[2] !== 'treat')) return
  const e = ctx.repo.expense(Number(m[1]))
  if (!e || e.couple_id !== who.couple.id || e.status !== 'active') return replyText(ctx, ev, 'ไม่พบรายการนี้แล้ว')
  const treater = m[3] ? who.members.find((x) => x.id === Number(m[3])) : undefined
  if (m[3] && !treater) return
  const want = treater ? treatSplit(treater.id, e.paid_by) : { mode: m[2] as SplitMode, treatedBy: null }
  const day = today(ctx, who.couple)
  const same = e.split_mode === want.mode && (want.mode !== 'theirs' || e.treated_by === want.treatedBy)
  const updated = same ? e : ctx.repo.updateExpense(e.id, want, who.member.id, day)
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [expenseCard(updated, who.members, ctx.repo.ledger(who.couple.id, day).net, '✓ เปลี่ยนการหารแล้ว', appUrl(ctx.cfg.liffId, `/e/${updated.id}`))])
}

export const handlers: Handlers = {
  text: onText,
  postback: onPostback,
  image: async (ctx, ev, who) => void (await onImage(ctx, ev, who)),
}
