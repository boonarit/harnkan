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
  /** เลขท้ายบัญชี 4 หลัก (normalize ตัดจากเลขแบบปิดบัง "xxx-xxx-1234") — เก็บแค่นี้ ห้าม log */
  sender_account: string | null
  receiver_account: string | null
  receiver_kind: 'person' | 'shop' | 'topup' | null
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
      datetime: { ...nullable('string'), description: 'วันเวลาบนสลิป ISO 8601 ปี ค.ศ. เวลาไทย (+07:00) · สลิปไทยมักพิมพ์ปี พ.ศ. ให้ลบ 543 · ไม่เห็นวันที่ให้เป็น null' },
      sender_name: { ...nullable('string'), description: 'ชื่อผู้โอนตามที่เห็นบนสลิป' },
      receiver_name: { ...nullable('string'), description: 'ชื่อผู้รับ/ร้านตามที่เห็นบนสลิป' },
      sender_account: { ...nullable('string'), description: 'เลขบัญชี/พร้อมเพย์ของผู้โอนแบบปิดบังตามที่เห็น เช่น "xxx-xxx-1234"' },
      receiver_account: { ...nullable('string'), description: 'เลขบัญชี/พร้อมเพย์ของผู้รับแบบปิดบังตามที่เห็น เช่น "xxx-x-x5678-x"' },
      receiver_kind: { type: ['string', 'null'], enum: ['person', 'shop', 'topup', null], description: 'person = โอนให้บุคคล, shop = จ่ายร้าน/บริษัท/ผ่าน payment gateway, topup = เติมเงินเข้า e-wallet หรือบัญชีของผู้โอนเอง (ผู้รับคือผู้โอนเองหรือบริษัท wallet) · จ่ายร้าน/คนอื่นผ่านพร้อมเพย์ e-Wallet ไม่ใช่ topup' },
      merchant: { ...nullable('string'), description: 'ชื่อสั้นๆ ของรายการ/ร้าน ภาษาไทยถ้าได้ เช่น "กาแฟ" "7-Eleven"' },
      items: { type: 'array', items: { type: 'string' }, description: 'รายการสินค้า (ถ้ามี)' },
      category: { ...nullable('string'), description: 'หมวด เช่น อาหาร เดินทาง ของใช้' },
      confidence: { type: 'number', description: 'ความมั่นใจว่ายอดเงินถูกต้อง 0–1' },
    },
    required: ['type', 'amount', 'datetime', 'sender_name', 'receiver_name', 'sender_account', 'receiver_account', 'receiver_kind', 'merchant', 'items', 'category', 'confidence'],
  },
}

const MAX_SIDE = 1568
const PROMPT = 'อ่านรูปนี้ (สลิปโอนเงินหรือใบเสร็จในไทย) แล้วบันทึกด้วย record_slip · ถ้าไม่ใช่สลิป/ใบเสร็จให้ type=other · อย่าเดายอดที่มองไม่เห็น'

/** ย่อด้านยาวไม่เกิน 1568px → JPEG base64 (ใช้ร่วม Claude/Gemini) */
async function toJpegBase64(image: Buffer) {
  const img = await Jimp.read(image)
  if (Math.max(img.width, img.height) > MAX_SIDE) img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE })
  return (await img.getBuffer('image/jpeg', { quality: 85 })).toString('base64')
}

/** อ่านสลิปด้วย Claude (บังคับผลเป็น JSON ผ่าน tool) */
export class ClaudeSlipReader implements SlipReader {
  client: Anthropic
  model: string
  constructor(apiKey: string, model: string) {
    this.client = new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 })
    this.model = model
  }
  async read(image: Buffer): Promise<SlipAi> {
    const data = await toJpegBase64(image)
    const res = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      tools: [SLIP_TOOL],
      tool_choice: { type: 'tool', name: SLIP_TOOL.name },
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } },
          { type: 'text', text: PROMPT },
        ],
      }],
    })
    const block = res.content.find((b) => b.type === 'tool_use')
    if (!block || block.type !== 'tool_use') throw new Error(`AI ไม่ตอบผ่าน tool (stop_reason=${res.stop_reason})`)
    return normalize(block.input as Partial<SlipAi>)
  }
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; items?: JsonSchema; required?: string[]; enum?: (string | null)[]; description?: string }

/** JSON Schema ของ SLIP_TOOL → responseSchema ของ Gemini (OpenAPI subset: TYPE ตัวใหญ่, nullable) · สร้างจากแหล่งเดียวกัน field จึงตรงกันเสมอ */
export function geminiSchema(s: JsonSchema): Record<string, unknown> {
  const types = Array.isArray(s.type) ? s.type : s.type ? [s.type] : []
  const main = types.find((t) => t !== 'null')
  const out: Record<string, unknown> = {}
  if (main) out.type = main.toUpperCase()
  if (types.includes('null')) out.nullable = true
  if (s.enum) out.enum = s.enum.filter((x) => x !== null) // Gemini รับ enum เป็น string ล้วน · null บอกด้วย nullable แล้ว
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]))
  if (s.items) out.items = geminiSchema(s.items)
  if (s.required) out.required = s.required
  if (s.description) out.description = s.description
  return out
}

const GEMINI_API = 'https://generativelanguage.googleapis.com/v1beta/models'

/** อ่านสลิปด้วย Gemini ผ่าน REST (fetch ตรง ไม่มี SDK) · key ส่งทาง header x-goog-api-key เท่านั้น ไม่อยู่ใน URL */
export class GeminiSlipReader implements SlipReader {
  apiKey: string
  model: string
  fetch: typeof fetch
  constructor(apiKey: string, model: string, fetchFn: typeof fetch = globalThis.fetch) {
    if (!model) throw new Error('ต้องตั้ง SLIP_MODEL สำหรับ Gemini')
    this.apiKey = apiKey
    this.model = model
    this.fetch = fetchFn
  }
  /** กัน key หลุดไปกับข้อความ error (บาง error ของ API สะท้อน request กลับมา) */
  private scrub(s: string) {
    return this.apiKey ? s.split(this.apiKey).join('[redacted]') : s
  }
  async read(image: Buffer): Promise<SlipAi> {
    const data = await toJpegBase64(image)
    const res = await this.fetch(`${GEMINI_API}/${encodeURIComponent(this.model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ inline_data: { mime_type: 'image/jpeg', data } }, { text: PROMPT.replace('ด้วย record_slip', 'เป็น JSON ตาม schema') }] }],
        generationConfig: { responseMimeType: 'application/json', responseSchema: geminiSchema(SLIP_TOOL.input_schema), temperature: 0 },
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const raw = await res.text()
    if (!res.ok) throw new Error(this.scrub(`Gemini HTTP ${res.status}: ${raw.slice(0, 200)}`))
    let j: { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[]; promptFeedback?: { blockReason?: string } }
    try {
      j = JSON.parse(raw)
    } catch {
      throw new Error('Gemini ตอบไม่ใช่ JSON')
    }
    if (j.promptFeedback?.blockReason) throw new Error(`Gemini บล็อกรูป: ${j.promptFeedback.blockReason}`)
    const text = j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('')
    if (!text) throw new Error(`Gemini ไม่มีคำตอบ (finishReason=${j.candidates?.[0]?.finishReason ?? '-'})`)
    let out: unknown
    try {
      out = JSON.parse(text)
    } catch {
      throw new Error('Gemini ตอบ JSON เพี้ยน')
    }
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('Gemini ตอบผิดรูปแบบ')
    return normalize(out as Partial<SlipAi>)
  }
}

/** "xxx-x-x5678-x" → เลข 4 หลักท้ายที่มองเห็น · น้อยกว่า 4 หลัก = null */
export function accountSuffix(v: unknown): string | null {
  const d = typeof v === 'string' ? v.replace(/\D/g, '') : ''
  return d.length >= 4 ? d.slice(-4) : null
}

export function normalize(x: Partial<SlipAi>): SlipAi {
  const amount = typeof x.amount === 'number' && Number.isFinite(x.amount) && x.amount > 0 ? x.amount : null
  return {
    type: x.type === 'transfer_slip' || x.type === 'receipt' ? x.type : 'other',
    amount,
    datetime: x.datetime ?? null,
    sender_name: x.sender_name ?? null,
    receiver_name: x.receiver_name ?? null,
    sender_account: accountSuffix(x.sender_account),
    receiver_account: accountSuffix(x.receiver_account),
    receiver_kind: x.receiver_kind === 'person' || x.receiver_kind === 'shop' || x.receiver_kind === 'topup' ? x.receiver_kind : null,
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
