import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Ctx } from './app.ts'
import type { Couple } from './db/repo.ts'
import { runBackup } from './jobs/backup.ts'
import type { Message } from './line/client.ts'
import { log } from './log.ts'
import { onboardCard } from './onboard.ts'

const TTL = 5 * 60_000
/** couple id → nonce + ขั้นที่ยืนยันแล้ว · ponytail: อยู่ในหน่วยความจำ รีสตาร์ทแล้วต้องเริ่มใหม่ (ปลอดภัยกว่าค้าง) */
const pending = new Map<number, { nonce: string; step: 1 | 2; expires: number }>()

const button = (label: string, data: string) => ({ type: 'action', action: { type: 'postback', label, data, displayText: label } })

/** ขั้น 0: คำสั่ง "ลบข้อมูลทั้งหมด" → ถามยืนยันครั้งที่ 1 */
export function startWipe(ctx: Ctx, couple: Couple) {
  const nonce = randomBytes(6).toString('base64url')
  pending.set(couple.id, { nonce, step: 1, expires: ctx.now() + TTL })
  return {
    type: 'text',
    text: '⚠️ จะลบข้อมูลทั้งหมดของกลุ่มนี้: รายการ สลิป รูป ยอด และประวัติ · กู้คืนไม่ได้\nต้องการลบจริงไหม? (ปุ่มหมดอายุใน 5 นาที)',
    quickReply: { items: [button('ใช่ ลบทั้งหมด', `wipe:1:${nonce}`), button('ยกเลิก', `wipe:no:${nonce}`)] },
  }
}

/** postback wipe:* · คืนข้อความตอบกลับ หรือ null ถ้าไม่ใช่ของเรา */
export function onWipePostback(ctx: Ctx, couple: Couple, memberId: number, data: string): Message[] | null {
  const r = wipeStep(ctx, couple, memberId, data)
  return r && (Array.isArray(r) ? r : [r])
}

function wipeStep(ctx: Ctx, couple: Couple, memberId: number, data: string): Message | Message[] | null {
  const m = data.match(/^wipe:(1|2|no):([\w-]{8})$/)
  if (!m) return null
  const p = pending.get(couple.id)
  if (!p || p.nonce !== m[2] || ctx.now() > p.expires) {
    pending.delete(couple.id)
    return { type: 'text', text: 'ปุ่มนี้หมดอายุแล้ว ถ้าต้องการลบ พิมพ์ "ลบข้อมูลทั้งหมด" ใหม่' }
  }
  if (m[1] === 'no') {
    pending.delete(couple.id)
    return { type: 'text', text: 'ยกเลิกแล้ว ข้อมูลยังอยู่ครบ 👍' }
  }
  if (m[1] === '1' && p.step === 1) {
    p.step = 2
    return {
      type: 'text',
      text: 'ยืนยันครั้งสุดท้าย: ลบข้อมูลของกลุ่มนี้ถาวร?',
      quickReply: { items: [button('ลบถาวร', `wipe:2:${p.nonce}`), button('ไม่ลบ', `wipe:no:${p.nonce}`)] },
    }
  }
  if (m[1] === '2' && p.step === 2) {
    pending.delete(couple.id)
    const r = wipeWithBackup(ctx, couple.id, memberId)
    if (!r.ok) return { type: 'text', text: 'สำรองข้อมูลไม่สำเร็จ จึงยังไม่ได้ลบอะไร 🙏 ลองใหม่ภายหลัง' }
    return wipedMessages(ctx)
  }
  return { type: 'text', text: 'ต้องกดยืนยันตามลำดับ พิมพ์ "ลบข้อมูลทั้งหมด" ใหม่' }
}

export function wipedMessages(ctx: Ctx): Message[] {
  return [
    { type: 'text', text: 'ลบข้อมูลทั้งหมดของกลุ่มนี้แล้ว 🗑️ ถ้าจะใช้ต่อ พิมพ์รายการได้เลย (เริ่มใหม่จากศูนย์)' },
    onboardCard(ctx, [], 'เริ่มใหม่: ตั้งค่าหารกัน'),
  ]
}

/** สำรอง DB (job backup เดิม) ต้องสำเร็จก่อน แล้วค่อยลบ · ใช้ทั้งคำสั่งแชทและปุ่มในแอป */
export function wipeWithBackup(ctx: Ctx, coupleId: number, memberId: number | null): { ok: true; file: string } | { ok: false } {
  let file: string
  try {
    file = runBackup(ctx.repo.db, ctx.cfg.backupDir, ctx.cfg.backupKeep, ctx.now()).file
  } catch (e) {
    log.error('wipe_backup_failed', { couple: coupleId, message: (e as Error).message })
    return { ok: false }
  }
  wipeCouple(ctx, coupleId, memberId)
  return { ok: true, file }
}

/** ลบ couple (cascade ทุกตาราง) + รูปสลิป + QR ของคู่นี้ */
export function wipeCouple(ctx: Ctx, coupleId: number, memberId: number | null) {
  const { repo, cfg } = ctx
  const qrTokens = repo.summariesBetween(coupleId, '0000-01-01', '9999-12-31').map((s) => s.qr_token).filter(Boolean) as string[]
  repo.deleteCouple(coupleId)
  rmSync(join(cfg.dataDir, 'slips', String(coupleId)), { recursive: true, force: true })
  for (const t of qrTokens) rmSync(join(cfg.dataDir, 'qr', `${t}.png`), { force: true })
  log.warn('couple_wiped', { couple: coupleId, member: memberId })
}
