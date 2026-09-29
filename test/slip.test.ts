import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Jimp } from 'jimp'
import { handlers } from '../src/bot.ts'
import { handleEvent } from '../src/line/router.ts'
import { classify, firstName } from '../src/slip/classify.ts'
import { ClaudeSlipReader, normalize } from '../src/slip/vision.ts'
import { makeSlipPng } from './fixtures/make-slip.ts'
import { A_ID, B_ID, ev, makeCtx } from './helpers/app.ts'

const DAY = '2026-09-29'

async function setup() {
  const t = makeCtx({ now: Date.parse('2026-09-29T19:10:00+07:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  t.line.take()
  const couple = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(couple.id)
  return { ...t, send, couple, a, b }
}

test('ใบเสร็จ → expense (คนจ่าย = คนส่งรูป) + การ์ด', async () => {
  const { send, repo, line, couple, a } = await setup()
  await send(ev.image(A_ID, 'slip-sunscreen'))
  const [e] = repo.expensesByDay(couple.id, DAY)
  assert.equal(e.amount_satang, 35900)
  assert.equal(e.merchant, 'ครีมกันแดด')
  assert.equal(e.paid_by, a.id)
  assert.equal(e.source, 'slip')
  assert.equal(e.category, 'ของใช้ส่วนตัว')
  assert.ok(e.slip_id)
  assert.equal(repo.slip(e.slip_id!)!.kind, 'expense')
  assert.match(line.texts()[0], /บันทึกแล้ว ครีมกันแดด ฿359\.00/)
})

test('สลิปโอนหาอีกคน → settlement ไม่ใช่ expense', async () => {
  const { send, repo, line, couple, a, b } = await setup()
  await send(ev.image(B_ID, 'slip-settle'))
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 0)
  const s = repo.unmatchedSettlements(couple.id, DAY)
  assert.equal(s.length, 1)
  assert.deepEqual([s[0].from_member, s[0].to_member, s[0].amount_satang], [b.id, a.id, 34750])
  assert.match(line.texts()[0], /รับโอน บี → เอ ฿347\.50/)
  assert.equal(repo.ledger(couple.id, DAY).net, -34750)
})

test('คนรับโพสต์สลิปเอง → settlement ทิศถูก', () => {
  const m = (id: number, name: string) => ({ id, couple_id: 1, line_user_id: `U_fake_${id}`, display_name: name, promptpay_id: null, bank_names: '[]' })
  const A = m(1, 'เอ'), B = m(2, 'บี')
  const ai = normalize({ type: 'transfer_slip', amount: 100, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส***', confidence: 0.9 })
  const c = classify(ai, A, [A, B])
  assert.equal(c.kind, 'settlement')
  assert.deepEqual(c.kind === 'settlement' && [c.from.id, c.to.id, c.amount], [2, 1, 10000])
  assert.equal(classify({ ...ai, receiver_name: 'ร้านค้า' }, A, [A, B]).kind, 'expense')
  assert.equal(classify({ ...ai, type: 'other' }, A, [A, B]).kind, 'ignore')
  assert.equal(classify({ ...ai, amount: null }, A, [A, B]).kind, 'ask_amount')
  // bank_names ใช้จับชื่อจริงบนสลิปได้
  const B2 = { ...B, display_name: 'ที่รัก', bank_names: JSON.stringify(['บี สมมติ']) }
  assert.equal(classify(ai, A, [A, B2]).kind, 'settlement')
  assert.equal(firstName('MR. Bee S.'), 'bee')
})

test('confidence ต่ำ → ถามกลับพร้อมปุ่ม · กดใช่ → บันทึก', async () => {
  const { send, repo, line, couple } = await setup()
  await send(ev.image(B_ID, 'slip-blurry'))
  const [out] = line.take()
  const msg = out.messages[0] as any
  assert.match(msg.text, /อ่านได้ ฿85\.00 แต่ไม่ค่อยแน่ใจ/)
  assert.deepEqual(msg.quickReply.items.map((i: any) => i.action.label), ['ใช่ ฿85.00', 'แก้ยอด'])
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 0)
  await send(ev.postback(B_ID, msg.quickReply.items[0].action.data))
  assert.equal(repo.expensesByDay(couple.id, DAY)[0].amount_satang, 8500)
  line.take()
  await send(ev.postback(B_ID, msg.quickReply.items[0].action.data))
  assert.match(line.texts()[0], /บันทึกไปแล้ว/)
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 1)
})

test('กดแก้ยอด → พิมพ์ตัวเลข → บันทึกยอดที่พิมพ์', async () => {
  const { send, repo, line, couple } = await setup()
  await send(ev.image(B_ID, 'slip-blurry'))
  const data = (line.take()[0].messages[0] as any).quickReply.items[1].action.data
  await send(ev.postback(B_ID, data))
  assert.match(line.texts()[0], /พิมพ์ยอด/)
  await send(ev.text(B_ID, '80'))
  const [e] = repo.expensesByDay(couple.id, DAY)
  assert.equal(e.amount_satang, 8000)
  assert.equal(e.merchant, 'ร้านน้ำ')
  assert.equal(e.source, 'slip')
})

test('รูปทั่วไป (ไม่ใช่สลิป) → เงียบ + ไม่เก็บรูป', async () => {
  const { send, repo, line, dir, ctx } = await setup()
  ;(ctx.line as any).contents.set('cat', await new Jimp({ width: 64, height: 64, color: 0xff8800ff }).getBuffer('image/png'))
  await send(ev.image(A_ID, 'cat'))
  assert.equal(line.outbox.length, 0)
  const slip = repo.db.prepare('SELECT * FROM slips').get() as any
  assert.equal(slip.image_path, null)
  const files = existsSync(join(dir, 'slips')) ? readdirSync(join(dir, 'slips'), { recursive: true }).filter((f) => String(f).includes('.')) : []
  assert.deepEqual(files, [])
})

test('งบ AI รายวัน (ค่าจาก DB) เกิน → ขอให้พิมพ์ยอดแทน ไม่เรียก AI', async () => {
  const { send, repo, line, couple, slips } = await setup()
  repo.updateCouple(couple.id, { ai_daily_cap: 1 }, null)
  await send(ev.image(A_ID, 'slip-sunscreen'))
  assert.equal(slips.calls, 1)
  line.take()
  await send(ev.image(A_ID, 'slip-coffee'))
  assert.equal(slips.calls, 1)
  assert.match(line.texts()[0], /อ่านสลิปครบ 1 รูปแล้ว/)
})

test('ClaudeSlipReader: ย่อรูป ≤1568 · บังคับ tool · แปลงผล (stub API ไม่ต่อเน็ต)', async () => {
  const r = new ClaudeSlipReader('fake-key', 'claude-haiku-4-5')
  let req: any
  ;(r.client as any).messages = {
    create: async (body: any) => {
      req = body
      return { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't', name: 'record_slip', input: { type: 'receipt', amount: 359, confidence: 1.4, items: ['x'] } }] }
    },
  }
  const big = await new Jimp({ width: 3000, height: 1000, color: 0xffffffff }).getBuffer('image/png')
  const out = await r.read(big)
  assert.equal(req.model, 'claude-haiku-4-5')
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'record_slip' })
  const img = req.messages[0].content[0]
  assert.equal(img.source.media_type, 'image/jpeg')
  const decoded = await Jimp.read(Buffer.from(img.source.data, 'base64'))
  assert.ok(Math.max(decoded.width, decoded.height) <= 1568)
  assert.equal(out.amount, 359)
  assert.equal(out.confidence, 1)
  assert.equal(out.sender_name, null)
})

test('AI พัง → ขอให้พิมพ์ยอด ไม่ทำ webhook ล่ม', async () => {
  const { send, repo, line, couple, ctx } = await setup()
  ctx.slips = { read: async () => { throw new Error('timeout') } }
  await send(ev.image(A_ID, 'slip-sunscreen'))
  assert.match(line.texts()[0], /พิมพ์ยอด/)
  line.take()
  await send(ev.text(A_ID, '359'))
  assert.equal(repo.expensesByDay(couple.id, DAY)[0].amount_satang, 35900)
})

test('สลิปใหม่ที่สร้างในเทสต์ (ไม่มี sidecar) + QR → ถามยอด', async () => {
  const { send, line, ctx } = await setup()
  const { slipVerify } = await import('promptparse/generate')
  ;(ctx.line as any).contents.set('new', await makeSlipPng({ title: 'X', lines: [], qr: slipVerify({ sendingBank: '002', transRef: 'FAKENEW0001' }) }))
  await send(ev.image(A_ID, 'new'))
  assert.match(line.texts()[0], /พิมพ์ยอด/)
})

test('ปุ่มยืนยันสลิปจากกลุ่มอื่น → ไม่บันทึก', async () => {
  const { send, repo, line, couple, ctx } = await setup()
  await send(ev.image(B_ID, 'slip-blurry'))
  const data = (line.take()[0].messages[0] as any).quickReply.items[0].action.data
  const other = { type: 'postback', replyToken: 'x', source: { type: 'group' as const, groupId: 'C_fake_other', userId: 'U_fake_x' }, postback: { data } }
  await handleEvent(ctx, { ...other, source: { ...other.source, userId: 'U_fake_y' } }, handlers)
  await handleEvent(ctx, other, handlers)
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 0)
  const otherCouple = repo.coupleByGroup('C_fake_other')!
  assert.equal(repo.expensesByDay(otherCouple.id, DAY).length, 0)
})
