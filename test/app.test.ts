import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiAdapter, ApiError, LocalAdapter } from '../public/app/data/adapter.js'
import { chipToMode, esc, modeLabel, modeToChip, monthGrid, netSentence, preview, shiftMonth, thaiDate, thaiMonth } from '../public/app/format.js'
import { makeServer } from '../src/server.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'
import { handleEvent } from '../src/line/router.ts'
import { handlers } from '../src/bot.ts'

const members = [{ id: 1, display_name: 'เอ' }, { id: 2, display_name: 'บี' }]

test('format: วันที่ เดือน ปฏิทิน', () => {
  assert.equal(thaiDate('2026-09-29'), '29 ก.ย.')
  assert.equal(thaiMonth('2026-09'), 'กันยายน 2569')
  assert.equal(shiftMonth('2026-12', 1), '2027-01')
  assert.equal(shiftMonth('2026-01', -1), '2025-12')
  const g = monthGrid('2026-09')
  assert.deepEqual(g[0], [null, null, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'])
  assert.equal(g.length, 5)
  assert.deepEqual(g.at(-1), ['2026-09-27', '2026-09-28', '2026-09-29', '2026-09-30', null, null, null])
  assert.equal(monthGrid('2026-02').flat().filter(Boolean).length, 28)
})

test('format: ประโยคยอด โหมดหาร พรีวิว escape', () => {
  assert.equal(netSentence(34750, members), 'บี โอนให้ เอ')
  assert.equal(netSentence(-100, members), 'เอ โอนให้ บี')
  assert.equal(netSentence(0, members), 'ไม่มีใครติดใคร')
  assert.equal(chipToMode('1', 0), 'theirs')
  assert.equal(chipToMode('1', 1), 'mine')
  for (const payer of [0, 1] as const) for (const chip of ['half', '0', '1', 'treat'] as const) assert.equal(modeToChip(chipToMode(chip, payer), payer), chip)
  assert.equal(modeLabel({ split_mode: 'theirs', payer: 0 }, members), 'ของบี')
  assert.deepEqual(preview({ amount: 9000, payer: 0, mode: 'half', net: 0 }), { shares: [4500, 4500], effect: 4500, net: 4500 })
  assert.equal(preview({ amount: 35900, payer: 0, mode: 'theirs', net: 4500 }).net, 40400)
  assert.equal(esc('<img src=x onerror="a">&'), '&lt;img src=x onerror=&quot;a&quot;&gt;&amp;')
})

test('ApiAdapter: ส่ง Bearer token + couple + JSON · error เป็น ApiError', async () => {
  const calls: any[] = []
  const fetchFn = async (url: string, init: any) => {
    calls.push({ url, init })
    if (url.includes('/expenses/9')) return new Response(JSON.stringify({ error: 'ไม่พบรายการ' }), { status: 404, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ ok: 1 }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const api = new ApiAdapter({ getToken: async () => 'tok', fetch: fetchFn as any, couple: 3 })
  await api.addExpense({ amount: 9000 })
  assert.equal(calls[0].url, '/api/expenses?couple=3')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer tok')
  assert.deepEqual(JSON.parse(calls[0].init.body), { amount: 9000 })
  await api.days('2026-09')
  assert.equal(calls[1].url, '/api/days?month=2026-09&couple=3')
  await assert.rejects(api.updateExpense(9, { merchant: 'x' }), (e: any) => e instanceof ApiError && e.status === 404 && e.message === 'ไม่พบรายการ')
})

test('ApiAdapter กับ server จริง (fake auth)', async () => {
  const t = makeCtx({ now: Date.parse('2026-09-29T12:00:00+07:00') })
  for (const [u, x] of [[A_ID, 'หวัดดี'], [B_ID, 'หวัดดี'], [A_ID, 'กาแฟ 90']]) await handleEvent(t.ctx, ev.text(u, x), handlers)
  const srv = await listen(makeServer(t.ctx))
  try {
    const api = new ApiAdapter({ getToken: async () => `fake:${B_ID}`, base: srv.base })
    assert.equal((await api.me()).members.length, 2)
    const e = (await api.addExpense({ amount: 24000, merchant: 'ข้าว' })).expense
    assert.equal((await api.today()).net, 4500 - 12000)
    await api.updateExpense(e.id, { split_mode: 'treat' })
    assert.equal((await api.today()).net, 4500)
  } finally {
    await srv.close()
  }
})

test('LocalAdapter: เก็บใน storage · เพิ่ม/แก้/ลบ · ยอดวันนี้', async () => {
  const store = new Map<string, string>()
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) }
  const seed = () => ({
    members: [{ id: 1, display_name: 'เอ', promptpay_id: '0800000001', bank_names: [] }, { id: 2, display_name: 'บี', promptpay_id: '0800000002', bank_names: [] }],
    settings: { settle_time: '21:00', min_transfer: 5000, default_split: 'half', ai_daily_cap: 30, slip_retention_days: 365 },
    expenses: [], settlements: [], settled_days: [], audit: [], seq: 0, me: 1,
  })
  const now = () => Date.parse('2026-09-29T12:00:00+07:00')
  const api = new LocalAdapter({ storage, seed, now })
  const { expense } = await api.addExpense({ amount: 9000, merchant: 'กาแฟ' })
  assert.equal((await api.today()).net, 4500)
  await api.updateExpense(expense.id, { split_mode: 'theirs' })
  assert.equal((await api.today()).net, 9000)
  // โหลดใหม่จาก storage ได้ state เดิม
  const again = new LocalAdapter({ storage, seed, now })
  assert.equal((await again.today()).net, 9000)
  assert.equal((await again.today()).pending!.promptpay_id, '0800000001')
  await again.deleteExpense(expense.id)
  assert.equal((await again.today()).net, 0)
  assert.equal((await again.today()).pending, null)
  await assert.rejects(again.addExpense({ amount: 1.5 }))
  assert.deepEqual((await again.expense(expense.id)).audit.map((a: any) => a.action), ['create', 'update', 'delete'])
  again.reset()
  assert.equal((await again.today()).expenses.length, 0)
})

test('static: /app/ /domain/ เสิร์ฟได้ · path traversal → 404', async () => {
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx))
  try {
    const get = (p: string) => fetch(srv.base + p, { redirect: 'manual' })
    const idx = await get('/app/')
    assert.equal(idx.status, 200)
    assert.match(idx.headers.get('content-type')!, /text\/html/)
    assert.match(await idx.text(), /importmap/)
    assert.match((await get('/app/main.js')).headers.get('content-type')!, /javascript/)
    assert.equal((await get('/domain/money.js')).status, 200)
    assert.equal((await get('/')).status, 302)
    assert.deepEqual(await (await get('/app/config.json')).json(), { liffId: '', fake: true, version: (await import('../src/static.ts')).assetVersion() })
    for (const p of ['/app/../package.json', '/app/%2e%2e/package.json', '/domain/../config.ts', '/domain/..%2Fconfig.ts', '/app/data/../../../src/config.ts', '/app/missing.js', '/domain/parse.ts'])
      assert.equal((await get(p)).status, 404, p)
  } finally {
    await srv.close()
  }
})

test('static: path traversal แบบ raw (ไม่ผ่าน URL normalize) → 404', async () => {
  const { request } = await import('node:http')
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx))
  const raw = (path: string) => new Promise<number>((ok, fail) => {
    const u = new URL(srv.base)
    const r = request({ host: u.hostname, port: u.port, path, method: 'GET' }, (res) => { res.resume(); ok(res.statusCode!) })
    r.on('error', fail)
    r.end()
  })
  try {
    assert.equal(await raw('/app/../../package.json'), 404)
    assert.equal(await raw('/app/../../.env.example'), 404)
    assert.equal(await raw('/app/data/../../../src/config.json'), 404)
    assert.equal(await raw('/app/index.html'), 200)
  } finally {
    await srv.close()
  }
})

test('serveStatic: กัน .. แม้ path ไม่ถูก normalize มาก่อน', async () => {
  const { serveStatic } = await import('../src/static.ts')
  const call = (p: string) => {
    let status = 0
    const res: any = { writeHead: (s: number) => { status = s }, end: () => {} }
    serveStatic(res, p)
    return status
  }
  assert.equal(call('/app/../../package.json'), 404)
  assert.equal(call('/app/data/../../../src/config.json'), 404)
  assert.equal(call('/domain/../domain/money.js'), 404)
  assert.equal(call('/app/index.html'), 200)
})
