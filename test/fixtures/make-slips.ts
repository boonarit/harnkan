// สร้าง fixture สลิปสังเคราะห์ + ผล AI ปลอม (sidecar .json) → test/fixtures/synthetic/
// รัน: npm run fixtures
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { slipVerify } from 'promptparse/generate'
import { makeSlipPng } from './make-slip.ts'

export const SYNTHETIC_DIR = join(import.meta.dirname, 'synthetic')

type Ai = {
  type: 'transfer_slip' | 'receipt' | 'other'; amount: number | null; datetime: string | null; sender_name: string | null
  receiver_name: string | null; merchant: string | null; items: string[]; category: string | null; confidence: number
}
export const SLIPS: Record<string, { title: string; lines: string[]; qr: { bank: string; ref: string } | null; ai: Ai }> = {
  'slip-coffee': {
    title: 'FAKE BANK', lines: ['Transfer successful', '90.00 THB', 'From: A (fake)', 'To: Cafe (fake)', '29 Sep 2026 08:10'],
    qr: { bank: '002', ref: 'FAKECOFFEE0001' },
    ai: { type: 'transfer_slip', amount: 90, datetime: '2026-09-29T08:10:00+07:00', sender_name: 'เอ (สมมติ)', receiver_name: 'ร้านกาแฟสมมติ', merchant: 'กาแฟ', items: ['ลาเต้', 'อเมริกาโน่'], category: 'อาหาร', confidence: 0.96 },
  },
  'slip-7eleven': {
    title: 'FAKE BANK', lines: ['Transfer successful', '127.00 THB', 'From: A (fake)', 'To: 7-Eleven (fake)', '29 Sep 2026 18:45'],
    qr: { bank: '004', ref: 'FAKE7ELEVEN0001' },
    ai: { type: 'transfer_slip', amount: 127, datetime: '2026-09-29T18:45:00+07:00', sender_name: 'เอ (สมมติ)', receiver_name: '7-Eleven สาขาสมมติ', merchant: '7-Eleven', items: [], category: 'ของใช้', confidence: 0.95 },
  },
  'slip-sunscreen': {
    title: 'FAKE SHOP', lines: ['RECEIPT', 'Sunscreen SPF50  359.00', 'TOTAL 359.00', '29 Sep 2026 19:10'],
    qr: null,
    ai: { type: 'receipt', amount: 359, datetime: '2026-09-29T19:10:00+07:00', sender_name: null, receiver_name: null, merchant: 'ครีมกันแดด', items: ['ครีมกันแดด SPF50'], category: 'ของใช้ส่วนตัว', confidence: 0.92 },
  },
  'slip-settle': {
    title: 'FAKE BANK', lines: ['Transfer successful', '347.50 THB', 'From: B (fake)', 'To: A (fake)', '29 Sep 2026 21:05'],
    qr: { bank: '014', ref: 'FAKESETTLE0001' },
    ai: { type: 'transfer_slip', amount: 347.5, datetime: '2026-09-29T21:05:00+07:00', sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.', merchant: null, items: [], category: null, confidence: 0.97 },
  },
  'slip-blurry': {
    title: 'FAKE SHOP', lines: ['R E C E I P T', '?? 85.00 ??'],
    qr: null,
    ai: { type: 'receipt', amount: 85, datetime: null, sender_name: null, receiver_name: null, merchant: 'ร้านน้ำ', items: [], category: 'อาหาร', confidence: 0.55 },
  },
}

export async function makeAll(dir = SYNTHETIC_DIR) {
  for (const [name, s] of Object.entries(SLIPS)) {
    const qr = s.qr ? slipVerify({ sendingBank: s.qr.bank, transRef: s.qr.ref }) : null
    writeFileSync(join(dir, `${name}.png`), await makeSlipPng({ title: s.title, lines: s.lines, qr }))
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(s.ai, null, 2) + '\n')
  }
}

if (process.argv[1]?.endsWith('make-slips.ts')) {
  await makeAll()
  console.log(`เขียน ${Object.keys(SLIPS).length} สลิปที่ ${SYNTHETIC_DIR}`)
}
