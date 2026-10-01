// B18: ปัญหาหลัง deploy B17 (การ์ดตั้งค่า · แคช mini app · token LIFF) + ปุ่มเปิดแอป · เตือนรายการซ้ำ · ชื่อสมาชิก · เลขบัญชีแทนพร้อมเพย์
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { handlers } from '../src/bot.ts'
import { LineIdTokenVerifier } from '../src/api/auth.ts'
import { initLog } from '../src/log.ts'
import { makeServer } from '../src/server.ts'
import { assetVersion, renderIndex } from '../src/static.ts'
import { ApiAdapter } from '../public/app/data/adapter.js'
import { GIVE_UP_MSG, LiffSession, needsReload, RELOGIN_KEY } from '../public/app/session.js'
import { tmpDir } from './helpers/db.ts'
import { handleEvent } from '../src/line/router.ts'
import type { OutboxItem } from '../src/line/client.ts'
import { normalize, type SlipAi } from '../src/slip/vision.ts'
import { makeSlipPng } from './fixtures/make-slip.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'

const DAY = '2026-09-29'
const at = (hm: string, day = DAY) => Date.parse(`${day}T${hm}:00+07:00`)
const txt = (out: OutboxItem[]) => JSON.stringify(out.map((o) => o.messages))
/** บรรทัดในการ์ดตั้งค่า (flex body) */
const cardLines = (out: OutboxItem[]) => out.flatMap((o) => o.messages).filter((m: any) => m.type === 'flex')
  .flatMap((m: any) => m.contents.body.contents.map((c: any) => c.text).filter(Boolean)) as string[]

async function setup(env: Record<string, string> = {}) {
  const t = makeCtx({ now: at('10:00'), env })
  const send = async (e: any) => (await handleEvent(t.ctx, e, handlers), t.line.take())
  return { ...t, send }
}

// ---------- 3. การ์ดตั้งค่า ----------
test('การ์ดตั้งค่า (B18-3): หลังลบทั้งหมด → ไม่มี ✓ ในชื่อบัญชี/พร้อมเพย์ · ตั้งแล้ว → ✓ · สลิปคู่จับชื่อได้แล้ว → ✓ · ตัวอย่างคำสั่ง ตั้งชื่อ <ชื่อเล่น>', async () => {
  const t = await setup()
  await t.send(ev.text(A_ID, 'หวัดดี'))
  await t.send(ev.text(B_ID, 'หวัดดี'))
  // ลบทั้งหมดจากแชท แล้วลงทะเบียนใหม่ (เหตุการณ์จริงหลัง deploy B17)
  let out = await t.send(ev.text(A_ID, 'ลบข้อมูลทั้งหมด'))
  const data = (label: string) => (out.flatMap((o) => o.messages).flatMap((m: any) => m.quickReply?.items ?? []).find((i: any) => i.action.label === label) as any).action.data
  out = await t.send(ev.postback(A_ID, data('ใช่ ลบทั้งหมด')))
  out = await t.send(ev.postback(A_ID, data('ลบถาวร')))
  const afterWipe = cardLines(out)
  assert.ok(afterWipe.some((l) => l.startsWith('⚠️') && l.includes('ชื่อต้นตามสลิป')), afterWipe.join('\n'))
  await t.send(ev.text(A_ID, 'หวัดดี'))
  await t.send(ev.text(B_ID, 'หวัดดี'))
  out = await t.send(ev.text(A_ID, 'ตั้งค่า'))
  const lines = cardLines(out)
  const bankLines = lines.filter((l) => l.includes('ชื่อต้นตามสลิป'))
  const ppLines = lines.filter((l) => l.includes('พร้อมเพย์'))
  assert.equal(bankLines.length, 2)
  assert.equal(ppLines.length, 2)
  for (const l of [...bankLines, ...ppLines]) assert.ok(!l.startsWith('✓'), `ยังไม่ได้ตั้งแต่ขึ้น ✓: ${l}`)
  assert.ok(bankLines.every((l) => l.startsWith('⚠️')))
  assert.ok(ppLines.every((l) => l.startsWith('○')))
  assert.ok(lines.some((l) => l.includes('ตั้งชื่อ <ชื่อเล่น>')))
  assert.ok(!lines.some((l) => /ตั้งชื่อ ส้ม/.test(l)))
  assert.match(txt(out), /ยังตั้งค่าไม่ครบ/)

  const couple = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(couple.id)
  t.repo.updateMember(a.id, { bank_names: ['เอ'], promptpay_id: '0800000001' })
  // บี ไม่ได้ตั้งชื่อบัญชี แต่เคยมีสลิปโอนเข้าบีที่จับชื่อได้ตรง (กฎ partner) → ถือว่าตั้งแล้ว
  t.ctx.slips = { read: async () => normalize({ type: 'transfer_slip', amount: 100, confidence: 0.99, datetime: new Date(t.clock.t).toISOString(), sender_name: 'นาย เอ ส.', receiver_name: 'น.ส. บี ส.' } as Partial<SlipAi>) }
  t.line.contents.set('img1', await makeSlipPng({ title: 'FAKE', lines: ['x'] }))
  await t.send(ev.image(A_ID, 'img1'))
  assert.equal(t.repo.settlementsByDay(couple.id, DAY).length, 1)
  out = await t.send(ev.text(A_ID, 'ตั้งค่า'))
  const done = cardLines(out)
  assert.ok(done.filter((l) => l.includes('ชื่อต้นตามสลิป')).every((l) => l.startsWith('✓')), done.join('\n'))
  assert.ok(done.some((l) => l.startsWith('✓ เอ: เบอร์พร้อมเพย์')))
  assert.ok(done.some((l) => l.startsWith('○ บี: เบอร์พร้อมเพย์')))
  assert.match(txt(out), /พร้อมใช้แล้ว/)
  // negative control: สลิปที่แปลงเป็นเคลียร์ยอดด้วยปุ่ม (ชื่อไม่ตรง) ไม่นับว่าจับชื่อได้
  t.repo.db.prepare("UPDATE slips SET rule = 'person'").run()
  assert.equal(t.repo.partnerSlipMatched(b.id), false)
})

// ---------- 4. แคช mini app ----------
const ROOT = join(import.meta.dirname, '..')
function copyApp() {
  const root = tmpDir()
  for (const d of ['public/app', 'src/domain']) {
    mkdirSync(join(root, d), { recursive: true })
    cpSync(join(ROOT, d), join(root, d), { recursive: true })
  }
  return root
}

test('แคช (B18-4): แก้ไฟล์ JS → เวอร์ชันและ URL ใน index.html เปลี่ยน · ทุก module (รวม import แบบ relative และ #domain) มี ?v=', () => {
  const root = copyApp()
  const html = readFileSync(join(root, 'public/app/index.html'), 'utf8')
  const v1 = assetVersion(root)
  const out1 = renderIndex(html, v1, root)
  assert.match(out1, new RegExp(`src="\\./boot\\.js\\?v=${v1}"`))
  assert.match(out1, new RegExp(`href="\\./app\\.css\\?v=${v1}"`))
  assert.match(out1, new RegExp(`<meta name="harnkan-version" content="${v1}">`))
  const map = JSON.parse(out1.match(/<script type="importmap">([\s\S]*?)<\/script>/)![1]).imports
  for (const k of ['/app/main.js', '/app/data/adapter.js', '/app/session.js', '/domain/split.js', '#domain/balance.js']) assert.equal(map[k]?.endsWith(`?v=${v1}`), true, k)
  writeFileSync(join(root, 'public/app/main.js'), readFileSync(join(root, 'public/app/main.js'), 'utf8') + '\n// changed\n')
  const v2 = assetVersion(root)
  assert.notEqual(v2, v1)
  assert.notEqual(renderIndex(html, v2, root), out1)
  writeFileSync(join(root, 'src/domain/money.js'), readFileSync(join(root, 'src/domain/money.js'), 'utf8') + '\n')
  assert.notEqual(assetVersion(root), v2, 'ไฟล์ domain ก็นับ')
})

test('แคช (B18-4): header · index/config no-cache · ไฟล์ที่ ?v= ตรงเวอร์ชัน = แคชยาว · ไม่ตรง/ไม่มี = no-cache · CSP ตรง importmap ใหม่', async () => {
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx))
  try {
    const v = assetVersion()
    const cc = async (p: string) => (await fetch(srv.base + p)).headers.get('cache-control')
    const idx = await fetch(srv.base + '/app/')
    assert.equal(idx.headers.get('cache-control'), 'no-cache')
    const body = await idx.text()
    assert.match(body, new RegExp(`boot\\.js\\?v=${v}`))
    // CSP hash ต้องตรงกับ importmap ที่เขียนใหม่ (ไม่งั้นเบราว์เซอร์บล็อก)
    const { cspFor } = await import('../src/security.ts')
    assert.equal(idx.headers.get('content-security-policy'), cspFor(body))
    assert.equal(await cc('/app/config.json'), 'no-cache')
    assert.equal((await (await fetch(srv.base + '/app/config.json')).json()).version, v)
    assert.equal(await cc(`/app/main.js?v=${v}`), 'public, max-age=31536000, immutable')
    assert.equal(await cc(`/domain/split.js?v=${v}`), 'public, max-age=31536000, immutable')
    assert.equal(await cc('/app/main.js'), 'no-cache')
    assert.equal(await cc('/app/main.js?v=old123'), 'no-cache', 'เวอร์ชันเก่าต้องไม่ถูกแคชยาว')
    assert.equal(await cc(`/app/index.html?v=${v}`), 'no-cache')
  } finally {
    await srv.close()
  }
})

const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), m }
}

test('แคช (B18-4): หน้าเวอร์ชันไม่ตรง server → reload 1 ครั้งต่อเวอร์ชัน ไม่วน', () => {
  const s = mem()
  assert.equal(needsReload('aaa', 'aaa', s), false)
  assert.equal(needsReload('aaa', 'bbb', s), true)
  assert.equal(needsReload('aaa', 'bbb', s), false, 'reload แล้วยังได้หน้าเก่า (แคช) → ไม่วน')
  assert.equal(needsReload('bbb', 'ccc', s), true, 'deploy ครั้งถัดไป reload ได้อีก')
  assert.equal(needsReload(null, 'ccc', s), false)
})

// ---------- 5. token LIFF ----------
function liffStub(opts: { loggedIn?: boolean; exp?: number | null } = {}) {
  const calls: string[] = []
  const liff = {
    loggedIn: opts.loggedIn ?? true,
    isLoggedIn() { return this.loggedIn },
    getDecodedIDToken() { return opts.exp === null ? null : { exp: opts.exp ?? 0 } },
    getIDToken() { calls.push('getIDToken'); return 'tok' },
    logout() { calls.push('logout'); this.loggedIn = false },
    login(o: any) { calls.push(`login:${o?.redirectUri}`) },
  }
  return { liff, calls }
}
const pending = <T>(p: Promise<T>) => Promise.race([p.then(() => 'resolved', (e) => `rejected:${e.message}`), new Promise((r) => setTimeout(() => r('pending'), 30))])
const NOW = Date.parse('2026-09-30T10:00:00Z')

test('token (B18-5): ยังไม่หมดอายุ → ใช้ได้ · หมด/ใกล้หมด → logout + login ใหม่ 1 ครั้ง · กลับมาแล้วยังหมด → ข้อความ ไม่วน', async () => {
  const store = mem()
  const ok = liffStub({ exp: NOW / 1000 + 3600 })
  const fresh = new LiffSession(ok.liff, { storage: store, href: 'https://x/app/#/settings', now: () => NOW })
  assert.equal(await fresh.getToken(), 'tok')
  assert.deepEqual(ok.calls, ['getIDToken'])

  const notes: string[] = []
  const old = liffStub({ exp: NOW / 1000 + 30 }) // เหลือ 30 วิ = ใกล้หมด
  const s1 = new LiffSession(old.liff, { storage: store, href: 'https://x/app/#/settings', now: () => NOW, notify: (m) => notes.push(m) })
  assert.equal(await pending(s1.getToken()), 'pending', 'กำลัง redirect ไป login')
  assert.deepEqual(old.calls, ['logout', 'login:https://x/app/#/settings'])
  assert.match(notes[0], /เซสชันหมดอายุ กำลังเข้าสู่ระบบใหม่/)
  // หน้าโหลดใหม่หลัง login แต่ token ยังหมด (นาฬิกาเพี้ยน ฯลฯ) → ไม่ login ซ้ำ
  const again = liffStub({ exp: 0 })
  const s2 = new LiffSession(again.liff, { storage: store, href: 'https://x/app/', now: () => NOW + 5000 })
  assert.equal(await pending(s2.getToken()), `rejected:${GIVE_UP_MSG}`)
  assert.ok(!again.calls.some((c) => c.startsWith('login')), 'ไม่วน login')
  // เกินช่วงกันวนแล้ว → ลองใหม่ได้
  const later = new LiffSession(liffStub({ exp: 0 }).liff, { storage: store, href: 'https://x/app/', now: () => NOW + 10 * 60_000 })
  assert.equal(await pending(later.getToken()), 'pending')
})

test('token (B18-5): API 401 → login ใหม่ 1 ครั้ง · 401 ครั้งที่สองติดกัน → error ข้อความคนอ่านได้ ไม่วน · ผ่านแล้วล้าง guard', async () => {
  const store = mem()
  const stub = liffStub({ exp: NOW / 1000 + 3600 })
  const mk = () => {
    const s = new LiffSession(stub.liff, { storage: store, href: 'https://x/app/', now: () => NOW })
    return (status: number) => new ApiAdapter({
      getToken: () => s.getToken(), onUnauthorized: () => s.onUnauthorized(), onOk: () => s.onOk(),
      fetch: (async () => new Response(JSON.stringify({ error: 'token ไม่ถูกต้อง' }), { status })) as any,
    })
  }
  assert.equal(await pending(mk()(401).me()), 'pending')
  assert.equal(stub.calls.filter((c) => c.startsWith('login')).length, 1)
  stub.liff.loggedIn = true
  assert.equal(await pending(mk()(401).me()), `rejected:${GIVE_UP_MSG}`)
  assert.equal(stub.calls.filter((c) => c.startsWith('login')).length, 1, 'ไม่วน')
  assert.equal(await pending(mk()(200).me()), 'resolved')
  assert.equal(store.getItem(RELOGIN_KEY), null, 'สำเร็จแล้วล้าง guard')
})

test('token (B18-5) server: ตรวจ aud = LIFF_CHANNEL_ID และ exp จริง · เหตุผลจาก LINE · negative control token ของ channel อื่น → 401 + log เหตุผลไม่มี token', async () => {
  const CH = '1650000000'
  const reply = (status: number, body: object) => (async (_u: any, init: any) => {
    assert.equal(new URLSearchParams(init.body).get('client_id'), CH)
    return new Response(JSON.stringify(body), { status })
  }) as any
  const now = () => NOW
  const v = (st: number, body: object) => new LineIdTokenVerifier(CH, reply(st, body), now).verify('TOKEN-SECRET-XYZ')
  assert.deepEqual(await v(200, { sub: 'U_fake_a', aud: CH, exp: NOW / 1000 + 600 }), { sub: 'U_fake_a' })
  assert.deepEqual(await v(200, { sub: 'U_fake_a', aud: '1650000999', exp: NOW / 1000 + 600 }), { reason: 'bad_aud' })
  assert.deepEqual(await v(200, { sub: 'U_fake_a', aud: CH, exp: NOW / 1000 - 1 }), { reason: 'expired' })
  assert.deepEqual(await v(200, { sub: 'U_fake_a', aud: CH }), { reason: 'expired' }, 'ไม่มี exp = ไม่ผ่าน')
  assert.deepEqual(await v(400, { error: 'invalid_request', error_description: 'IdToken expired.' }), { reason: 'expired' })
  assert.deepEqual(await v(400, { error: 'invalid_request', error_description: 'Invalid IdToken Audience.' }), { reason: 'bad_aud' })
  assert.deepEqual(await v(400, { error: 'invalid_request', error_description: 'Invalid IdToken.' }), { reason: 'invalid' })
  assert.deepEqual(await new LineIdTokenVerifier(CH, (async () => { throw new Error('down') }) as any).verify('x'), { reason: 'unreachable' })

  // ผ่าน server จริง: token channel อื่น → 401 · log มีเหตุผล ไม่มี token
  const dir = tmpDir()
  initLog(dir)
  const { ctx } = makeCtx()
  ctx.verifier = new LineIdTokenVerifier(CH, reply(200, { sub: 'U_fake_a', aud: '1650000999', exp: NOW / 1000 + 600 }))
  const srv = await listen(makeServer(ctx))
  try {
    const r = await fetch(srv.base + '/api/me', { headers: { authorization: 'Bearer TOKEN-SECRET-XYZ' } })
    assert.equal(r.status, 401)
  } finally {
    await srv.close()
  }
  const log = readFileSync(join(dir, 'harnkan.log'), 'utf8')
  assert.match(log, /"event":"auth_fail","path":"\/api\/me","reason":"bad_aud"/)
  assert.ok(!log.includes('TOKEN-SECRET-XYZ'))
})

// ---------- 8. ชื่อ "T" ----------
test('ชื่อสมาชิก (B18-8): ชื่อจากโปรไฟล์ LINE ถูกเก็บครบ (อังกฤษ อีโมจิ สระไทย ช่องว่าง ยาวเกิน) · ตัดที่ 40 ตัวไม่ผ่ากลางอีโมจิ · log แค่ความยาว', async () => {
  const dir = tmpDir()
  initLog(dir)
  const names = ['Tong', 'T', 'Toey 🐰✨', 'ต้นข้าว', '  Tar  Tar  ', 'Tanawat Supersuperlongsurname Nakornratchasima', '🐶'.repeat(45)]
  for (const [i, n] of names.entries()) {
    const t = makeCtx()
    const uid = `U_fake_n${i}`
    t.line.profiles.set(uid, n)
    await handleEvent(t.ctx, { ...ev.text(uid, 'หวัดดี'), source: { type: 'group', groupId: `C_fake_n${i}`, userId: uid } } as any, handlers)
    const [m] = t.repo.members(t.repo.allCouples()[0].id)
    const expected = [...n].slice(0, 40).join('')
    assert.equal(m.display_name, expected, `ชื่อ #${i}`)
    assert.ok(!/[\uD800-\uDBFF]$/.test(m.display_name), 'ไม่ผ่ากลาง surrogate pair')
  }
  // โปรไฟล์ดึงไม่ได้ → ชื่อสำรอง + log เตือน (เดิมเงียบ)
  const t = makeCtx()
  t.line.getGroupMemberProfile = async () => { throw new Error('LINE API 404 /…') }
  await handleEvent(t.ctx, ev.text(A_ID, 'หวัดดี'), handlers)
  assert.equal(t.repo.members(t.repo.allCouples()[0].id)[0].display_name, 'ไม่ทราบชื่อ')
  const log = readFileSync(join(dir, 'harnkan.log'), 'utf8')
  const reg = log.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === 'member_registered')
  assert.deepEqual(reg.map((l) => [l.name_len, l.source]).slice(0, 3), [[4, 'profile'], [1, 'profile'], [7, 'profile']])
  assert.equal(reg.at(-1).source, 'fallback')
  assert.match(log, /"event":"profile_fetch_failed"/)
  for (const n of ['Tong', 'Toey', 'ต้นข้าว', 'Nakornratchasima']) assert.ok(!log.includes(n), `log มีชื่อ ${n}`)
})

// ---------- 6. ปุ่มเปิดแอป ----------
const LIFF = '1650000000-AbCdEfGh'
const uris = (out: OutboxItem[]) => JSON.stringify(out).match(/https:\/\/liff\.line\.me\/[^"]+/g) ?? []

test('ปุ่มเปิดแอป (B18-6): การ์ดรายการ/สรุป/ตั้งค่า + คำสั่ง "แอป" ใช้ LIFF_ID จาก config · ไม่มี LIFF_ID → ไม่มีปุ่ม ไม่พัง', async () => {
  const { runSummary } = await import('../src/jobs/summary.ts')
  for (const liff of [LIFF, '']) {
    const t = await setup(liff ? { LIFF_ID: liff } : {})
    await t.send(ev.text(A_ID, 'หวัดดี'))
    await t.send(ev.text(B_ID, 'หวัดดี'))
    const card = await t.send(ev.text(A_ID, 'กาแฟ 700'))
    const e = t.repo.expensesByDay(t.repo.allCouples()[0].id, DAY)[0]
    const app = await t.send(ev.text(A_ID, 'แอป'))
    const setupCard = await t.send(ev.text(A_ID, 'ตั้งค่า'))
    t.clock.t = at('21:00')
    await runSummary(t.ctx)
    const summary = t.line.take()
    if (liff) {
      assert.ok(uris(card).includes(`https://liff.line.me/${LIFF}/#/e/${e.id}`), uris(card).join())
      assert.ok(uris(app).includes(`https://liff.line.me/${LIFF}/#/`))
      assert.ok(uris(setupCard).includes(`https://liff.line.me/${LIFF}/#/settings`))
      assert.ok(uris(summary).includes(`https://liff.line.me/${LIFF}/#/settle`))
      assert.match(JSON.stringify(card), /ดู\/แก้ในแอป/)
    } else {
      for (const o of [card, app, setupCard, summary]) assert.deepEqual(uris(o), [])
      assert.match(txt(app), /ยังไม่ได้ตั้ง LIFF_ID/)
      assert.match(txt(card), /บันทึกแล้ว/)
      assert.match(txt(summary), /สรุปวันนี้ \(29 ก\.ย\.\)/)
      assert.ok(!JSON.stringify([card, setupCard, summary]).includes('"type":"uri"'), 'ไม่มีปุ่ม uri เลย')
    }
  }
  const src = ['src/bot.ts', 'src/onboard.ts', 'src/jobs/summary.ts', 'src/slip/flow.ts'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join()
  assert.ok(!src.includes('liff.line.me'), 'URL สร้างที่ appUrl() ที่เดียว')
})

// ---------- 7. เตือนรายการที่อาจซ้ำ ----------
test('เตือนซ้ำ (B18-7): คนเดิม ยอดเท่ากัน ภายใน 10 นาที → บันทึกปกติ + ต่อท้ายการ์ด · negative: ต่าง 1 สตางค์ / คนละคน / เกินเวลา / ตั้ง 0 = ปิด', async () => {
  const t = await setup()
  await t.send(ev.text(A_ID, 'หวัดดี'))
  await t.send(ev.text(B_ID, 'หวัดดี'))
  const c = t.repo.allCouples()[0]
  await t.send(ev.text(A_ID, 'กาแฟ 90'))
  t.clock.t += 4 * 60_000
  let out = await t.send(ev.text(A_ID, 'ลาเต้ 90'))
  assert.equal(t.repo.expensesByDay(c.id, DAY).length, 2, 'บันทึกตามปกติ')
  assert.equal(out[0].messages[0].type, 'flex', 'การ์ดมาก่อน คำเตือนต่อท้าย')
  assert.match(txt(out), /ดูเหมือนซ้ำกับ \\"กาแฟ\\" เมื่อ 4 นาทีก่อน · พิมพ์ ยกเลิก ถ้าซ้ำ/)
  // negative controls
  t.clock.t += 60_000
  assert.doesNotMatch(txt(await t.send(ev.text(A_ID, 'ชา 90.01'))), /ดูเหมือนซ้ำ/, 'ต่าง 1 สตางค์')
  assert.doesNotMatch(txt(await t.send(ev.text(B_ID, 'ชา 90'))), /ดูเหมือนซ้ำ/, 'คนละคน')
  t.clock.t += 11 * 60_000
  assert.doesNotMatch(txt(await t.send(ev.text(A_ID, 'ขนม 90.01'))), /ดูเหมือนซ้ำ/, 'เกิน 10 นาที')
  // ตั้ง 0 = ปิด: แม้ซ้ำในวินาทีเดียวกันก็ไม่เตือน
  t.repo.updateCouple(c.id, { dup_window_minutes: 0 }, null)
  assert.doesNotMatch(txt(await t.send(ev.text(A_ID, 'ขนม 90.01'))), /ดูเหมือนซ้ำ/, 'ปิดแล้ว')
  // รายการที่ถูกลบไม่นับ: ลบ "ขนม 90.01" ทั้งสองรายการ แล้วพิมพ์ใหม่
  t.repo.updateCouple(c.id, { dup_window_minutes: 10 }, null)
  await t.send(ev.text(A_ID, 'ยกเลิก'))
  await t.send(ev.text(A_ID, 'ยกเลิก'))
  assert.doesNotMatch(txt(await t.send(ev.text(A_ID, 'ขนม 90.01'))), /ดูเหมือนซ้ำ/, 'รายการที่ถูกลบไม่นับ')
  // สลิปเก่าที่ยอดเท่ารายการพิมพ์ → เตือน · สลิปซ้ำจริง (transRef) ยังตอบ "บันทึกแล้วเมื่อ" เหมือนเดิม
  out = await t.send(ev.image(A_ID, 'slip-coffee'))
  assert.match(txt(out), /บันทึกแล้ว/)
  const dup = await t.send(ev.image(A_ID, 'slip-coffee'))
  assert.match(txt(dup), /สลิปนี้บันทึกแล้วเมื่อ/)
  assert.doesNotMatch(txt(dup), /ดูเหมือนซ้ำ/)
})

test('เตือนซ้ำ (B18-7): สลิปยอดเท่ารายการที่พิมพ์ไปแล้ว → เตือน', async () => {
  const t = makeCtx({ now: at('08:12') })
  const send = async (e: any) => (await handleEvent(t.ctx, e, handlers), t.line.take())
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  await send(ev.text(A_ID, 'กาแฟ 90'))
  t.clock.t += 2 * 60_000
  const out = await send(ev.image(A_ID, 'slip-coffee'))
  assert.match(txt(out), /ดูเหมือนซ้ำกับ \\"กาแฟ\\" เมื่อ 2 นาทีก่อน/)
})

// ---------- 10. เลขบัญชีแทนพร้อมเพย์ ----------
test('เลขบัญชี (B18-10): ไม่มีพร้อมเพย์ + ตั้งเลขบัญชี → การ์ดสรุปแสดงธนาคาร + เลข + ปุ่มคัดลอกแทน QR · มีพร้อมเพย์ → QR เหมือนเดิม · ตรวจรูปแบบใน API', async () => {
  const { runSummary } = await import('../src/jobs/summary.ts')
  const t = await setup()
  await t.send(ev.text(A_ID, 'หวัดดี'))
  await t.send(ev.text(B_ID, 'หวัดดี'))
  const srv = await listen(makeServer(t.ctx, handlers))
  try {
    const api = (body: object) => fetch(srv.base + '/api/settings', { method: 'PATCH', headers: { authorization: `Bearer fake:${A_ID}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    assert.equal((await api({ bank_account: '12345' })).status, 400)
    assert.equal((await api({ bank_account: 'abcdefghij' })).status, 400)
    assert.equal((await api({ bank_name: 'x'.repeat(31) })).status, 400)
    const ok = await api({ bank_name: 'ธนาคารสมมติ', bank_account: '000-000-0001' })
    assert.equal(ok.status, 200)
    assert.equal(((await ok.json()) as any).members[0].bank_account, '0000000001')
  } finally {
    await srv.close()
  }
  await t.send(ev.text(A_ID, 'ข้าว 1000'))
  t.clock.t = at('21:00')
  await runSummary(t.ctx)
  const card = t.line.take()
  const s = JSON.stringify(card)
  assert.match(s, /โอนเข้า ธนาคารสมมติ 0000000001/)
  assert.match(s, /"type":"clipboard","label":"คัดลอกเลขบัญชี","clipboardText":"0000000001"/)
  assert.ok(!s.includes('"hero"'), 'ไม่มี QR')
  // มีพร้อมเพย์ → ใช้ QR ไม่แสดงเลขบัญชี
  const t2 = await setup()
  await t2.send(ev.text(A_ID, 'หวัดดี'))
  await t2.send(ev.text(B_ID, 'หวัดดี'))
  const [a2] = t2.repo.members(t2.repo.allCouples()[0].id)
  t2.repo.updateMember(a2.id, { promptpay_id: '0800000001', bank_name: 'ธนาคารสมมติ', bank_account: '0000000001' })
  await t2.send(ev.text(A_ID, 'ข้าว 1000'))
  t2.clock.t = at('21:00')
  await runSummary(t2.ctx)
  const s2 = JSON.stringify(t2.line.take())
  assert.match(s2, /"hero"/)
  assert.ok(!s2.includes('0000000001'))
})

// ---------- migration 4 ----------
test('migrate v3 (หลัง B17) ที่มีข้อมูล → v4: ข้อมูลเดิมครบ ยอดเดิมเท่าเดิม · ค่าใหม่เป็นค่าเริ่ม', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { MIGRATIONS, migrate } = await import('../src/db/schema.ts')
  const { Repo } = await import('../src/db/repo.ts')
  const db = new DatabaseSync(join(tmpDir(), 'v3.db'))
  for (const [i, sql] of MIGRATIONS.slice(0, 3).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1}`)
  db.exec(`
    INSERT INTO couples (id, line_group_id, stale_slip_hours) VALUES (1, 'C_fake_group', 12);
    INSERT INTO members (id, couple_id, line_user_id, display_name, promptpay_id, account_suffixes) VALUES (1, 1, 'U_fake_a', 'เอ', '0800000001', '["1234"]'), (2, 1, 'U_fake_b', 'บี', NULL, '[]');
    INSERT INTO expenses (id, couple_id, paid_by, amount_satang, merchant, occurred_at, day, split_mode, source, created_by) VALUES (1, 1, 1, 70000, 'กาแฟ', '2026-09-29T01:00:00Z', '2026-09-29', 'half', 'text', 1);
    INSERT INTO expense_shares VALUES (1, 1, 35000), (1, 2, 35000);
    INSERT INTO settlements (id, couple_id, from_member, to_member, amount_satang, day, created_by, kind) VALUES (1, 1, 2, 1, 10000, '2026-09-29', 2, 'manual_close');
  `)
  const before = new Repo(db).ledger(1, '2026-09-29').net
  assert.equal(before, 25000)
  migrate(db)
  const r = new Repo(db)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, MIGRATIONS.length) // v4 ขึ้นไป (B19 เพิ่ม v5)
  assert.equal(r.ledger(1, '2026-09-29').net, before)
  assert.deepEqual([r.couple(1)!.stale_slip_hours, r.couple(1)!.dup_window_minutes], [12, null])
  const m = r.member(1)!
  assert.deepEqual([m.promptpay_id, m.account_suffixes, m.bank_name, m.bank_account], ['0800000001', '["1234"]', null, null])
  assert.equal(r.settlement(1)!.kind, 'manual_close')
})
