import { createHash } from 'node:crypto'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { Jimp } from 'jimp'

export type SlipAi = {
  type: 'transfer_slip' | 'receipt' | 'other'
  amount: number | null
  datetime: string | null
  sender_name: string | null
  receiver_name: string | null
  merchant: string | null
  items: string[]
  category: string | null
  confidence: number
}

export interface SlipReader {
  read(image: Buffer): Promise<SlipAi>
}

const nullable = (type: string) => ({ type: [type, 'null'] })
export const SLIP_TOOL = {
  name: 'record_slip',
  description: 'บันทึกข้อมูลที่อ่านได้จากรูปสลิปโอนเงินหรือใบเสร็จ',
  input_schema: {
    type: 'object' as const,
    properties: {
      type: { type: 'string', enum: ['transfer_slip', 'receipt', 'other'], description: 'transfer_slip = สลิปโอนเงินจากแอปธนาคาร, receipt = ใบเสร็จร้าน, other = รูปอื่นที่ไม่ใช่ทั้งสองอย่าง' },
      amount: { ...nullable('number'), description: 'ยอดเงินรวมเป็นบาท เช่น 347.5 · อ่านไม่ได้ให้เป็น null' },
      datetime: { ...nullable('string'), description: 'วันเวลาบนสลิป ISO 8601 เวลาไทย (+07:00)' },
      sender_name: { ...nullable('string'), description: 'ชื่อผู้โอนตามที่เห็นบนสลิป' },
      receiver_name: { ...nullable('string'), description: 'ชื่อผู้รับ/ร้านตามที่เห็นบนสลิป' },
      merchant: { ...nullable('string'), description: 'ชื่อสั้นๆ ของรายการ/ร้าน ภาษาไทยถ้าได้ เช่น "กาแฟ" "7-Eleven"' },
      items: { type: 'array', items: { type: 'string' }, description: 'รายการสินค้า (ถ้ามี)' },
      category: { ...nullable('string'), description: 'หมวด เช่น อาหาร เดินทาง ของใช้' },
      confidence: { type: 'number', description: 'ความมั่นใจว่ายอดเงินถูกต้อง 0–1' },
    },
    required: ['type', 'amount', 'datetime', 'sender_name', 'receiver_name', 'merchant', 'items', 'category', 'confidence'],
  },
}

const MAX_SIDE = 1568

/** อ่านสลิปด้วย Claude (บังคับผลเป็น JSON ผ่าน tool) */
export class ClaudeSlipReader implements SlipReader {
  client: Anthropic
  model: string
  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 })
    this.model = model
  }
  async read(image: Buffer): Promise<SlipAi> {
    const img = await Jimp.read(image)
    if (Math.max(img.width, img.height) > MAX_SIDE) img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE })
    const data = (await img.getBuffer('image/jpeg', { quality: 85 })).toString('base64')
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      tools: [SLIP_TOOL],
      tool_choice: { type: 'tool', name: SLIP_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: 'อ่านรูปนี้ (สลิปโอนเงินหรือใบเสร็จในไทย) แล้วบันทึกด้วย record_slip · ถ้าไม่ใช่สลิป/ใบเสร็จให้ type=other · อย่าเดายอดที่มองไม่เห็น' },
        ],
      }],
    })
    const block = res.content.find((b) => b.type === 'tool_use')
    if (!block || block.type !== 'tool_use') throw new Error(`AI ไม่ตอบผ่าน tool (stop_reason=${res.stop_reason})`)
    return normalize(block.input as Partial<SlipAi>)
  }
}

export function normalize(x: Partial<SlipAi>): SlipAi {
  const amount = typeof x.amount === 'number' && Number.isFinite(x.amount) && x.amount > 0 ? x.amount : null
  return {
    type: x.type === 'transfer_slip' || x.type === 'receipt' ? x.type : 'other',
    amount,
    datetime: x.datetime ?? null,
    sender_name: x.sender_name ?? null,
    receiver_name: x.receiver_name ?? null,
    merchant: x.merchant ?? null,
    items: Array.isArray(x.items) ? x.items.map(String).slice(0, 30) : [],
    category: x.category ?? null,
    confidence: typeof x.confidence === 'number' ? Math.min(1, Math.max(0, x.confidence)) : 0,
  }
}

const sha = (b: Buffer) => createHash('sha256').update(b).digest('base64url')

/** ผลเตรียมไว้: รูปที่ตรงกับ <name>.png ใน dir → อ่าน <name>.json · ไม่ตรง → type=other */
export class FakeSlipReader implements SlipReader {
  byHash = new Map<string, SlipAi>()
  calls = 0
  constructor(dir = join(import.meta.dirname, '../../test/fixtures/synthetic')) {
    for (const f of readdirSync(dir).filter((f) => f.endsWith('.png'))) {
      try {
        this.byHash.set(sha(readFileSync(join(dir, f))), normalize(JSON.parse(readFileSync(join(dir, f.replace(/\.png$/, '.json')), 'utf8'))))
      } catch {
        // ไม่มี sidecar → ข้าม
      }
    }
  }
  async read(image: Buffer): Promise<SlipAi> {
    this.calls++
    return this.byHash.get(sha(image)) ?? normalize({ type: 'other', confidence: 0.9 })
  }
}
