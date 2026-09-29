import { test } from 'node:test'
import assert from 'node:assert/strict'
import { utimesSync } from 'node:fs'
import { join } from 'node:path'
import { handlers } from '../src/bot.ts'
import { handleEvent } from '../src/line/router.ts'
import { runSummary } from '../src/jobs/summary.ts'
import { promptpayPayload, readQrPng } from '../src/promptpay/qr.ts'
import { makeServer } from '../src/server.ts'
import { recordSettlement } from '../src/settle.ts'
import { decodeQr } from '../src/slip/qr.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'

const at = (hm: string, day = '2026-09-29') => Date.parse(`${day}T${hm}:00+07:00`)

async function exampleDay() {
  const t = makeCtx({ now: at('08:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  const couple = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(couple.id)
  t.repo.updateMember(a.id, { promptpay_id: '0800000001' })
  t.repo.updateMember(b.id, { promptpay_id: '0800000002' })
  const steps: [string, string, string][] = [
    ['08:10', A_ID, 'กาแฟ 2 แก้ว 90'], ['12:30', B_ID, 'ข้าวกลางวัน 240'], ['18:45', A_ID, '7-Eleven 127'],
    ['19:10', A_ID, 'ครีมกันแดดของบี 359'], ['20:00', B_ID, 'ข้าวเย็น 420 เลี้ยง'],
  ]
  for (const [hm, who, text] of steps) {
    t.clock.t = at(hm)
    await send(ev.text(who, text))
  }
  t.line.take()
  return { ...t, send, couple, a, b }
}

test('ตัวอย่าง 1 วัน → 21:00 push 1 ข้อความ ยอด 34750 + QR · รันซ้ำไม่ส่งซ้ำ', async () => {
  const { ctx, line, repo, couple, clock } = await exampleDay()
  clock.t = at('21:00')
  const r = await runSummary(ctx)
  assert.deepEqual(r, [{ coupleId: couple.id, date: '2026-09-29', action: 'request', pushed: true }])
  const out = line.take()
  assert.equal(out.length, 1)
  assert.equal(out[0].kind, 'push')
  assert.equal(out[0].to, couple.line_group_id)
  const msg = out[0].messages[0] as any
  assert.match(msg.altText, /บี โอนให้ เอ ฿347\.50/)
  const json = JSON.stringify(msg)
  assert.match(json, /จาก 5 รายการ/)
  assert.match(json, /carry:\d+/)
  const s = repo.summary(couple.id, '2026-09-29')!
  assert.equal(s.net_satang, 34750)
  assert.equal(msg.contents.hero.url, `${ctx.cfg.publicBaseUrl}/qr/${s.qr_token}.png`)

  clock.t = at('21:30')
  assert.deepEqual(await runSummary(ctx), [{ coupleId: couple.id, date: '2026-09-29', action: 'skip', pushed: false }])
  assert.equal(line.outbox.length, 0)
})

test('GET /qr/<token>.png เสิร์ฟ QR พร้อมเพย์ของคนรับ ยอดถูก · หมดอายุ/token มั่ว → 404', async () => {
  const { ctx, repo, couple, clock } = await exampleDay()
  clock.t = at('21:00')
  await runSummary(ctx)
  const token = repo.summary(couple.id, '2026-09-29')!.qr_token!
  const srv = await listen(makeServer(ctx))
  try {
    const res = await fetch(`${srv.base}/qr/${token}.png`)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('content-type'), 'image/png')
    const payload = await decodeQr(Buffer.from(await res.arrayBuffer()))
    assert.equal(payload, promptpayPayload('0800000001', 34750))
    assert.match(payload!, /5406347\.50/)
    assert.equal((await fetch(`${srv.base}/qr/nope.png`)).status, 404)
    assert.equal((await fetch(`${srv.base}/qr/..%2F..%2Fharnkan.db.png`)).status, 404)
    const f = join(ctx.cfg.dataDir, 'qr', `${token}.png`)
    const old = (Date.now() - 25 * 3600_000) / 1000
    utimesSync(f, old, old)
    assert.equal(readQrPng(ctx.cfg.dataDir, token), null)
  } finally {
    await srv.close()
  }
})

test('สลิปโอน 347.50 → ปิดยอด "เคลียร์แล้ว" · วันถัดไปยอด 0', async () => {
  const { ctx, send, line, repo, couple, clock } = await exampleDay()
  clock.t = at('21:00')
  await runSummary(ctx)
  line.take()
  clock.t = at('21:05')
  await send(ev.image(B_ID, 'slip-settle'))
  assert.match(line.texts()[0], /เคลียร์แล้ว/)
  const s = repo.summary(couple.id, '2026-09-29')!
  assert.equal(s.settled, 1)
  assert.equal(s.paid_satang, 34750)
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, 0)
  assert.equal(repo.ledger(couple.id, '2026-09-30').carriedIn, 0)
})

test('โอนขาด → ยอดยกมา · โอนเกิน → ยกกลับ', async () => {
  const { ctx, repo, couple, clock, a, b } = await exampleDay()
  clock.t = at('21:00')
  await runSummary(ctx)
  clock.t = at('21:10')
  assert.match(recordSettlement(ctx, couple, b, a, 30000, null, b.id), /ยังขาด ฿47\.50 ยกไปพรุ่งนี้/)
  assert.equal(repo.summary(couple.id, '2026-09-29')!.settled, 0)
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, 4750)
  assert.match(recordSettlement(ctx, couple, b, a, 5000, null, b.id), /โอนเกิน ฿2\.50 ยกไปพรุ่งนี้ \(เอ โอนให้ บี ฿2\.50\)/)
  assert.equal(repo.summary(couple.id, '2026-09-29')!.settled, 1)
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, -250)
  // ปิดแล้ว → โอนเพิ่มไม่ผูกกับสรุปเดิม
  recordSettlement(ctx, couple, a, b, 250, null, a.id)
  assert.equal(repo.ledger(couple.id, '2026-09-30').net, 0)
})

test('ต่ำกว่าขั้นต่ำ → ทบ ไม่ push · วันถัดไปรวมยอดยกมา', async () => {
  const t = makeCtx({ now: at('08:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  await send(ev.text(A_ID, 'ขนม 60'))
  t.line.take()
  t.clock.t = at('21:00')
  const [r] = await runSummary(t.ctx)
  assert.equal(r.action, 'carry')
  assert.equal(t.line.outbox.length, 0)
  const couple = t.repo.allCouples()[0]
  assert.equal(t.repo.ledger(couple.id, '2026-09-30').carriedIn, 3000)
  t.clock.t = at('09:00', '2026-09-30')
  await send(ev.text(A_ID, 'ข้าว 80'))
  t.line.take()
  t.clock.t = at('21:00', '2026-09-30')
  const [r2] = await runSummary(t.ctx)
  assert.equal(r2.action, 'request')
  assert.match((t.line.take()[0].messages[0] as any).altText, /฿70\.00/)
})

test('ยอด 0: มีรายการ → "วันนี้ไม่มีใครติดใคร" · ไม่มีรายการเลย → ไม่ push', async () => {
  const t = makeCtx({ now: at('08:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  t.line.take() // reply "ลงทะเบียนแล้ว" (B17)
  t.clock.t = at('21:00')
  await runSummary(t.ctx)
  assert.equal(t.line.outbox.length, 0)
  t.clock.t = at('10:00', '2026-09-30')
  await send(ev.text(A_ID, 'ข้าว 100 เลี้ยง'))
  t.line.take()
  t.clock.t = at('21:00', '2026-09-30')
  await runSummary(t.ctx)
  assert.match(t.line.texts()[0], /วันนี้ไม่มีใครติดใคร/)
})

test('push ล้ม → รันรอบถัดไปส่งใหม่ (ไม่หาย ไม่ซ้ำ)', async () => {
  const { ctx, line, clock } = await exampleDay()
  const push = line.push.bind(line)
  line.push = async () => { throw new Error('LINE 500') }
  clock.t = at('21:00')
  await runSummary(ctx)
  line.push = push
  clock.t = at('21:15')
  await runSummary(ctx)
  await runSummary(ctx)
  assert.equal(line.take().filter((o) => o.kind === 'push').length, 1)
})

test('ปุ่มทบไปพรุ่งนี้ · ไม่มีเบอร์พร้อมเพย์ → การ์ดไม่มี QR', async () => {
  const { ctx, send, line, repo, couple, clock, a } = await exampleDay()
  repo.updateMember(a.id, { promptpay_id: null })
  clock.t = at('21:00')
  await runSummary(ctx)
  const msg = line.take()[0].messages[0] as any
  assert.equal(msg.contents.hero, undefined)
  assert.match(JSON.stringify(msg), /ยังไม่ได้ตั้งเบอร์พร้อมเพย์/)
  const s = repo.summary(couple.id, '2026-09-29')!
  await send(ev.postback(B_ID, `carry:${s.id}`))
  assert.match(line.texts()[0], /ทบยอด/)
  assert.equal(repo.summary(couple.id, '2026-09-29')!.action, 'carry')
  assert.equal(repo.ledger(couple.id, '2026-09-30').carriedIn, 34750)
})

test('promptpayPayload ตรวจรูปแบบเบอร์', () => {
  assert.throws(() => promptpayPayload('12345', 100))
  assert.match(promptpayPayload('080-000-0001', 9000), /^000201/)
})

test('readQrPng กัน path traversal', async () => {
  const { writeFileSync, mkdirSync } = await import('node:fs')
  const { tmpDir } = await import('./helpers/db.ts')
  const dir = tmpDir()
  mkdirSync(join(dir, 'qr'))
  writeFileSync(join(dir, 'secret.png'), 'x')
  assert.equal(readQrPng(dir, '../secret'), null)
  assert.equal(readQrPng(dir, '..%2Fsecret'), null)
})
