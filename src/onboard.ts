import type { Ctx } from './app.ts'
import type { Couple, Member, Repo } from './db/repo.ts'
import { appButton, appUrl } from './line/flex.ts'
import type { Message } from './line/client.ts'
import { validateName } from './domain/name.js'

export type Step = { label: string; state: 'done' | 'warn' | 'optional' }

/**
 * สถานะเช็กลิสต์ของคู่ · complete = ไม่มีข้อ ⚠️ (พร้อมเพย์ไม่บังคับ)
 * ชื่อบัญชีตามสลิป: ว่าง = ⚠️ เสมอ (ชื่อเล่นไทยล้วนก็มักไม่ตรงสลิป — เดาจากตัวชื่อไม่พอ, เจอจริงหลัง B17)
 * ยกเว้นเคยมีสลิปโอนระหว่างคู่ที่จับชื่อคนนี้ได้ตรงแล้ว
 */
export function onboardStatus(repo: Repo, members: Member[]) {
  const names = members.map((m) => m.display_name)
  const steps: Step[] = [{ label: `ลงทะเบียนครบ 2 คน (${members.length}/2) — พิมพ์อะไรก็ได้ในกลุ่ม`, state: members.length >= 2 ? 'done' : 'warn' }]
  for (const m of members) {
    const others = names.filter((x) => x !== m.display_name)
    steps.push({ label: `ชื่อ "${m.display_name}" — เปลี่ยนได้: พิมพ์ ตั้งชื่อ <ชื่อเล่น>`, state: validateName(m.display_name, others).ok ? 'done' : 'warn' })
    const bankSet = (JSON.parse(m.bank_names || '[]') as string[]).length > 0 || repo.partnerSlipMatched(m.id)
    steps.push({ label: `${m.display_name}: ใส่ชื่อต้นตามสลิป + เลขท้ายบัญชี (ในแอป)`, state: bankSet ? 'done' : 'warn' })
    steps.push({ label: `${m.display_name}: เบอร์พร้อมเพย์ ไม่บังคับ (ใช้ทำ QR)`, state: m.promptpay_id ? 'done' : 'optional' })
  }
  if (members.length < 2) {
    steps.push({ label: `${members.length ? 'อีกคน' : 'ทั้งสองคน'}: ใส่ชื่อต้นตามสลิป + เลขท้ายบัญชี (ในแอป)`, state: 'warn' })
    steps.push({ label: `${members.length ? 'อีกคน' : 'ทั้งสองคน'}: เบอร์พร้อมเพย์ ไม่บังคับ`, state: 'optional' })
  }
  return { steps, complete: steps.every((s) => s.state !== 'warn') }
}

export const MARK = { done: '✓', warn: '⚠️', optional: '○' }

/** การ์ดเช็กลิสต์ตั้งค่า (ตอนบอทเข้ากลุ่ม · หลังลบข้อมูลทั้งหมด · คำสั่ง "ตั้งค่า" · เตือนวันละครั้ง) */
export function onboardCard(ctx: Ctx, members: Member[], title = 'ตั้งค่าหารกัน'): Message {
  const { steps, complete } = onboardStatus(ctx.repo, members)
  const url = appUrl(ctx.cfg.liffId, '/settings')
  return {
    type: 'flex',
    altText: `${title}: ${complete ? 'พร้อมใช้แล้ว ✨' : 'ยังตั้งค่าไม่ครบ'}`,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: title, weight: 'bold', size: 'md' },
          { type: 'text', text: 'พิมพ์ "กาแฟ 90" หรือส่งรูปสลิป แล้วบอทจะหารครึ่งให้ · ครบ 2 คนก็ใช้ได้ทันที', size: 'xs', color: '#6B6459', wrap: true },
          { type: 'separator', margin: 'md' },
          ...steps.map((s) => ({ type: 'text', text: `${MARK[s.state]} ${s.label}`, size: 'sm', wrap: true, color: s.state === 'warn' ? '#B3261E' : s.state === 'done' ? '#2E7D4F' : '#6B6459' })),
          { type: 'text', text: '✓ ตั้งแล้ว · ⚠️ ควรตั้ง · ○ ไม่บังคับ', size: 'xxs', color: '#6B6459', margin: 'md' },
        ],
      },
      ...(url ? { footer: { type: 'box', layout: 'vertical', contents: [appButton(url, 'เปิดหน้าตั้งค่า')] } } : {}),
    },
  }
}

/** reply สั้นหลังมีคนลงทะเบียน */
export function registeredText(repo: Repo, m: Member, members: Member[]) {
  if (members.length < 2) return `ลงทะเบียน ${m.display_name} แล้ว ✓ รออีก 1 คน`
  const { complete } = onboardStatus(repo, members)
  return `ลงทะเบียน ${m.display_name} แล้ว ✓ พร้อมใช้แล้ว ✨${complete ? '' : '\nยังมีขั้นตั้งค่าที่ควรทำ พิมพ์ "ตั้งค่า" ดูได้'}`
}

/** ต่อท้ายการ์ดรายการ: ถ้ายังตั้งค่าไม่ครบ ส่งการ์ดเช็กลิสต์ไม่เกินวันละครั้ง */
export function nudge(ctx: Ctx, couple: Couple, members: Member[], day: string): Message[] {
  if (onboardStatus(ctx.repo, members).complete) return []
  return ctx.repo.markNudged(couple.id, day) ? [onboardCard(ctx, members, 'ยังตั้งค่าไม่ครบ')] : []
}
