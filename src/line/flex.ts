import type { Expense, Member } from '../db/repo.ts'
import type { Message } from './client.ts'
import { formatBaht } from '../domain/money.js'
import { clip } from '../domain/name.js'
import { effect, modeLabel } from '../domain/split.js'

/** ลิงก์เปิด mini app ผ่าน LIFF (path เป็น hash route เช่น "/settings") · ไม่มี LIFF_ID = null → ไม่แสดงปุ่ม */
export function appUrl(liffId: string, path = '/'): string | null {
  return liffId ? `https://liff.line.me/${encodeURIComponent(liffId)}/#${path}` : null
}
export const appButton = (uri: string, label = 'ดู/แก้ในแอป') => ({ type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label, uri } })

export { modeLabel }

/** ยอดสุทธิ → ประโยค "บี โอนให้ เอ ฿347.50" */
export function netText(net: number, members: Member[]) {
  if (net === 0) return 'ไม่มีใครติดใคร'
  const [from, to] = net > 0 ? [members[1], members[0]] : [members[0], members[1]]
  return `${from.display_name} โอนให้ ${to.display_name} ${formatBaht(Math.abs(net))}`
}

const row = (label: string, value: string, bold = false) => ({
  type: 'box', layout: 'horizontal',
  contents: [
    { type: 'text', text: label, size: 'sm', color: '#6B6459', flex: 2 },
    { type: 'text', text: value, size: 'sm', color: '#24211D', flex: 5, wrap: true, weight: bold ? 'bold' : 'regular' },
  ],
})

export const QUICK_LABEL_MAX = 20 // ขีดจำกัด label ของ LINE quick reply
/** ป้ายปุ่ม = ข้อความนำ + ชื่อ + ข้อความท้าย ไม่เกิน 20 ตัว · ชื่อยาวถูกตัดตาม code point (ไม่ผ่ากลางอีโมจิ) ข้อความท้ายยังอยู่ */
export function quickLabel(pre: string, name: string, post = '') {
  return pre + clip(name, QUICK_LABEL_MAX - [...pre].length - [...post].length, '…') + post
}

/**
 * quick reply 5 ปุ่ม: หารครึ่ง · ของ<A> · ของ<B> · <A>เลี้ยง · <B>เลี้ยง
 * ปุ่มเลี้ยงอ้าง member id (ไม่ใช่ชื่อ) → การ์ดเก่ายังกดได้ถูกคนแม้เปลี่ยนชื่อแล้ว
 */
export function splitQuickReply(e: Pick<Expense, 'id' | 'payer'>, members: Member[]) {
  const forSlot = (slot: number) => (slot === e.payer ? 'mine' : 'theirs')
  const items: [string, string, string][] = [
    ['หารครึ่ง', 'หารครึ่ง', 'half'],
    ...members.map((m, i): [string, string, string] => [quickLabel('ของ', m.display_name), `ของ${m.display_name}`, forSlot(i)]),
    ...members.map((m): [string, string, string] => [quickLabel('', m.display_name, 'เลี้ยง'), `${m.display_name}เลี้ยง`, `treat:${m.id}`]),
  ]
  return {
    items: items.map(([label, full, mode]) => ({
      type: 'action',
      action: { type: 'postback', label, data: `split:${e.id}:${mode}`, displayText: full },
    })),
  }
}

/** appLink: ลิงก์ LIFF ของรายการนี้ (null = ไม่มี LIFF_ID → ไม่มีปุ่ม) */
export function expenseCard(e: Expense, members: Member[], netNow: number, title = '✓ บันทึกแล้ว', appLink: string | null = null): Message {
  const eff = effect(e.payer, e.shares)
  const effText = eff === 0 ? 'ไม่นับเข้ายอด' : `${eff > 0 ? members[1].display_name : members[0].display_name} ค้าง ${eff > 0 ? members[0].display_name : members[1].display_name} ${formatBaht(Math.abs(eff))}`
  return {
    type: 'flex',
    altText: `${title} ${e.merchant} ${formatBaht(e.amount_satang)}`,
    contents: {
      type: 'bubble', size: 'kilo',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: title, weight: 'bold', color: '#2E7D4F', size: 'sm' },
          { type: 'box', layout: 'horizontal', contents: [
            { type: 'text', text: e.merchant, weight: 'bold', size: 'lg', flex: 3, wrap: true },
            { type: 'text', text: formatBaht(e.amount_satang), weight: 'bold', size: 'lg', align: 'end', flex: 2 },
          ] },
          { type: 'separator', margin: 'md' },
          row('จ่ายโดย', members[e.payer].display_name),
          row('หาร', modeLabel(e, members)),
          row('ผลต่อยอด', effText),
          row('ยอดตอนนี้', netText(netNow, members), true),
        ],
      },
      ...(appLink ? { footer: { type: 'box', layout: 'vertical', contents: [appButton(appLink)] } } : {}),
    },
    quickReply: splitQuickReply(e, members),
  }
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
export function thaiDate(date: string) {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${TH_MONTHS[m - 1]}`
}

/** การ์ดสรุปตามเวลาสรุปของคู่: ยอดเดียว · ใครโอนให้ใคร · จำนวนบิล · QR · ปุ่มทบไปพรุ่งนี้ · title บอกวันที่เสมอ (summaryTitle) */
export function summaryCard(opts: {
  summaryId: number; title: string; amount: number; from: Member; to: Member; bills: number; carriedIn: number; qrUrl: string | null
  appLink?: string | null
}): Message {
  const { from, to } = opts
  const body: Record<string, unknown>[] = [
    { type: 'text', text: opts.title, size: 'sm', color: '#B8B0A3' },
    { type: 'text', text: formatBaht(opts.amount), size: '3xl', weight: 'bold', color: '#FFFFFF' },
    { type: 'text', text: `${from.display_name} โอนให้ ${to.display_name}`, size: 'md', color: '#FFFFFF', weight: 'bold' },
    { type: 'text', text: `จาก ${opts.bills} รายการ${opts.carriedIn ? ` · ยอดยกมา ${formatBaht(opts.carriedIn)}` : ''}`, size: 'sm', color: '#B8B0A3', wrap: true },
  ]
  const account = !opts.qrUrl && to.bank_account ? to.bank_account : null
  if (account) body.push({ type: 'text', text: `โอนเข้า ${to.bank_name ?? 'บัญชี'} ${account}`, size: 'md', color: '#FFFFFF', wrap: true })
  else if (!opts.qrUrl) body.push({ type: 'text', text: `${to.display_name} ยังไม่ได้ตั้งเบอร์พร้อมเพย์หรือเลขบัญชีในแอป`, size: 'xs', color: '#F2B28C', wrap: true })
  return {
    type: 'flex',
    altText: `${opts.title}: ${from.display_name} โอนให้ ${to.display_name} ${formatBaht(opts.amount)}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: '#24211D', contents: body },
      ...(opts.qrUrl ? { hero: { type: 'image', url: opts.qrUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' } } : {}),
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'โอนแล้วส่งสลิปในกลุ่มนี้ บอทจะปิดยอดให้', size: 'xs', color: '#6B6459', wrap: true, align: 'center' },
          ...(account ? [{ type: 'button', style: 'primary', height: 'sm', action: { type: 'clipboard', label: 'คัดลอกเลขบัญชี', clipboardText: account } }] : []),
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: 'ทบไปพรุ่งนี้', data: `carry:${opts.summaryId}`, displayText: 'ทบไปพรุ่งนี้' } },
          ...(opts.appLink ? [appButton(opts.appLink)] : []),
        ],
      },
    },
  }
}
