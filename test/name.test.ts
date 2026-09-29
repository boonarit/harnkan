import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlers } from '../src/bot.ts'
import { validateName } from '../src/domain/name.js'
import { PARSER_WORDS, parseMessage } from '../src/domain/parse.js'
import { runSummary } from '../src/jobs/summary.ts'
import { handleEvent } from '../src/line/router.ts'
import { makeServer } from '../src/server.ts'
import { ApiAdapter, ApiError } from '../public/app/data/adapter.js'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'

const DAY = '2026-09-29'

test('validateName: ตัดช่องว่าง · ห้ามว่าง · ≤ 40 ตัว · ห้ามซ้ำอีกคน (ไม่สนตัวพิมพ์) · ห้ามตัวเลข', () => {
  assert.deepEqual(validateName('  แตง   โม ', ['เอ']), { ok: true, name: 'แตง โม' })
  assert.equal(validateName('ก'.repeat(40), []).ok, true)
  const bad: [string, string[], RegExp][] = [
    ['', [], /ว่าง/], ['   ', [], /ว่าง/], ['ก'.repeat(41), [], /40/], ['เอ', ['เอ'], /ซ้ำ/], ['bee', ['Bee'], /ซ้ำ/], [' เอ ', ['เอ'], /ซ้ำ/],
    ['บี2', [], /ตัวเลข/], ['๙๙', [], /ตัวเลข/],
  ]
  for (const [n, others, re] of bad) {
    const r = validateName(n, others)
    assert.equal(r.ok, false, n)
    assert.match((r as any).error, re, n)
  }
})

test('validateName ปฏิเสธทุกคำที่ parser ใช้ (ดึงจาก PARSER_WORDS ตรง)', () => {
  const all = [...PARSER_WORDS.commands, ...PARSER_WORDS.markers, ...PARSER_WORDS.currency]
  for (const w of ['สรุป', 'ยกเลิก', 'ตั้งชื่อ', 'ของ', 'เลี้ยง', 'ครึ่ง', '฿', 'บาท']) assert.ok(all.includes(w), `parser ควรมี ${w}`)
  for (const w of all) {
    const r = validateName(w, [])
    assert.equal(r.ok, false, w)
    assert.match((r as any).error, /บอทใช้/, w)
  }
  // คำ marker ฝังในชื่อก็ไม่ได้
  for (const n of ['ของขวัญ', 'หมูเลี้ยง', 'ครึ่งหนึ่ง', 'เงิน฿']) assert.equal(validateName(n, []).ok, false, n)
  // ชื่อที่มีตัวอักษรบังเอิญเหมือน currency สั้น (บ) ยังใช้ได้
  assert.equal(validateName('บี', []).ok, true)
})

test('parser: ครึ่ง = half · ตั้งชื่อ <ชื่อ> = คำสั่งเปลี่ยนชื่อ', () => {
  assert.deepEqual(parseMessage('กาแฟ 90 ครึ่ง'), { kind: 'expense', merchant: 'กาแฟ', amount: 9000, mode: 'half', forName: null })
  assert.deepEqual(parseMessage('ข้าว 120 หารครึ่ง'), { kind: 'expense', merchant: 'ข้าว', amount: 12000, mode: 'half', forName: null })
  assert.deepEqual(parseMessage('ตั้งชื่อ แตงโม'), { kind: 'command', command: 'rename', name: 'แตงโม' })
  assert.deepEqual(parseMessage('ตั้งชื่อ'), { kind: 'command', command: 'rename', name: '' })
  assert.equal(parseMessage('ตั้งชื่อลูก 500')?.kind, 'expense')
})

async function setup() {
  const t = makeCtx({ now: Date.parse(`${DAY}T08:00:00+07:00`) })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  t.line.take()
  const couple = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(couple.id)
  t.repo.updateMember(a.id, { promptpay_id: '0800000001' })
  return { ...t, send, couple, a, b }
}

test('แชท "ตั้งชื่อ แตงโม" → ยืนยันสั้นๆ · ของ<ชื่อใหม่> การ์ด และสรุป 21:00 ใช้ชื่อใหม่ · ชื่อเก่าไม่ถูกจับเป็นเจ้าของ', async () => {
  const { send, line, repo, couple, b, ctx, clock } = await setup()
  await send(ev.text(B_ID, 'ตั้งชื่อ แตงโม'))
  assert.match(line.texts()[0], /เปลี่ยนชื่อเป็น \\"แตงโม\\" แล้ว/)
  assert.equal(repo.member(b.id)!.display_name, 'แตงโม')
  assert.equal(repo.auditFor('member', b.id).at(-1)!.action, 'rename')
  line.take()

  await send(ev.text(A_ID, 'ครีมกันแดดของแตงโม 359'))
  const card = JSON.stringify(line.take()[0].messages[0]) // [1] = การ์ดเตือนตั้งค่า (B18: ยังไม่ใส่ชื่อบัญชี) ซึ่งมีคำว่า "ลงทะเบียน"
  const [e] = repo.expensesByDay(couple.id, DAY)
  assert.deepEqual([e.split_mode, e.merchant], ['theirs', 'ครีมกันแดด'])
  assert.match(card, /ของแตงโม/)
  assert.match(card, /แตงโม ค้าง เอ ฿359\.00/)
  assert.ok(!card.includes('บี'), 'การ์ดไม่มีชื่อเก่า')

  // negative control: ชื่อเก่าไม่ใช่เจ้าของแล้ว → โหมดเริ่มต้น (half) และคำว่า "ของบี" อยู่ในชื่อรายการ
  await send(ev.text(A_ID, 'ครีมกันแดดของบี 100'))
  const old = repo.expensesByDay(couple.id, DAY)[1]
  assert.deepEqual([old.split_mode, old.merchant], ['half', 'ครีมกันแดดของบี'])
  line.take()

  clock.t = Date.parse(`${DAY}T21:00:00+07:00`)
  await runSummary(ctx)
  const s = line.take()[0].messages[0] as any
  assert.match(s.altText, /แตงโม โอนให้ เอ ฿409\.00/)
  assert.ok(!JSON.stringify(s).includes('บี'))
})

test('ชื่อซ้ำ / ชนคำสั่ง / ว่าง / ยาวเกิน → error และไม่มีอะไรถูกบันทึก', async () => {
  const { send, line, repo, couple, b } = await setup()
  const auditBefore = repo.auditFor('member', b.id).length
  for (const n of ['เอ', 'ครึ่งแรก', 'สรุป', 'ของขวัญ', 'เลี้ยงเก่ง', '007', '', 'ก'.repeat(41)]) {
    await send(ev.text(B_ID, `ตั้งชื่อ ${n}`.trim()))
    const out = line.take()
    assert.equal(out.length, 1, n)
    assert.match(JSON.stringify(out[0].messages), /เปลี่ยนชื่อไม่ได้/, n)
  }
  assert.equal(repo.member(b.id)!.display_name, 'บี')
  assert.equal(repo.auditFor('member', b.id).length, auditBefore)
  assert.equal(repo.expensesByDay(couple.id, DAY).length, 0)
})

test('API ใช้กฎเดียวกัน: 400 พร้อม field=display_name · สำเร็จแล้วแชทใช้ชื่อใหม่', async () => {
  const { ctx, repo, b, couple, send, line } = await setup()
  const srv = await listen(makeServer(ctx, handlers))
  try {
    const api = new ApiAdapter({ getToken: async () => `fake:${B_ID}`, base: srv.base })
    for (const n of ['เอ', 'หารครึ่ง', 'ยกเลิก', 'x'.repeat(41)]) {
      await assert.rejects(api.saveSettings({ display_name: n }), (e: any) => e instanceof ApiError && e.status === 400 && e.field === 'display_name', n)
    }
    assert.equal(repo.member(b.id)!.display_name, 'บี')
    // ส่งชื่อผิดพร้อมค่าอื่น → ไม่มีอะไรถูกบันทึกเลย
    await assert.rejects(api.saveSettings({ display_name: 'เอ', min_transfer: 9900 }))
    assert.equal(repo.couple(couple.id)!.min_transfer, 5000)
    const ok = await api.saveSettings({ display_name: '  ส้ม  ' })
    assert.equal(ok.members[1].display_name, 'ส้ม')
    await send(ev.text(A_ID, 'ขนมของส้ม 60'))
    assert.equal(repo.expensesByDay(couple.id, DAY)[0].split_mode, 'theirs')
    assert.match(line.texts().at(-1)!, /ของส้ม/)
  } finally {
    await srv.close()
  }
})
