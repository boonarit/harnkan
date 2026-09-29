import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { slipVerify } from 'promptparse/generate'
import { handlers } from '../src/bot.ts'
import { handleEvent } from '../src/line/router.ts'
import { decodeQr, readSlipQr } from '../src/slip/qr.ts'
import { makeSlipPng } from './fixtures/make-slip.ts'
import { SYNTHETIC_DIR } from './fixtures/make-slips.ts'
import { A_ID, B_ID, ev, makeCtx } from './helpers/app.ts'

test('ถอด transRef จากรูปสลิปสังเคราะห์ที่สร้างในเทสต์', async () => {
  const png = await makeSlipPng({ title: 'FAKE BANK', lines: ['90.00 THB'], qr: slipVerify({ sendingBank: '006', transRef: 'FAKETEST0042' }) })
  assert.deepEqual(await readSlipQr(png), { payload: slipVerify({ sendingBank: '006', transRef: 'FAKETEST0042' }), sendingBank: '006', transRef: 'FAKETEST0042' })
})

test('fixture ใน test/fixtures/synthetic อ่านได้', async () => {
  const r = await readSlipQr(readFileSync(join(SYNTHETIC_DIR, 'slip-settle.png')))
  assert.equal(r?.transRef, 'FAKESETTLE0001')
  assert.equal(r?.sendingBank, '014')
})

test('รูปไม่มี QR / ไม่ใช่รูป / QR ที่ไม่ใช่สลิป → null ไม่พัง', async () => {
  assert.equal(await readSlipQr(readFileSync(join(SYNTHETIC_DIR, 'slip-sunscreen.png'))), null)
  assert.equal(await readSlipQr(Buffer.from('not an image')), null)
  assert.equal(await decodeQr(Buffer.alloc(0)), null)
  const other = await makeSlipPng({ title: 'X', lines: [], qr: 'https://example.com' })
  assert.equal(await decodeQr(other), 'https://example.com')
  assert.equal(await readSlipQr(other), null)
})

test('ส่งสลิปซ้ำ → "สลิปนี้บันทึกแล้วเมื่อ HH:MM" · รูปเก็บใน DATA_DIR/slips', async () => {
  const { ctx, repo, line, clock, dir } = makeCtx({ now: Date.parse('2026-09-29T21:05:00+07:00') })
  const send = (e: any) => handleEvent(ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  line.take()
  await send(ev.image(B_ID, 'slip-settle'))
  const couple = repo.allCouples()[0]
  const slip = repo.slipByTransRef('FAKESETTLE0001')!
  assert.ok(slip)
  assert.match(slip.image_path!, new RegExp(`^slips/${couple.id}/2026-09/[0-9a-f-]{36}\\.png$`))
  assert.ok(existsSync(join(dir, slip.image_path!)))
  line.take()

  clock.t += 3600_000
  await send(ev.image(A_ID, 'slip-settle'))
  const out = line.take()
  assert.equal(out.length, 1)
  assert.match(JSON.stringify(out[0].messages), /สลิปนี้บันทึกแล้วเมื่อ 21:05/)
  assert.equal((repo.db.prepare('SELECT COUNT(*) AS n FROM slips').get() as any).n, 1)
})
