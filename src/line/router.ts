import type { Ctx } from '../app.ts'
import type { Couple, Member } from '../db/repo.ts'

export type LineEvent = {
  type: string
  replyToken?: string
  timestamp?: number
  source?: { type: 'group' | 'user' | 'room'; groupId?: string; userId?: string }
  message?: { id: string; type: string; text?: string }
  postback?: { data: string }
}

const notified = new Set<string>() // ponytail: คนที่ 3 ที่เตือนแล้ว (หน่วยความจำ) — รีสตาร์ทแล้วเตือนซ้ำได้ 1 ครั้ง ยอมรับได้

async function reply(ctx: Ctx, ev: LineEvent, text: string) {
  if (ev.replyToken) await ctx.line.reply(ev.replyToken, [{ type: 'text', text }])
}

/** หา couple ของกลุ่ม (สร้างถ้ายังไม่มี) + ลงทะเบียนสมาชิกคนที่ส่ง · คืน null ถ้าไม่ใช่กลุ่มหรือเป็นคนที่ 3 */
export async function resolveSender(ctx: Ctx, ev: LineEvent): Promise<{ couple: Couple; member: Member; members: Member[] } | null> {
  const groupId = ev.source?.groupId
  const userId = ev.source?.userId
  if (ev.source?.type !== 'group' || !groupId || !userId) return null
  const couple = ctx.repo.coupleByGroup(groupId) ?? ctx.repo.createCouple(groupId, ctx.cfg.minTransfer)
  let member = ctx.repo.memberByLineUser(couple.id, userId)
  if (!member) {
    if (ctx.repo.members(couple.id).length >= 2) {
      const key = `${couple.id}:${userId}`
      if (!notified.has(key)) {
        notified.add(key)
        await reply(ctx, ev, 'ขอโทษนะ หารกันรองรับ 2 คนต่อกลุ่ม 🙏 รายการของคุณจะไม่ถูกบันทึก')
      }
      return null
    }
    const profile = await ctx.line.getGroupMemberProfile(groupId, userId).catch(() => ({ displayName: 'ไม่ทราบชื่อ' }))
    member = ctx.repo.addMember(couple.id, userId, profile.displayName.slice(0, 40))
  }
  return { couple, member, members: ctx.repo.members(couple.id) }
}

export type Handlers = {
  text?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
  image?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
  postback?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
}

export async function handleEvent(ctx: Ctx, ev: LineEvent, h: Handlers = {}) {
  if (ev.type === 'join' && ev.source?.type === 'group' && ev.source.groupId) {
    ctx.repo.createCouple(ev.source.groupId, ctx.cfg.minTransfer)
    await reply(ctx, ev, 'สวัสดี! หารกันพร้อมแล้ว ✨\nพิมพ์ "กาแฟ 90" หรือส่งรูปสลิป แล้วบอทจะหารครึ่งให้\n21:00 สรุปยอดโอนเดียว · พิมพ์ "ช่วยด้วย" ดูวิธีใช้')
    return
  }
  if (ev.type === 'leave' || ev.type === 'memberLeft') return
  if (ev.type !== 'message' && ev.type !== 'postback') return
  const who = await resolveSender(ctx, ev)
  if (!who) return
  if (ev.type === 'postback') return h.postback?.(ctx, ev, who)
  if (ev.message?.type === 'text') return h.text?.(ctx, ev, who)
  if (ev.message?.type === 'image') return h.image?.(ctx, ev, who)
}
