import type { Expense, Member } from '../db/repo.ts'
import type { Message } from './client.ts'
import { formatBaht } from '../domain/money.js'
import { effect } from '../domain/split.js'

export function modeLabel(e: Pick<Expense, 'split_mode' | 'ratio' | 'payer'>, members: Member[]) {
  const payer = members[e.payer]?.display_name ?? '?'
  const other = members[1 - e.payer]?.display_name ?? '?'
  switch (e.split_mode) {
    case 'half': return 'หารครึ่ง'
    case 'mine': return `ของ${payer}`
    case 'theirs': return `ของ${other}`
    case 'treat': return `${payer}เลี้ยง`
    case 'ratio': return `${payer} ${e.ratio}% / ${other} ${100 - (e.ratio ?? 50)}%`
  }
}

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

/** quick reply 4 ปุ่ม: หารครึ่ง · ของ<A> · ของ<B> · เลี้ยง */
export function splitQuickReply(e: Pick<Expense, 'id' | 'payer'>, members: Member[]) {
  const forSlot = (slot: number) => (slot === e.payer ? 'mine' : 'theirs')
  const items: [string, string][] = [
    ['หารครึ่ง', 'half'],
    [`ของ${members[0].display_name}`, forSlot(0)],
    [`ของ${members[1].display_name}`, forSlot(1)],
    ['เลี้ยง', 'treat'],
  ]
  return {
    items: items.map(([label, mode]) => ({
      type: 'action',
      action: { type: 'postback', label: label.slice(0, 20), data: `split:${e.id}:${mode}`, displayText: label },
    })),
  }
}

export function expenseCard(e: Expense, members: Member[], netNow: number, title = '✓ บันทึกแล้ว'): Message {
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
    },
    quickReply: splitQuickReply(e, members),
  }
}

const TH_MONTHS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.']
export function thaiDate(date: string) {
  const [, m, d] = date.split('-').map(Number)
  return `${d} ${TH_MONTHS[m - 1]}`
}

/** การ์ดสรุป 21:00: ยอดเดียว · ใครโอนให้ใคร · จำนวนบิล · QR · ปุ่มทบไปพรุ่งนี้ */
export function summaryCard(opts: {
  summaryId: number; date: string; amount: number; from: Member; to: Member; bills: number; carriedIn: number; qrUrl: string | null
}): Message {
  const { from, to } = opts
  const body: Record<string, unknown>[] = [
    { type: 'text', text: `สรุปยอด ${thaiDate(opts.date)}`, size: 'sm', color: '#B8B0A3' },
    { type: 'text', text: formatBaht(opts.amount), size: '3xl', weight: 'bold', color: '#FFFFFF' },
    { type: 'text', text: `${from.display_name} โอนให้ ${to.display_name}`, size: 'md', color: '#FFFFFF', weight: 'bold' },
    { type: 'text', text: `จาก ${opts.bills} รายการวันนี้${opts.carriedIn ? ` · ยอดยกมา ${formatBaht(opts.carriedIn)}` : ''}`, size: 'sm', color: '#B8B0A3', wrap: true },
  ]
  if (!opts.qrUrl) body.push({ type: 'text', text: `${to.display_name} ยังไม่ได้ตั้งเบอร์พร้อมเพย์ในแอป`, size: 'xs', color: '#F2B28C', wrap: true })
  return {
    type: 'flex',
    altText: `สรุปยอด ${thaiDate(opts.date)}: ${from.display_name} โอนให้ ${to.display_name} ${formatBaht(opts.amount)}`,
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', spacing: 'sm', backgroundColor: '#24211D', contents: body },
      ...(opts.qrUrl ? { hero: { type: 'image', url: opts.qrUrl, size: 'full', aspectRatio: '1:1', aspectMode: 'fit' } } : {}),
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'โอนแล้วส่งสลิปในกลุ่มนี้ บอทจะปิดยอดให้', size: 'xs', color: '#6B6459', wrap: true, align: 'center' },
          { type: 'button', style: 'secondary', height: 'sm', action: { type: 'postback', label: 'ทบไปพรุ่งนี้', data: `carry:${opts.summaryId}`, displayText: 'ทบไปพรุ่งนี้' } },
        ],
      },
    },
  }
}
