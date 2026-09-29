// Gemini reader: ไม่ต่อเน็ต — mock fetch ทั้งหมด · key สมมติเท่านั้น
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { handlers } from '../src/bot.ts'
import { loadConfig } from '../src/config.ts'
import { handleEvent } from '../src/line/router.ts'
import { initLog } from '../src/log.ts'
import { GeminiSlipReader, SLIP_TOOL, geminiSchema } from '../src/slip/vision.ts'
import { A_ID, B_ID, ev, makeCtx } from './helpers/app.ts'
import { tmpDir } from './helpers/db.ts'

const KEY = 'FAKE-GEMINI-KEY-do-not-log-123'
const MODEL = 'gemini-test-model'

type Call = { url: string; init: RequestInit }
function mockFetch(respond: (c: Call) => Response) {
  const calls: Call[] = []
  const fn = async (url: string | URL, init: RequestInit = {}) => {
    const c = { url: String(url), init }
    calls.push(c)
    return respond(c)
  }
  return { fn: fn as typeof fetch, calls }
}
const ok = (obj: unknown) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: 'STOP' }] }), { status: 200, headers: { 'content-type': 'application/json' } })
const RECEIPT = { type: 'receipt', amount: 359, datetime: null, sender_name: null, receiver_name: null, merchant: 'ครีมกันแดด', items: ['ครีม'], category: 'ของใช้', confidence: 0.93 }

test('responseSchema มาจาก SLIP_TOOL ตรง: field ชุดเดียวกัน · nullable ตรงกัน', () => {
  const g = geminiSchema(SLIP_TOOL.input_schema) as any
  assert.equal(g.type, 'OBJECT')
  assert.deepEqual(Object.keys(g.properties), Object.keys(SLIP_TOOL.input_schema.properties))
  assert.deepEqual(g.required, SLIP_TOOL.input_schema.required)
  assert.deepEqual(g.properties.amount, { type: 'NUMBER', nullable: true, description: SLIP_TOOL.input_schema.properties.amount.description })
  assert.deepEqual(g.properties.type.enum, ['transfer_slip', 'receipt', 'other'])
  assert.deepEqual(g.properties.items, { type: 'ARRAY', items: { type: 'STRING' }, description: SLIP_TOOL.input_schema.properties.items.description })
})

test('GeminiSlipReader: POST generateContent · key อยู่ใน header x-goog-api-key ไม่อยู่ใน URL · รูปย่อ ≤1568 JPEG · ผลผ่าน normalize', async () => {
  const m = mockFetch(() => ok({ ...RECEIPT, confidence: 1.7, items: 'bad' }))
  const r = new GeminiSlipReader(KEY, MODEL, m.fn)
  const big = await new Jimp({ width: 3000, height: 1200, color: 0xffffffff }).getBuffer('image/png')
  const out = await r.read(big)
  assert.equal(m.calls.length, 1)
  const { url, init } = m.calls[0]
  assert.equal(url, `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`)
  assert.ok(!url.includes(KEY) && !url.includes('key='))
  assert.equal(init.method, 'POST')
  assert.equal((init.headers as Record<string, string>)['x-goog-api-key'], KEY)
  const body = JSON.parse(String(init.body))
  assert.equal(body.generationConfig.responseMimeType, 'application/json')
  assert.deepEqual(body.generationConfig.responseSchema, geminiSchema(SLIP_TOOL.input_schema))
  const img = body.contents[0].parts.find((p: any) => p.inline_data).inline_data
  assert.equal(img.mime_type, 'image/jpeg')
  const decoded = await Jimp.read(Buffer.from(img.data, 'base64'))
  assert.ok(Math.max(decoded.width, decoded.height) <= 1568)
  // normalize ตัวเดียวกับ Claude: confidence ถูกหนีบ, items ผิดชนิด → []
  assert.deepEqual(out, { ...RECEIPT, confidence: 1, items: [] })
})

test('GeminiSlipReader: JSON เพี้ยน / ถูกบล็อก / 429 / 500 → throw (ข้อความไม่มี key)', async () => {
  const cases: [string, () => Response][] = [
    ['json เพี้ยน', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"type":"receipt", amount: ' }] } }] }), { status: 200 })],
    ['ไม่ใช่ object', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '[1,2]' }] } }] }), { status: 200 })],
    ['ถูกบล็อก', () => new Response(JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }), { status: 200 })],
    ['429', () => new Response(`{"error":{"code":429,"message":"Resource exhausted for ${KEY}"}}`, { status: 429 })],
    ['500', () => new Response('internal', { status: 500 })],
    ['body ไม่ใช่ JSON', () => new Response('<html>', { status: 200 })],
  ]
  const png = await new Jimp({ width: 10, height: 10, color: 0xffffffff }).getBuffer('image/png')
  for (const [name, respond] of cases) {
    const r = new GeminiSlipReader(KEY, MODEL, mockFetch(respond).fn)
    // 429/500 ต้องบอก status ใน error (ดู log แล้วรู้ว่าโดน quota หรือ server ล่ม)
    const status = /^\d+$/.test(name) ? new RegExp(`HTTP ${name}`) : /Gemini/
    await assert.rejects(r.read(png), (e: Error) => !e.message.includes(KEY) && status.test(e.message), name)
  }
})

for (const [name, respond] of [
  ['JSON เพี้ยน', () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'not json' }] } }] }), { status: 200 })],
  ['HTTP 429', () => new Response(`{"error":{"code":429,"message":"quota ${KEY}"}}`, { status: 429 })],
  ['HTTP 500', () => new Response('boom', { status: 500 })],
] as [string, () => Response][]) {
  test(`negative control ${name}: ไม่พัง ไม่บันทึกรายการ ถามผู้ใช้แทน · key ไม่โผล่ใน log`, async () => {
    const logDir = tmpDir()
    initLog(logDir)
    const t = makeCtx({ now: Date.parse('2026-09-29T19:10:00+07:00') })
    t.ctx.slips = new GeminiSlipReader(KEY, MODEL, mockFetch(respond).fn)
    const send = (e: any) => handleEvent(t.ctx, e, handlers)
    await send(ev.text(A_ID, 'หวัดดี'))
    await send(ev.text(B_ID, 'หวัดดี'))
    t.line.take()
    await send(ev.image(A_ID, 'slip-sunscreen'))
    const couple = t.repo.allCouples()[0]
    assert.equal(t.repo.expensesByDay(couple.id, '2026-09-29').length, 0)
    assert.match(t.line.texts()[0], /พิมพ์ยอด/)
    const slip = t.repo.db.prepare('SELECT * FROM slips').get() as any
    assert.equal(slip.status, 'await_amount')
    const logs = readdirSync(logDir).map((f) => readFileSync(join(logDir, f), 'utf8')).join('')
    assert.match(logs, /slip_ai_error/)
    assert.ok(!logs.includes(KEY), 'key หลุดใน log')
    // ตอบยอดเองแล้วบันทึกได้
    t.line.take()
    await send(ev.text(A_ID, '359'))
    assert.equal(t.repo.expensesByDay(couple.id, '2026-09-29')[0].amount_satang, 35900)
  })
}

test('config: AI_PROVIDER ค่าเริ่ม gemini · SLIP_MODEL ไม่มีค่าเริ่มของ gemini · เตือนเมื่อขาด key ของ provider ที่เลือก', () => {
  const base = { HARNKAN_ENV: '/nonexistent', FAKE_LINE: '1' }
  const fake = loadConfig({ ...base })
  assert.equal(fake.aiProvider, 'gemini')
  assert.equal(fake.slipModel, '')
  assert.throws(() => loadConfig({ ...base, FAKE_AI: '0', SLIP_MODEL: MODEL }), /GEMINI_API_KEY/)
  assert.throws(() => loadConfig({ ...base, FAKE_AI: '0', GEMINI_API_KEY: KEY }), /SLIP_MODEL/)
  const g = loadConfig({ ...base, FAKE_AI: '0', GEMINI_API_KEY: KEY, SLIP_MODEL: MODEL })
  assert.deepEqual([g.aiProvider, g.slipModel, g.geminiApiKey], ['gemini', MODEL, KEY])
  // claude ยังเลือกได้ และไม่ต้องมี key ของ gemini
  assert.throws(() => loadConfig({ ...base, FAKE_AI: '0', AI_PROVIDER: 'claude' }), /ANTHROPIC_API_KEY/)
  const c = loadConfig({ ...base, FAKE_AI: '0', AI_PROVIDER: 'claude', ANTHROPIC_API_KEY: 'x' })
  assert.deepEqual([c.aiProvider, c.slipModel], ['claude', 'claude-haiku-4-5'])
  assert.throws(() => loadConfig({ ...base, AI_PROVIDER: 'openai' }), /AI_PROVIDER/)
})
