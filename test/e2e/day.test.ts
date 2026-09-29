// วันตัวอย่างใน PLAN ทั้งวัน ผ่าน HTTP จริง: webhook ที่เซ็นถูก (ข้อความ + สลิปสังเคราะห์ + ปุ่ม) → API ตั้งพร้อมเพย์
// → job:summary 21:00 → QR → สลิปโอน → ปิดยอด · ตรวจข้อความใน FakeLineClient ทุกขั้น
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlers } from '../../src/bot.ts'
import type { OutboxItem } from '../../src/line/client.ts'
import { runSummary } from '../../src/jobs/summary.ts'
import { promptpayPayload } from '../../src/promptpay/qr.ts'
import { makeServer } from '../../src/server.ts'
import { decodeQr } from '../../src/slip/qr.ts'
import { A_ID, B_ID, ev, listen, makeCtx, postWebhook } from '../helpers/app.ts'

const at = (hm: string, day = '2026-09-29') => Date.parse(`${day}T${hm}:00+07:00`)
const json = (o: OutboxItem[]) => JSON.stringify(o.map((x) => x.messages))

test('e2e: วันตัวอย่าง → B โอนให้ A ฿347.50 ครั้งเดียว → ส่งสลิป → ปิดยอด', async () => {
  const { ctx, line, repo, clock } = makeCtx({ now: at('07:00') })
  const srv = await listen(makeServer(ctx, handlers))
  const hook = async (...events: any[]) => {
    const r = await postWebhook(srv.base, ctx.cfg.lineChannelSecret, events)
    assert.equal(r.status, 200)
    return line.take()
  }
  const api = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { authorization: `Bearer fake:${who}`, 'content-type': 'application/json' }, body: body && JSON.stringify(body) })
    return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }
  }
  try {
    // เชิญบอทเข้ากลุ่ม + สองคนทักทาย → คู่ + สมาชิก 2 คน (ทักทายปกติบอทเงียบ)
    let out = await hook(ev.join())
    assert.match(json(out), /หารกันพร้อมแล้ว/)
    out = await hook(ev.text(A_ID, 'อรุณสวัสดิ์'), ev.text(B_ID, 'หวัดดีจ้า'))
    assert.equal(out.length, 0)
    const couple = repo.coupleByGroup('C_fake_group')!
    assert.deepEqual(repo.members(couple.id).map((m) => m.display_name), ['เอ', 'บี'])

    // 08:10 กาแฟ 2 แก้ว 90 (A จ่าย หารครึ่ง)
    clock.t = at('08:10')
    out = await hook(ev.text(A_ID, 'กาแฟ 2 แก้ว 90'))
    assert.match(json(out), /บี ค้าง เอ ฿45\.00/)
    assert.match(json(out), /บี โอนให้ เอ ฿45\.00/)

    // 12:30 ข้าวกลางวัน 240 (B จ่าย)
    clock.t = at('12:30')
    out = await hook(ev.text(B_ID, 'ข้าวกลางวัน 240'))
    assert.match(json(out), /เอ ค้าง บี ฿120\.00/)
    assert.match(json(out), /เอ โอนให้ บี ฿75\.00/)

    // 18:45 สลิป 7-Eleven 127 (รูปสังเคราะห์ มี QR · AI fake อ่านยอด)
    clock.t = at('18:45')
    out = await hook(ev.image(A_ID, 'slip-7eleven'))
    assert.match(json(out), /7-Eleven ฿127\.00/)
    assert.match(json(out), /บี ค้าง เอ ฿63\.50/)

    // 19:10 ใบเสร็จครีมกันแดด 359 → กดปุ่ม "ของบี"
    clock.t = at('19:10')
    out = await hook(ev.image(A_ID, 'slip-sunscreen'))
    const card = out[0].messages[0] as any
    const ofB = card.quickReply.items.find((i: any) => i.action.label === 'ของบี').action.data
    out = await hook(ev.postback(A_ID, ofB))
    assert.match(json(out), /เปลี่ยนการหารแล้ว/)
    assert.match(json(out), /บี ค้าง เอ ฿359\.00/)

    // 20:00 ข้าวเย็น 420 เลี้ยง (B เลี้ยง)
    clock.t = at('20:00')
    out = await hook(ev.text(B_ID, 'ข้าวเย็น 420 เลี้ยง'))
    assert.match(json(out), /ไม่นับเข้ายอด/)
    assert.match(json(out), /บี โอนให้ เอ ฿347\.50/)

    // แชทปกติระหว่างวัน → บอทเงียบ
    out = await hook(ev.text(B_ID, 'ถึงบ้านยัง'), ev.text(A_ID, '555'))
    assert.equal(out.length, 0)

    // เอตั้งเบอร์พร้อมเพย์ใน mini app · ยอดใน API ตรงกับแชท
    assert.equal((await api(A_ID, 'PATCH', '/api/settings', { promptpay_id: '0800000001' })).status, 200)
    const today = (await api(B_ID, 'GET', '/api/today')).body
    assert.equal(today.net, 34750)
    assert.equal(today.expenses.length, 5)

    // 21:00 job:summary → push ครั้งเดียว ยอดเดียว 34750 + QR ของเอ
    clock.t = at('21:00')
    await runSummary(ctx)
    out = line.take()
    assert.equal(out.length, 1)
    assert.equal(out[0].kind, 'push')
    const summary = out[0].messages[0] as any
    assert.match(summary.altText, /บี โอนให้ เอ ฿347\.50/)
    assert.match(json(out), /จาก 5 รายการ/)
    const qrPath = new URL(summary.contents.hero.url).pathname
    const png = await fetch(srv.base + qrPath)
    assert.equal(png.status, 200)
    assert.equal(await decodeQr(Buffer.from(await png.arrayBuffer())), promptpayPayload('0800000001', 34750))
    assert.equal(repo.summary(couple.id, '2026-09-29')!.net_satang, 34750)

    // รันซ้ำ → ไม่ส่งซ้ำ
    await runSummary(ctx)
    assert.equal(line.outbox.length, 0)

    // 21:05 บีส่งสลิปโอน 347.50 → ปิดยอด
    clock.t = at('21:05')
    out = await hook(ev.image(B_ID, 'slip-settle'))
    assert.match(json(out), /รับโอน บี → เอ ฿347\.50/)
    assert.match(json(out), /เคลียร์แล้ว/)
    assert.equal(repo.summary(couple.id, '2026-09-29')!.settled, 1)

    // ส่งสลิปเดิมซ้ำ → จับได้
    out = await hook(ev.image(A_ID, 'slip-settle'))
    assert.match(json(out), /สลิปนี้บันทึกแล้วเมื่อ 21:05/)

    // วันถัดไปเริ่มที่ 0
    clock.t = at('09:00', '2026-09-30')
    const next = (await api(A_ID, 'GET', '/api/today')).body
    assert.deepEqual([next.day, next.net, next.carried_in, next.pending], ['2026-09-30', 0, 0, null])
    out = await hook(ev.text(A_ID, 'สรุป'))
    assert.match(json(out), /ไม่มีใครติดใคร/)
    const h = (await (await fetch(`${srv.base}/healthz`)).json()) as any
    assert.equal(h.stale, false)
  } finally {
    await srv.close()
  }
})
