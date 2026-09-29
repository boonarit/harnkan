import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlers } from '../src/bot.ts'
import { handleEvent } from '../src/line/router.ts'
import { A_ID, B_ID, ev, makeCtx } from './helpers/app.ts'

async function setup() {
  const t = makeCtx()
  const send = (e: ReturnType<typeof ev.text>) => handleEvent(t.ctx, e, handlers)
  await send(ev.join())
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  t.line.take()
  const couple = t.repo.allCouples()[0]
  return { ...t, send, couple }
}

test('ข้อความรายการ → Flex card + quick reply 4 ปุ่ม', async () => {
  const { send, line, repo, couple } = await setup()
  await send(ev.text(A_ID, 'กาแฟ 2 แก้ว 90'))
  const [out] = line.take()
  const msg = out.messages[0] as any
  assert.equal(msg.type, 'flex')
  assert.match(msg.altText, /กาแฟ 2 แก้ว ฿90\.00/)
  const body = JSON.stringify(msg.contents)
  assert.match(body, /จ่ายโดย/)
  assert.match(body, /เอ/)
  assert.match(body, /หารครึ่ง/)
  assert.match(body, /บี ค้าง เอ ฿45\.00/)
  assert.match(body, /บี โอนให้ เอ ฿45\.00/)
  const e = repo.expensesByDay(couple.id, '2026-09-29')[0]
  assert.deepEqual(msg.quickReply.items.map((i: any) => i.action.data), [`split:${e.id}:half`, `split:${e.id}:mine`, `split:${e.id}:theirs`, `split:${e.id}:treat`])
  assert.deepEqual(msg.quickReply.items.map((i: any) => i.action.label), ['หารครึ่ง', 'ของเอ', 'ของบี', 'เลี้ยง'])

  // บีจ่าย: ปุ่ม "ของเอ" = theirs, "ของบี" = mine
  await send(ev.text(B_ID, 'ข้าว 240'))
  const qr = (line.take()[0].messages[0] as any).quickReply.items.map((i: any) => i.action.data.split(':')[2])
  assert.deepEqual(qr, ['half', 'theirs', 'mine', 'treat'])
})

test('ข้อความทั่วไป → บอทเงียบ', async () => {
  const { send, line, repo, couple } = await setup()
  for (const t of ['ถึงยัง', '555', 'เจอกัน 18.30']) await send(ev.text(B_ID, t))
  assert.equal(line.outbox.length, 0)
  assert.equal(repo.expensesByDay(couple.id, '2026-09-29').length, 0)
})

test('postback เปลี่ยนโหมด → การ์ดใหม่ + audit_log · couple อื่นแก้ไม่ได้', async () => {
  const { send, line, repo, couple, ctx } = await setup()
  await send(ev.text(A_ID, 'ครีมกันแดด 359'))
  line.take()
  const e = repo.expensesByDay(couple.id, '2026-09-29')[0]
  await send(ev.postback(B_ID, `split:${e.id}:theirs`))
  const [out] = line.take()
  assert.match(JSON.stringify(out.messages), /ของบี/)
  assert.match(JSON.stringify(out.messages), /บี โอนให้ เอ ฿359\.00/)
  assert.equal(repo.expense(e.id)!.split_mode, 'theirs')
  const log = repo.auditFor('expense', e.id)
  assert.equal(log.at(-1)!.action, 'update')
  assert.equal(log.at(-1)!.member_id, repo.memberByLineUser(couple.id, B_ID)!.id)

  // กลุ่มอื่นพยายามแก้ id นี้
  const other = { type: 'postback', replyToken: 'x', source: { type: 'group' as const, groupId: 'C_fake_other', userId: 'U_fake_x' }, postback: { data: `split:${e.id}:mine` } }
  await handleEvent(ctx, other, handlers)
  await handleEvent(ctx, { ...other, source: { ...other.source, userId: 'U_fake_y' } }, handlers)
  await handleEvent(ctx, other, handlers)
  assert.equal(repo.expense(e.id)!.split_mode, 'theirs')
})

test('ของ<ชื่อ> และ เลี้ยง', async () => {
  const { send, repo, couple } = await setup()
  await send(ev.text(A_ID, 'ครีมกันแดดของบี 359'))
  await send(ev.text(B_ID, 'ข้าวเย็น 420 เลี้ยง'))
  await send(ev.text(B_ID, 'แชมพูของบี 100'))
  const es = repo.expensesByDay(couple.id, '2026-09-29')
  assert.deepEqual(es.map((e) => e.split_mode), ['theirs', 'treat', 'mine'])
  assert.equal(repo.ledger(couple.id, '2026-09-29').net, 35900)
})

test('สรุป / ยกเลิก / ช่วยด้วย', async () => {
  const { send, line, repo, couple } = await setup()
  await send(ev.text(A_ID, 'กาแฟ 90'))
  await send(ev.text(B_ID, 'ข้าว 240'))
  line.take()
  await send(ev.text(B_ID, 'สรุป'))
  assert.match(line.texts()[0], /เอ โอนให้ บี ฿75\.00/)
  line.take()
  await send(ev.text(B_ID, 'ยกเลิก'))
  assert.match(line.texts()[0], /ลบ \\"ข้าว ฿240\.00\\" แล้ว/)
  assert.deepEqual(repo.expensesByDay(couple.id, '2026-09-29').map((e) => e.merchant), ['กาแฟ'])
  line.take()
  await send(ev.text(B_ID, 'ยกเลิก'))
  assert.match(line.texts()[0], /ยังไม่มีรายการ/)
  assert.deepEqual(repo.expensesByDay(couple.id, '2026-09-29').map((e) => e.merchant), ['กาแฟ'], 'ยกเลิกไม่ลบของอีกคน')
  line.take()
  await send(ev.text(A_ID, 'ช่วยด้วย'))
  assert.match(line.texts()[0], /วิธีใช้/)
})

test('มีสมาชิกคนเดียว → ขอให้รออีกคน', async () => {
  const t = makeCtx()
  await handleEvent(t.ctx, ev.text(A_ID, 'กาแฟ 90'), handlers)
  assert.match(t.line.texts()[0], /รออีกคน/)
})

test('หลัง 21:00 นับเป็นวันถัดไป', async () => {
  const { send, repo, couple, clock } = await setup()
  clock.t = Date.parse('2026-09-29T21:30:00+07:00')
  await send(ev.text(A_ID, 'ขนม 50'))
  assert.equal(repo.expensesByDay(couple.id, '2026-09-30').length, 1)
})
