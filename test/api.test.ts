import { test } from 'node:test'
import assert from 'node:assert/strict'
import { handlers } from '../src/bot.ts'
import { handleEvent } from '../src/line/router.ts'
import { promptpayPayload } from '../src/promptpay/qr.ts'
import { makeServer } from '../src/server.ts'
import { decodeQr } from '../src/slip/qr.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'

const at = (hm: string) => Date.parse(`2026-09-29T${hm}:00+07:00`)
const C_ID = 'U_fake_c'
const D_ID = 'U_fake_d'

async function setup() {
  const t = makeCtx({ now: at('08:00') })
  t.line.profiles.set(C_ID, 'ซี')
  t.line.profiles.set(D_ID, 'ดี')
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  for (const [u, txt] of [[A_ID, 'หวัดดี'], [B_ID, 'หวัดดี'], [A_ID, 'กาแฟ 2 แก้ว 90'], [B_ID, 'ข้าวกลางวัน 240'], [A_ID, '7-Eleven 127'], [A_ID, 'ครีมกันแดดของบี 359'], [B_ID, 'ข้าวเย็น 420 เลี้ยง']]) await send(ev.text(u, txt))
  await send(ev.image(A_ID, 'slip-coffee'))
  // คู่ที่สอง
  const other = (u: string, text: string) => ({ ...ev.text(u, text), source: { type: 'group' as const, groupId: 'C_fake_group2', userId: u } })
  for (const [u, txt] of [[C_ID, 'หวัดดี'], [D_ID, 'หวัดดี'], [C_ID, 'ชานม 60']]) await send(other(u, txt))
  const srv = await listen(makeServer(t.ctx))
  const call = async (token: string | null, method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.base + path, {
      method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    })
    const ct = res.headers.get('content-type') ?? ''
    return { status: res.status, body: ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer()), headers: res.headers }
  }
  const couple = t.repo.coupleByGroup('C_fake_group')!
  const couple2 = t.repo.coupleByGroup('C_fake_group2')!
  return { ...t, srv, call, couple, couple2, A: `fake:${A_ID}`, B: `fake:${B_ID}`, C: `fake:${C_ID}` }
}

test('auth: ไม่มี token 401 · token มั่ว 401 · ไม่ได้อยู่กลุ่มไหน 403', async () => {
  const { srv, call } = await setup()
  try {
    assert.equal((await call(null, 'GET', '/api/today')).status, 401)
    assert.equal((await call('garbage', 'GET', '/api/today')).status, 401)
    assert.equal((await call('fake:U_fake_zzz', 'GET', '/api/today')).status, 403)
  } finally {
    await srv.close()
  }
})

test('GET /api/today · /api/me · /api/days', async () => {
  const { srv, call, couple } = await setup()
  try {
    const t = await call(`fake:${B_ID}`, 'GET', '/api/today')
    assert.equal(t.status, 200)
    assert.equal(t.body.day, '2026-09-29')
    assert.equal(t.body.expenses.length, 6)
    assert.equal(t.body.net, 34750 + 4500)
    assert.equal(t.body.pending.amount, 39250)
    const me = await call(`fake:${B_ID}`, 'GET', '/api/me')
    assert.equal(me.body.couple_id, couple.id)
    assert.deepEqual(me.body.members.map((m: any) => m.display_name), ['เอ', 'บี'])
    assert.equal(me.body.settings.min_transfer, 5000)
    const days = await call(`fake:${A_ID}`, 'GET', '/api/days?month=2026-09')
    assert.deepEqual(days.body.days, [{ date: '2026-09-29', bills: 6, spent: 132600, net: 39250, action: null, settled: false }])
    assert.equal((await call(`fake:${A_ID}`, 'GET', '/api/days?month=2026-13')).status, 400)
    assert.equal((await call(`fake:${A_ID}`, 'GET', '/api/days/2026-09-29')).body.expenses.length, 6)
  } finally {
    await srv.close()
  }
})

test('สิทธิ์: คนต่าง couple เข้าไม่ได้ = 404 ทุก endpoint ที่มี id', async () => {
  const { srv, call, repo, couple, C } = await setup()
  try {
    const e = repo.expensesByDay(couple.id, '2026-09-29')[0]
    const slipId = repo.expensesByDay(couple.id, '2026-09-29').find((x) => x.slip_id)!.slip_id!
    assert.equal((await call(C, 'GET', `/api/expenses/${e.id}`)).status, 404)
    assert.equal((await call(C, 'PATCH', `/api/expenses/${e.id}`, { split_mode: 'mine' })).status, 404)
    assert.equal((await call(C, 'DELETE', `/api/expenses/${e.id}`)).status, 404)
    assert.equal((await call(C, 'GET', `/api/slips/${slipId}/image`)).status, 404)
    assert.equal(repo.expense(e.id)!.split_mode, 'half')
    assert.equal(repo.expense(e.id)!.status, 'active')
    // คนในคู่เห็นของตัวเองได้
    const img = await call(`fake:${B_ID}`, 'GET', `/api/slips/${slipId}/image`)
    assert.equal(img.status, 200)
    assert.equal(img.headers.get('content-type'), 'image/png')
    // today ของ C เห็นแค่คู่ของ C
    const t = await call(C, 'GET', '/api/today')
    assert.deepEqual(t.body.expenses.map((x: any) => x.merchant), ['ชานม'])
  } finally {
    await srv.close()
  }
})

test('PATCH / DELETE มี audit_log พร้อม member_id · POST เพิ่มเอง', async () => {
  const { srv, call, repo, couple, B } = await setup()
  try {
    const b = repo.memberByLineUser(couple.id, B_ID)!
    const e = repo.expensesByDay(couple.id, '2026-09-29')[0]
    const p = await call(B, 'PATCH', `/api/expenses/${e.id}`, { split_mode: 'theirs', merchant: 'กาแฟเย็น', amount: 10000 })
    assert.equal(p.status, 200)
    assert.deepEqual([p.body.expense.split_mode, p.body.expense.merchant, p.body.expense.amount, p.body.expense.effect], ['theirs', 'กาแฟเย็น', 10000, 10000])
    let log = repo.auditFor('expense', e.id)
    assert.deepEqual([log.at(-1)!.action, log.at(-1)!.member_id], ['update', b.id])
    const d = await call(B, 'DELETE', `/api/expenses/${e.id}`)
    assert.equal(d.body.expense.status, 'deleted')
    log = repo.auditFor('expense', e.id)
    assert.deepEqual([log.at(-1)!.action, log.at(-1)!.member_id], ['delete', b.id])
    assert.equal((await call(B, 'DELETE', `/api/expenses/${e.id}`)).status, 404)
    const c = await call(B, 'POST', '/api/expenses', { merchant: 'ค่าน้ำ', amount: 30000, split_mode: 'half' })
    assert.equal(c.status, 201)
    assert.deepEqual([c.body.expense.paid_by, c.body.expense.source, c.body.expense.shares], [b.id, 'manual', [15000, 15000]])
    assert.equal(repo.auditFor('expense', c.body.expense.id)[0].action, 'create')
  } finally {
    await srv.close()
  }
})

test('validate input: 400 เมื่อชนิด/ค่า/field ผิด · body ใหญ่ 413', async () => {
  const { srv, call, repo, couple, couple2, B } = await setup()
  try {
    const e = repo.expensesByDay(couple.id, '2026-09-29')[0]
    const other = repo.members(couple2.id)[0]
    const bads: [string, string, unknown][] = [
      ['POST', '/api/expenses', { amount: 90.5 }],
      ['POST', '/api/expenses', { amount: -100 }],
      ['POST', '/api/expenses', { amount: '100' }],
      ['POST', '/api/expenses', { amount: 100, split_mode: 'weird' }],
      ['POST', '/api/expenses', { amount: 100, paid_by: other.id }],
      ['POST', '/api/expenses', { amount: 100, merchant: 'x'.repeat(61) }],
      ['POST', '/api/expenses', 'not json'],
      ['POST', '/api/expenses', [1, 2]],
      ['PATCH', `/api/expenses/${e.id}`, { status: 'deleted' }],
      ['PATCH', `/api/expenses/${e.id}`, {}],
      ['PATCH', `/api/expenses/${e.id}`, { merchant: 'ok', couple_id: 999 }],
      ['PATCH', `/api/expenses/${e.id}`, { ratio: 101 }],
      ['PATCH', '/api/settings', { settle_time: '25:00' }],
      ['PATCH', '/api/settings', { promptpay_id: '12345' }],
      ['PATCH', '/api/settings', { min_transfer: 1.5 }],
      ['PATCH', '/api/settings', { couple_id: 9 }],
    ]
    for (const [m, p, b] of bads) assert.equal((await call(B, m, p, b)).status, 400, `${m} ${p} ${JSON.stringify(b)}`)
    assert.equal((await call(B, 'POST', '/api/expenses', { merchant: 'x'.repeat(20_000), amount: 1 })).status, 413)
    assert.equal(repo.expense(e.id)!.merchant, e.merchant, 'body ที่มี field ต้องห้ามต้องไม่แก้อะไรเลย')
  } finally {
    await srv.close()
  }
})

test('ตั้งค่าเก็บใน DB แก้ได้โดยไม่แก้โค้ด + audit · QR เคลียร์ยอดใช้เบอร์คนรับ', async () => {
  const { srv, call, repo, couple, A, B } = await setup()
  try {
    const r = await call(A, 'PATCH', '/api/settings', { min_transfer: 10000, settle_time: '22:00', default_split: 'mine', ai_daily_cap: 5, slip_retention_days: 90, promptpay_id: '080-000-0001', bank_names: ['เอ สมมติ'] })
    assert.equal(r.status, 200)
    assert.deepEqual(r.body.settings, { settle_time: '22:00', min_transfer: 10000, default_split: 'mine', ai_daily_cap: 5, slip_retention_days: 90, stale_slip_hours: 24, pending_answer_hours: 24, dup_window_minutes: 10 })
    assert.equal(repo.couple(couple.id)!.min_transfer, 10000)
    assert.equal(repo.memberByLineUser(couple.id, A_ID)!.promptpay_id, '0800000001')
    assert.equal(repo.auditFor('couple', couple.id).at(-1)!.action, 'settings')
    const qr = await call(B, 'GET', '/api/settle/qr.png')
    assert.equal(qr.status, 200)
    assert.equal(await decodeQr(qr.body as Buffer), promptpayPayload('0800000001', 39250))
  } finally {
    await srv.close()
  }
})
