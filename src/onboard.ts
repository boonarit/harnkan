import type { Ctx } from './app.ts'
import type { Couple, Member } from './db/repo.ts'
import type { Message } from './line/client.ts'
import { validateName } from './domain/name.js'

/**
 * display_name ที่ดูไม่เหมือนชื่อบนสลิป → ต้องใส่ "ชื่อบัญชีตามสลิป" ถึงจะจับการโอนระหว่างคู่ได้
 * เช่น มีคำเรียก (พี่/น้อง/ที่รัก…) · อีโมจิ · ตัวอังกฤษ/ตัวเลข/สัญลักษณ์ (ชื่อบนสลิปไทยส่วนใหญ่เป็นภาษาไทย)
 */
export function needsBankName(displayName: string) {
  const n = displayName.trim()
  return /^(พี่|น้อง|ที่รัก|คุณ|เฮีย|เจ๊|แม่|พ่อ)/.test(n) || /[^\u0E00-\u0E7F\s]/u.test(n)
}

export type Step = { label: string; state: 'done' | 'todo' | 'skip' | 'optional' }

/** สถานะเช็กลิสต์ของคู่ · complete = ขั้นบังคับครบ (พร้อมเพย์ไม่บังคับ) */
export function onboardStatus(members: Member[]) {
  const names = members.map((m) => m.display_name)
  const steps: Step[] = [{ label: `ลงทะเบียนครบ 2 คน (${members.length}/2) — พิมพ์อะไรก็ได้ในกลุ่ม`, state: members.length >= 2 ? 'done' : 'todo' }]
  for (const m of members) {
    const others = names.filter((x) => x !== m.display_name)
    steps.push({ label: `ชื่อของ ${m.display_name} — พิมพ์ "ตั้งชื่อ ส้ม" เพื่อเปลี่ยน`, state: validateName(m.display_name, others).ok ? 'done' : 'todo' })
    const bankSet = (JSON.parse(m.bank_names || '[]') as string[]).length > 0
    steps.push({ label: `${m.display_name}: ชื่อบัญชีตามสลิป + เลขท้ายบัญชี`, state: bankSet ? 'done' : needsBankName(m.display_name) ? 'todo' : 'skip' })
    steps.push({ label: `${m.display_name}: เบอร์พร้อมเพย์ (ใช้ทำ QR)`, state: m.promptpay_id ? 'done' : 'optional' })
  }
  return { steps, complete: steps.every((s) => s.state !== 'todo') }
}

const MARK = { done: '✓', todo: '○', skip: '✓ ไม่จำเป็น ·', optional: '· ไม่บังคับ ·' }

function settingsUrl(ctx: Ctx) {
  return ctx.cfg.liffId ? `https://liff.line.me/${ctx.cfg.liffId}/#/settings` : `${ctx.cfg.publicBaseUrl}/app/#/settings`
}

/** การ์ดเช็กลิสต์ตั้งค่า (ตอนบอทเข้ากลุ่ม · หลังลบข้อมูลทั้งหมด · คำสั่ง "ตั้งค่า" · เตือนวันละครั้ง) */
export function onboardCard(ctx: Ctx, members: Member[], title = 'ตั้งค่าหารกัน'): Message {
  const { steps, complete } = onboardStatus(members)
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
          ...steps.map((s) => ({ type: 'text', text: `${MARK[s.state]} ${s.label}`, size: 'sm', wrap: true, color: s.state === 'todo' ? '#24211D' : '#6B6459' })),
        ],
      },
      footer: {
        type: 'box', layout: 'vertical',
        contents: [{ type: 'button', style: 'primary', height: 'sm', color: '#2E7D4F', action: { type: 'uri', label: 'เปิดหน้าตั้งค่า', uri: settingsUrl(ctx) } }],
      },
    },
  }
}

/** reply สั้นหลังมีคนลงทะเบียน */
export function registeredText(m: Member, members: Member[]) {
  if (members.length < 2) return `ลงทะเบียน ${m.display_name} แล้ว ✓ รออีก 1 คน`
  const { complete } = onboardStatus(members)
  return `ลงทะเบียน ${m.display_name} แล้ว ✓ พร้อมใช้แล้ว ✨${complete ? '' : '\nยังมีขั้นตั้งค่าที่ควรทำ พิมพ์ "ตั้งค่า" ดูได้'}`
}

/** ต่อท้ายการ์ดรายการ: ถ้ายังตั้งค่าไม่ครบ ส่งการ์ดเช็กลิสต์ไม่เกินวันละครั้ง */
export function nudge(ctx: Ctx, couple: Couple, members: Member[], day: string): Message[] {
  if (onboardStatus(members).complete) return []
  return ctx.repo.markNudged(couple.id, day) ? [onboardCard(ctx, members, 'ยังตั้งค่าไม่ครบ')] : []
}
