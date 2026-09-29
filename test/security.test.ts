import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { handlers } from '../src/bot.ts'
import { runSummary } from '../src/jobs/summary.ts'
import { handleEvent } from '../src/line/router.ts'
import { clientIp, RateLimiter } from '../src/security.ts'
import { makeServer } from '../src/server.ts'
import { A_ID, B_ID, ev, listen, makeCtx, postWebhook } from './helpers/app.ts'

test('rate limit ต่อ IP บน /api และ /webhook → 429 + Retry-After', async () => {
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx, handlers, { api: 3, webhook: 2 }))
  try {
    const api = (ip?: string) => fetch(`${srv.base}/api/me`, { headers: { authorization: 'Bearer x', ...(ip ? { 'cf-connecting-ip': ip } : {}) } })
    const codes = []
    for (let i = 0; i < 4; i++) codes.push((await api('203.0.113.1')).status)
    assert.deepEqual(codes, [401, 401, 401, 429])
    const r = await api('203.0.113.1')
    assert.ok(Number(r.headers.get('retry-after')) > 0)
    assert.equal((await api('203.0.113.2')).status, 401, 'IP อื่นไม่โดนด้วย')
    const w = []
    for (let i = 0; i < 3; i++) w.push((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [])).status)
    assert.deepEqual(w, [200, 200, 429])
    assert.equal((await fetch(`${srv.base}/healthz`)).status, 200, 'healthz ไม่นับ')
  } finally {
    await srv.close()
  }
})

test('clientIp: เชื่อ CF-Connecting-IP เฉพาะจาก loopback', () => {
  const req = (remote: string, cf?: string) => ({ socket: { remoteAddress: remote }, headers: cf ? { 'cf-connecting-ip': cf } : {} }) as any
  assert.equal(clientIp(req('127.0.0.1', '198.51.100.7')), '198.51.100.7')
  assert.equal(clientIp(req('192.0.2.9', '198.51.100.7')), '192.0.2.9')
  assert.equal(clientIp(req('127.0.0.1', 'evil<script>')), '127.0.0.1')
  const rl = new RateLimiter(2, 1000)
  assert.deepEqual([rl.take('a', 0), rl.take('a', 1), rl.take('a', 2) > 0, rl.take('a', 1001)], [0, 0, true, 0])
})

test('webhook: event รูปร่างผิดถูกข้าม ไม่ทำ server ล้ม · events ไม่ใช่ array = 400', async () => {
  const { ctx, repo } = makeCtx()
  const srv = await listen(makeServer(ctx, handlers))
  try {
    const bad: any[] = [null, 1, 'x', { type: 5 }, { type: 'message', source: 'nope' }, { type: 'message', message: { id: 1, type: 'text' } },
      { ...ev.text(A_ID, 'x'.repeat(6000)) }, { type: 'postback', source: { type: 'group', groupId: 'C_fake_group', userId: A_ID }, postback: { data: 'x'.repeat(400) } }]
    assert.equal((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, bad)).status, 200)
    assert.equal(repo.allCouples().length, 0)
    assert.equal((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, { not: 'array' } as any)).status, 400)
    assert.equal((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [ev.text(A_ID, 'หวัดดี')])).status, 200)
    assert.equal(repo.allCouples().length, 1)
  } finally {
    await srv.close()
  }
})

test('header ความปลอดภัย + CSP ของหน้าแอปมี hash ของ import map', async () => {
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx, handlers))
  try {
    const j = await fetch(`${srv.base}/healthz`)
    assert.equal(j.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(j.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(j.headers.get('x-frame-options'), 'DENY')
    const h = await fetch(`${srv.base}/app/`)
    const csp = h.headers.get('content-security-policy')!
    const html = await h.text()
    const map = html.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]
    assert.ok(csp.includes(`'sha256-${createHash('sha256').update(map).digest('base64')}'`))
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /script-src 'self' https:\/\/static\.line-scdn\.net/)
    assert.ok(!csp.includes('unsafe-inline'))
  } finally {
    await srv.close()
  }
})

async function coupleWithData() {
  const t = makeCtx({ now: Date.parse('2026-09-29T19:00:00+07:00') })
  t.line.profiles.set('U_fake_c', 'ซี')
  t.line.profiles.set('U_fake_d', 'ดี')
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  for (const [u, x] of [[A_ID, 'หวัดดี'], [B_ID, 'หวัดดี'], [A_ID, 'กาแฟ 90']]) await send(ev.text(u, x))
  await send(ev.image(A_ID, 'slip-sunscreen'))
  const couple = t.repo.coupleByGroup('C_fake_group')!
  t.repo.updateMember(t.repo.members(couple.id)[0].id, { promptpay_id: '0800000001' })
  t.clock.t = Date.parse('2026-09-29T21:00:00+07:00')
  await runSummary(t.ctx)
  // อีกคู่ที่ต้องไม่โดนลบ
  const other = (u: string, text: string) => ({ ...ev.text(u, text), source: { type: 'group' as const, groupId: 'C_fake_group2', userId: u } })
  for (const [u, x] of [['U_fake_c', 'หวัดดี'], ['U_fake_d', 'หวัดดี'], ['U_fake_c', 'ชา 50']]) await send(other(u, x))
  t.line.take()
  return { ...t, send, couple }
}

const TABLES = ['members', 'expenses', 'slips', 'settlements', 'daily_summaries', 'adjustments', 'audit_log']
const countFor = (repo: any, coupleId: number) => Object.fromEntries(TABLES.map((tb) => [tb, (repo.db.prepare(`SELECT COUNT(*) AS n FROM ${tb} WHERE couple_id = ?`).get(coupleId) as any).n]))

test('"ลบข้อมูลทั้งหมด": ยืนยัน 2 ขั้น → ลบ couple ทุกตาราง + รูป + QR · คู่อื่นไม่โดน', async () => {
  const { send, line, repo, couple, dir } = await coupleWithData()
  const qrToken = repo.summary(couple.id, '2026-09-29')!.qr_token!
  const other = repo.coupleByGroup('C_fake_group2')!
  const otherBefore = countFor(repo, other.id)
  assert.ok(existsSync(join(dir, 'slips', String(couple.id))))
  assert.ok(existsSync(join(dir, 'qr', `${qrToken}.png`)))

  await send(ev.text(B_ID, 'ลบข้อมูลทั้งหมด'))
  const step1 = line.take()[0].messages[0] as any
  assert.match(step1.text, /กู้คืนไม่ได้/)
  const [yes1] = step1.quickReply.items.map((i: any) => i.action.data)
  // ข้ามขั้นไม่ได้
  await send(ev.postback(A_ID, yes1.replace('wipe:1', 'wipe:2')))
  assert.match(line.texts()[0], /ตามลำดับ/)
  assert.equal(repo.coupleByGroup('C_fake_group')?.id, couple.id)
  line.take()

  await send(ev.text(B_ID, 'ลบข้อมูลทั้งหมด'))
  const again = (line.take()[0].messages[0] as any).quickReply.items[0].action.data
  await send(ev.postback(A_ID, again))
  const step2 = line.take()[0].messages[0] as any
  assert.match(step2.text, /ยืนยันครั้งสุดท้าย/)
  await send(ev.postback(A_ID, step2.quickReply.items[0].action.data))
  assert.match(line.texts()[0], /ลบข้อมูลทั้งหมดของกลุ่มนี้แล้ว/)

  assert.equal(repo.coupleByGroup('C_fake_group'), undefined)
  assert.deepEqual(countFor(repo, couple.id), Object.fromEntries(TABLES.map((t) => [t, 0])))
  assert.equal((repo.db.prepare('SELECT COUNT(*) AS n FROM expense_shares WHERE expense_id NOT IN (SELECT id FROM expenses)').get() as any).n, 0)
  assert.ok(!existsSync(join(dir, 'slips', String(couple.id))))
  assert.ok(!existsSync(join(dir, 'qr', `${qrToken}.png`)))
  assert.deepEqual(countFor(repo, other.id), otherBefore)
  assert.deepEqual(repo.db.prepare('PRAGMA foreign_key_check').all(), [])
})

test('ลบข้อมูล: กดไม่ลบ / ปุ่มหมดอายุ / nonce ปลอม → ข้อมูลอยู่ครบ', async () => {
  const { send, line, repo, couple, clock } = await coupleWithData()
  const before = countFor(repo, couple.id)
  await send(ev.text(A_ID, 'ลบข้อมูลทั้งหมด'))
  const items = (line.take()[0].messages[0] as any).quickReply.items.map((i: any) => i.action.data)
  await send(ev.postback(B_ID, items[1]))
  assert.match(line.texts()[0], /ยกเลิกแล้ว/)
  line.take()
  await send(ev.text(A_ID, 'ลบข้อมูลทั้งหมด'))
  const yes = (line.take()[0].messages[0] as any).quickReply.items[0].action.data
  await send(ev.postback(A_ID, 'wipe:1:AAAAAAAA'))
  assert.match(line.texts()[0], /หมดอายุ/)
  line.take()
  await send(ev.text(A_ID, 'ลบข้อมูลทั้งหมด'))
  const yes2 = (line.take()[0].messages[0] as any).quickReply.items[0].action.data
  clock.t += 6 * 60_000
  await send(ev.postback(A_ID, yes2))
  assert.match(line.texts()[0], /หมดอายุ/)
  assert.notEqual(yes, yes2)
  assert.deepEqual(countFor(repo, couple.id), before)
})

test('PRIVACY.md มีหัวข้อ เก็บอะไร / เก็บที่ไหน / ลบอย่างไร', () => {
  const p = readFileSync(join(import.meta.dirname, '../docs/PRIVACY.md'), 'utf8')
  for (const h of ['เก็บอะไร', 'เก็บที่ไหน', 'ลบอย่างไร']) assert.match(p, new RegExp(h))
  assert.match(p, /ลบข้อมูลทั้งหมด/)
})
