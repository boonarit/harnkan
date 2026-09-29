import type { Ctx } from '../app.ts'
import type { Couple, Member } from '../db/repo.ts'
import { log } from '../log.ts'
import { onboardCard, registeredText } from '../onboard.ts'
import type { LineClient, Message } from './client.ts'

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
export async function resolveSender(ctx: Ctx, ev: LineEvent): Promise<{ couple: Couple; member: Member; members: Member[]; isNew?: boolean } | null> {
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
    let source = 'profile'
    const profile = await ctx.line.getGroupMemberProfile(groupId, userId).catch((e) => {
      log.warn('profile_fetch_failed', { couple: couple.id, message: (e as Error).message })
      source = 'fallback'
      return { displayName: 'ไม่ทราบชื่อ' }
    })
    // ตัดตาม code point (slice ของ string ผ่ากลางอีโมจิได้) · B18 สืบชื่อ "T": log แค่ความยาว ห้าม log ตัวชื่อ
    const raw = String(profile.displayName ?? '')
    const name = [...raw].slice(0, 40).join('') || 'ไม่ทราบชื่อ'
    member = ctx.repo.addMember(couple.id, userId, name)
    log.info('member_registered', { couple: couple.id, member: member.id, name_len: [...raw].length, source })
    return { couple, member, members: ctx.repo.members(couple.id), isNew: true }
  }
  return { couple, member, members: ctx.repo.members(couple.id) }
}

export type Handlers = {
  text?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
  image?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
  postback?: (ctx: Ctx, ev: LineEvent, who: NonNullable<Awaited<ReturnType<typeof resolveSender>>>) => Promise<void>
}

/**
 * reply token ใช้ได้ครั้งเดียว → ข้อความที่ต้องส่งเพิ่ม (เช่น "ลงทะเบียนแล้ว") ต่อหน้า reply แรกของ handler
 * ถ้า handler ไม่ตอบเลย flush ส่งเอง
 */
function prefixReplies(ctx: Ctx, first: Message[]) {
  let pending = first
  const line: LineClient = {
    reply: (t, m) => {
      const all = [...pending, ...m].slice(0, 5)
      pending = []
      return ctx.line.reply(t, all)
    },
    push: (to, m) => ctx.line.push(to, m),
    getContent: (id) => ctx.line.getContent(id),
    getGroupMemberProfile: (g, u) => ctx.line.getGroupMemberProfile(g, u),
  }
  return { ctx: { ...ctx, line }, flush: async (token?: string) => void (token && pending.length && (await ctx.line.reply(token, pending))) }
}

export async function handleEvent(ctx: Ctx, ev: LineEvent, h: Handlers = {}) {
  log.info('webhook_event', { type: ev.type, msg: ev.message?.type })
  if (ev.type === 'join' && ev.source?.type === 'group' && ev.source.groupId) {
    const couple = ctx.repo.createCouple(ev.source.groupId, ctx.cfg.minTransfer)
    if (ev.replyToken) await ctx.line.reply(ev.replyToken, [onboardCard(ctx, ctx.repo.members(couple.id), 'สวัสดี! หารกันพร้อมแล้ว ✨')])
    return
  }
  if (ev.type === 'leave' || ev.type === 'memberLeft') return
  if (ev.type !== 'message' && ev.type !== 'postback') return
  const who = await resolveSender(ctx, ev)
  if (!who) return
  const p = prefixReplies(ctx, who.isNew ? [{ type: 'text', text: registeredText(ctx.repo, who.member, who.members) }] : [])
  if (ev.type === 'postback') await h.postback?.(p.ctx, ev, who)
  else if (ev.message?.type === 'text') await h.text?.(p.ctx, ev, who)
  else if (ev.message?.type === 'image') await h.image?.(p.ctx, ev, who)
  await p.flush(ev.replyToken)
}
