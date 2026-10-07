// B17: จัดประเภทสลิป (ก–จ จากการใช้จริง · fixture สังเคราะห์ล้วน) · ลบ/ปิดยอด · ลบทั้งหมดในแอป · onboarding · log
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { slipVerify } from 'promptparse/generate'
import { handlers } from '../src/bot.ts'
import { MIGRATIONS, migrate } from '../src/db/schema.ts'
import { Repo } from '../src/db/repo.ts'
import { initLog } from '../src/log.ts'
import { handleEvent } from '../src/line/router.ts'
import type { OutboxItem } from '../src/line/client.ts'
import { runSummary } from '../src/jobs/summary.ts'
import { makeServer } from '../src/server.ts'
import { classify, isSelfTransfer, isStale, knownAccounts } from '../src/slip/classify.ts'
import { normalize, type SlipAi } from '../src/slip/vision.ts'
import { makeSlipPng } from './fixtures/make-slip.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'
import { tmpDir } from './helpers/db.ts'

const DAY = '2026-09-29'
const at = (hm: string, day = DAY) => Date.parse(`${day}T${hm}:00+07:00`)
const iso = (ms: number) => new Date(ms).toISOString()
const PNG = await makeSlipPng({ title: 'FAKE BANK', lines: ['synthetic'] })
const FAKE_PERSON = 'ซีสมมติ' // ชื่อบุคคลที่ 3 สมมติ (ต้องไม่ไปโผล่ใน expenses/log)

const items = (out: OutboxItem[]) => out.flatMap((o) => o.messages).flatMap((m: any) => m.quickReply?.items ?? []).map((i: any) => i.action)
const tapData = (out: OutboxItem[], label: string) => {
  const a = items(out).find((x: any) => x.label === label)
  assert.ok(a, `ไม่มีปุ่ม "${label}" ใน ${JSON.stringify(items(out).map((x: any) => x.label))}`)
  return a.data as string
}
const txt = (out: OutboxItem[]) => JSON.stringify(out.map((o) => o.messages))

async function setup(opts: { now?: number } = {}) {
  const t = makeCtx({ now: opts.now ?? at('19:00') })
  const send = (e: any) => handleEvent(t.ctx, e, handlers)
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  t.line.take()
  const couple = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(couple.id)
  let next: Partial<SlipAi> = {}
  t.ctx.slips = { read: async () => normalize({ type: 'transfer_slip', confidence: 0.99, datetime: iso(t.clock.t - 600_000), ...next } as Partial<SlipAi>) }
  let k = 0
  const slip = async (who: string, ai: Partial<SlipAi>, png = PNG) => {
    next = ai
    const id = `img${++k}`
    t.line.contents.set(id, png)
    await send(ev.image(who, id))
    return t.line.take()
  }
  const tap = async (who: string, data: string) => {
    await send(ev.postback(who, data))
    return t.line.take()
  }
  const say = async (who: string, text: string) => {
    await send(ev.text(who, text))
    return t.line.take()
  }
  const net = (day = DAY) => t.repo.ledger(couple.id, day).net
  const counts = () => ({
    expenses: t.repo.expensesByDay(couple.id, DAY).length,
    settlements: t.repo.settlementsByDay(couple.id, DAY).length,
  })
  return { ...t, send, couple, a, b, slip, tap, say, net, counts }
}

// ---------- (ก) สลิปเก่า → pending ----------
test('(ก) สลิปเก่า 1 วัน → pending ไม่กระทบยอด · ตอบ "นับ" แล้วเข้ากฎปกติ (โอนให้อีกคน → เคลียร์ยอด)', async () => {
  const { slip, tap, net, counts, repo, b, a, clock, couple } = await setup()
  const out = await slip(A_ID, { amount: 200, sender_name: 'นาย เอ ส.', receiver_name: 'น.ส. บี ส.', datetime: iso(clock.t - 26 * 3600_000) })
  assert.match(txt(out), /เก่ากว่า 24 ชม\./)
  assert.equal(net(), 0)
  assert.deepEqual(counts(), { expenses: 0, settlements: 0 })
  const s = repo.db.prepare('SELECT * FROM slips ORDER BY id DESC LIMIT 1').get() as any
  assert.equal(s.status, 'pending')
  assert.equal(s.rule, 'stale')
  const r = await tap(A_ID, tapData(out, 'นับเป็นรายการวันนี้'))
  assert.match(txt(r), /รับโอน เอ → บี ฿200\.00/)
  const [st] = repo.settlementsByDay(couple.id, DAY)
  assert.deepEqual([st.from_member, st.to_member, st.amount_satang], [a.id, b.id, 20000])
  assert.equal(net(), 20000)
  // กดซ้ำ → ไม่บันทึกซ้ำ
  assert.match(txt(await tap(A_ID, tapData(out, 'นับเป็นรายการวันนี้'))), /ตอบไปแล้ว/)
  assert.equal(counts().settlements, 1)
})

test('(ก) ไม่มีวันที่ → ถาม · "ไม่นับ" → ไม่นับ · ไม่ตอบเกิน 24 ชม. → ไม่นับ · ตั้ง 0 ชม. = ปิดการถาม', async () => {
  const { slip, tap, net, counts, clock, repo, couple } = await setup()
  let out = await slip(A_ID, { type: 'receipt', amount: 90, merchant: 'กาแฟ', datetime: null })
  assert.match(txt(out), /ไม่มีวันที่/)
  await tap(A_ID, tapData(out, 'ไม่นับ'))
  assert.equal(net(), 0)
  out = await slip(A_ID, { type: 'receipt', amount: 90, merchant: 'กาแฟ', datetime: null })
  clock.t += 25 * 3600_000
  const r = await tap(A_ID, tapData(out, 'นับเป็นรายการวันนี้'))
  assert.match(txt(r), /ไม่นับ/)
  assert.deepEqual(counts(), { expenses: 0, settlements: 0 })
  assert.equal(repo.db.prepare('SELECT COUNT(*) AS n FROM slips WHERE ignored = 1').get()!.n, 2)
  repo.updateCouple(couple.id, { stale_slip_hours: 0 }, null)
  await slip(A_ID, { type: 'receipt', amount: 90, merchant: 'กาแฟ', datetime: null })
  assert.equal(repo.expensesByDay(couple.id, '2026-09-30').length, 1, 'ปิดการถามแล้วบันทึกเลย')
  assert.equal(isStale(null, 0, 0), false)
  // เก็บแค่ 4 หลักท้าย แม้ AI อ่านเลขบัญชีเต็มมา
  assert.deepEqual([normalize({ receiver_account: 'xxx-4-56789-x', sender_account: 'x1' }).receiver_account, normalize({ sender_account: 'x1' }).sender_account], ['6789', null])
  assert.equal(isStale(iso(at('20:00')), at('19:00'), 24), false, 'วันที่อนาคต (นาฬิกาเพี้ยน) ไม่ถือว่าเก่า')
})

// ---------- (ข) โอนคืนระหว่างคู่ ชื่อเล่นไม่ตรงสลิป ----------
test('(ข) ไม่ตั้งชื่อบัญชีและชื่อไม่ตรง → กฎบุคคลอื่น + ปุ่ม "เป็นเคลียร์ยอด" · ตั้ง bank_names แล้ว → เคลียร์ยอดอัตโนมัติ', async () => {
  const { slip, tap, net, counts, repo, a, b, couple } = await setup()
  repo.updateMember(a.id, { display_name: 'พี่เอ' })
  const ai = { amount: 100, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' }
  const out = await slip(B_ID, ai)
  const [e] = repo.expensesByDay(couple.id, DAY)
  assert.equal(e.merchant, 'โอนให้บุคคล')
  assert.equal(net(), -5000)
  const r = await tap(B_ID, tapData(out, 'เป็นเคลียร์ยอด'))
  assert.match(txt(r), /รับโอน บี → พี่เอ ฿100\.00/)
  assert.deepEqual(counts(), { expenses: 0, settlements: 1 })
  assert.equal(net(), -10000)

  repo.updateMember(a.id, { bank_names: ['เอ สมมติ'] })
  await slip(B_ID, ai)
  assert.deepEqual(counts(), { expenses: 0, settlements: 2 })
  assert.equal(net(), -20000)
  assert.equal(repo.settlementsByDay(couple.id, DAY)[1].from_member, b.id)
})

test('เลขท้ายบัญชีตั้งไว้แต่สลิปไม่ตรง (ชื่อตรง) → ไม่ใช่เคลียร์ยอด · ตรง → เคลียร์ยอด', async () => {
  const { slip, counts, repo, b } = await setup()
  repo.updateMember(b.id, { account_suffixes: ['1234'] })
  await slip(A_ID, { amount: 100, sender_name: 'นาย เอ ส.', receiver_name: 'น.ส. บี ส.', receiver_account: 'xxx-xxx-9999' })
  assert.deepEqual(counts(), { expenses: 1, settlements: 0 }, 'negative control: ชื่อซ้ำแต่บัญชีคนอื่น')
  await slip(A_ID, { amount: 100, sender_name: 'นาย เอ ส.', receiver_name: 'น.ส. บี ส.', receiver_account: 'xxx-x-x1234-x' })
  assert.deepEqual(counts(), { expenses: 1, settlements: 1 })
  // สลิปอ่านเลขบัญชีไม่ได้ ทั้งที่ตั้งไว้ → ไม่ยืนยันว่าเป็นคนในคู่
  const m = (id: number, name: string, sfx: string[] = []) => ({ id, couple_id: 1, line_user_id: `U_fake_${id}`, display_name: name, promptpay_id: null, bank_names: '[]', account_suffixes: JSON.stringify(sfx) })
  const ai = normalize({ type: 'transfer_slip', amount: 1, sender_name: 'นาย เอ', receiver_name: 'น.ส. บี', confidence: 1 })
  assert.equal(classify(ai, m(1, 'เอ'), [m(1, 'เอ'), m(2, 'บี', ['1234'])]).kind, 'expense')
  assert.equal(classify(ai, m(1, 'เอ'), [m(1, 'เอ'), m(2, 'บี')]).kind, 'settlement')
})

// ---------- (ค) เติมเงิน / โอนเข้าตัวเอง ----------
test('(ค) เติมเงิน e-wallet / โอนเข้าบัญชีตัวเอง → ไม่นับอัตโนมัติ · กด "นับเป็นค่าใช้จ่าย" แล้วยอดเปลี่ยน', async () => {
  const { slip, tap, net, counts, repo, couple } = await setup()
  const out = await slip(A_ID, { amount: 500, sender_name: 'นาย เอ ส.', receiver_name: 'TrueMoney Wallet', receiver_kind: null })
  assert.match(txt(out), /ไม่นับเข้ายอด/)
  assert.equal(net(), 0)
  await slip(A_ID, { amount: 300, sender_name: 'นาย เอ ส.', receiver_name: 'นาย เอ ส.' })
  await slip(A_ID, { amount: 700, sender_name: 'นาย เอ ส.', receiver_name: 'ShopeePay', receiver_kind: 'topup' })
  assert.equal(net(), 0)
  assert.deepEqual(counts(), { expenses: 0, settlements: 0 })
  await tap(A_ID, tapData(out, 'นับเป็นค่าใช้จ่าย'))
  assert.equal(net(), 25000)
  assert.equal(counts().expenses, 1)
  assert.notEqual(repo.expensesByDay(couple.id, DAY)[0].merchant, 'เติมเงิน/โอนเข้าบัญชีตัวเอง', 'กดนับแล้วชื่อรายการไม่ใช่ป้ายเติมเงิน')
})

test('จ่ายร้านผ่านพร้อมเพย์ e-Wallet (AI ตอบ topup / มีคำว่า wallet) แต่ผู้รับเป็นคนอื่น → ค่าใช้จ่าย ไม่ใช่เติมเงิน', async () => {
  const { slip, net, counts } = await setup()
  await slip(B_ID, { amount: 120, sender_name: 'น.ส. บี ส.', receiver_name: 'ร้านก๋วยเตี๋ยวเรือ', receiver_kind: 'topup', merchant: 'ก๋วยเตี๋ยว' })
  await slip(B_ID, { amount: 80, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย ซี ท.', merchant: 'e-Wallet' })
  assert.equal(counts().expenses, 2)
  assert.equal(net(), -10000)
})

test('isSelfTransfer: ใช้บัญชีที่ตั้งไว้ (พร้อมเพย์/เลขท้าย) ก่อนคำบนสลิป', () => {
  const m = (p: Partial<any> = {}) => ({ id: 2, couple_id: 1, line_user_id: 'U_fake_b', display_name: 'บี', promptpay_id: '0800000002', bank_names: '[]', account_suffixes: '[]', ...p })
  const ai = (p: Partial<SlipAi>) => normalize({ type: 'transfer_slip', amount: 1, sender_name: 'น.ส. บี ส.', confidence: 1, ...p })
  // ร้านรับผ่าน e-Wallet: AI ตอบ topup ก็ไม่ใช่เติมเงิน
  assert.equal(isSelfTransfer(ai({ receiver_name: 'ร้านก๋วยเตี๋ยว', receiver_kind: 'topup', receiver_account: 'xxx-1234' }), m()), false)
  // ผู้รับไม่มีชื่อ เลขท้ายตรงพร้อมเพย์ของตัวเอง → โอนเข้าตัวเอง
  assert.equal(isSelfTransfer(ai({ receiver_name: null, receiver_account: 'xxx-xxx-0002' }), m()), true)
  assert.equal(isSelfTransfer(ai({ receiver_name: null, receiver_account: 'xxx-xxx-9999', receiver_kind: 'shop' }), m()), false)
  // ชื่อเดียวกับผู้โอน แต่ตั้งเลขท้ายไว้แล้วเลขไม่ตรง → คนชื่อซ้ำ ไม่ใช่ตัวเอง · ตรงพร้อมเพย์ → ตัวเอง
  assert.equal(isSelfTransfer(ai({ receiver_name: 'น.ส. บี ท.', receiver_account: 'xxx-9999' }), m({ account_suffixes: '["1111"]' })), false)
  assert.equal(isSelfTransfer(ai({ receiver_name: 'น.ส. บี ท.', receiver_account: 'xxx-0002' }), m({ account_suffixes: '["1111"]' })), true)
  // สลิป SCB "เติมเงินพร้อมเพย์" เข้า e-Wallet ของร้าน: เจ้าของ wallet เป็นคนอื่น → ไม่ใช่ตัวเอง · ป้ายอย่างเดียวก็ไม่ใช่ตัวเอง · wallet ของตัวเอง → ตัวเอง
  assert.equal(isSelfTransfer(ai({ receiver_name: 'น.ส. ซี ส. (K Plus W)', receiver_kind: 'topup', receiver_account: '000000000000009' }), m()), false)
  assert.equal(isSelfTransfer(ai({ receiver_name: 'เติมเงินพร้อมเพย์', receiver_kind: 'topup', receiver_account: '000000000000009' }), m()), false)
  assert.equal(isSelfTransfer(ai({ receiver_name: 'น.ส. บี ส. (K Plus W)', receiver_kind: 'topup', receiver_account: '000000000000009' }), m()), true)
  // เติมผ่านผู้ให้บริการ wallet
  assert.equal(isSelfTransfer(ai({ receiver_name: 'ทรูมันนี่', receiver_kind: 'topup' }), m()), true)
  assert.deepEqual(knownAccounts(m({ account_suffixes: '["1111"]', bank_account: '0000000003' })), ['1111', '0002', '0003'])
})

// ---------- (ง) โอนให้บุคคลที่ 3 ----------
test('(ง) โอนให้บุคคลอื่น → expense อัตโนมัติ · merchant ไม่มีชื่อบุคคล (grep ทั้งตาราง expenses + audit_log)', async () => {
  const { slip, tap, repo, couple, net } = await setup()
  const out = await slip(A_ID, { amount: 400, sender_name: 'นาย เอ ส.', receiver_name: `นางสาว ${FAKE_PERSON} ท.`, merchant: FAKE_PERSON, category: FAKE_PERSON })
  const [e] = repo.expensesByDay(couple.id, DAY)
  assert.equal(e.merchant, 'โอนให้บุคคล')
  assert.equal(e.split_mode, 'half')
  assert.equal(net(), 20000)
  const dump = JSON.stringify([repo.db.prepare('SELECT * FROM expenses').all(), repo.db.prepare("SELECT * FROM audit_log WHERE entity = 'expense'").all()])
  assert.ok(!dump.includes(FAKE_PERSON), 'ชื่อบุคคลหลุดไปใน expenses/audit')
  // ปุ่มเดียวกับร้าน: เปลี่ยนการหาร + ไม่นับ
  assert.ok(items(out).some((x: any) => x.label === 'หารครึ่ง'))
  await tap(A_ID, tapData(out, 'ไม่นับ'))
  assert.equal(net(), 0)
})

// ---------- (จ) จ่ายร้านผ่าน gateway ----------
test('(จ) gateway → merchant ไม่ใช่ "2c2p" เปล่าๆ: ใช้ชื่อร้านที่ AI อ่านได้ ถ้าไม่มี "จ่ายผ่าน <gateway>"', async () => {
  const { slip, repo, couple } = await setup()
  await slip(A_ID, { amount: 120, receiver_name: '2C2P (THAILAND)', merchant: '2c2p' })
  await slip(A_ID, { amount: 80, receiver_name: '2c2p', merchant: 'ก๋วยเตี๋ยวสมมติ' })
  await slip(A_ID, { amount: 60, receiver_name: 'KSHOP', merchant: null, receiver_kind: 'shop' })
  const ms = repo.expensesByDay(couple.id, DAY).map((e) => e.merchant)
  assert.deepEqual(ms, ['จ่ายผ่าน 2C2P', 'ก๋วยเตี๋ยวสมมติ', 'จ่ายผ่าน KShop'])
  assert.ok(!ms.some((m) => m.toLowerCase() === '2c2p'))
})

test('ร้าน → default_split ของคู่ + ปุ่มเปลี่ยนการหาร + "ไม่นับ" · ไม่ใช่เคลียร์ยอด → เลือกเป็นค่าใช้จ่าย', async () => {
  const { slip, tap, repo, couple, net, counts, a } = await setup()
  repo.updateCouple(couple.id, { default_split: 'mine' }, null)
  const shop = await slip(A_ID, { amount: 100, receiver_name: 'ร้านสมมติ', merchant: 'ข้าว' })
  assert.equal(repo.expensesByDay(couple.id, DAY)[0].split_mode, 'mine')
  assert.deepEqual(items(shop).map((x: any) => x.label), ['หารครึ่ง', 'ของเอ', 'ของบี', 'เอเลี้ยง', 'บีเลี้ยง', 'ไม่นับ'])
  // เคลียร์ยอด → "ไม่ใช่เคลียร์ยอด" → หารครึ่ง
  const out = await slip(A_ID, { amount: 300, sender_name: 'นาย เอ ส.', receiver_name: 'น.ส. บี ส.' })
  assert.equal(net(), 30000)
  const choose = await tap(A_ID, tapData(out, 'ไม่ใช่เคลียร์ยอด'))
  assert.deepEqual(items(choose).map((x: any) => x.label), ['หารครึ่ง', 'ของเอ', 'ของบี', 'ไม่นับ'])
  await tap(A_ID, tapData(choose, 'หารครึ่ง'))
  assert.deepEqual(counts(), { expenses: 2, settlements: 0 })
  const e = repo.expensesByDay(couple.id, DAY)[1]
  assert.deepEqual([e.paid_by, e.split_mode, e.amount_satang], [a.id, 'half', 30000])
  assert.equal(net(), 15000)
  // settlement ที่ถูกแปลงถูก soft delete (ยังอยู่ใน DB)
  assert.equal(repo.db.prepare("SELECT COUNT(*) AS n FROM settlements WHERE status = 'deleted'").get()!.n, 1)
})

// ---------- ลบ settlement ----------
test('ลบ settlement: วันนี้ (ไม่ผูก) · ผูกสรุป · วันที่ปิดแล้ว · ผูกสรุปที่มีสรุปวันหลังแล้ว → ยอดกลับเท่าก่อนบันทึกทุกกรณี', async () => {
  const { say, slip, repo, couple, net, clock, ctx, a, b } = await setup({ now: at('08:00') })
  await say(A_ID, 'กาแฟ 700')
  assert.equal(net(), 35000)
  // 1) วันนี้ ไม่ผูก → ยกเลิกด้วยคำสั่ง "ยกเลิก" (ล่าสุดของบีคือการโอน)
  await slip(B_ID, { amount: 100, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' })
  assert.equal(net(), 25000)
  const undo = await say(B_ID, 'ยกเลิก')
  assert.match(txt(undo), /ลบ \\"โอน บี → เอ ฿100\.00\\" แล้ว/)
  assert.equal(net(), 35000)
  assert.equal(repo.auditFor('settlement', repo.db.prepare('SELECT MAX(id) AS id FROM settlements').get()!.id as number).at(-1)!.action, 'delete')

  // 2) ผูกสรุป: 21:00 สรุป 350 → บีโอน 350 → เคลียร์ → ลบ → สรุปกลับเป็นค้าง
  clock.t = at('21:00')
  await runSummary(ctx)
  clock.t = at('21:05')
  await slip(B_ID, { amount: 350, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' })
  const s1 = repo.summary(couple.id, DAY)!
  assert.deepEqual([s1.paid_satang, s1.settled], [35000, 1])
  const D2 = '2026-09-30'
  assert.equal(net(D2), 0)
  const linked = repo.settlementsByDay(couple.id, D2)[0]
  assert.equal(linked.summary_id, s1.id)
  repo.deleteSettlement(linked.id, b.id, D2)
  assert.deepEqual([repo.summary(couple.id, DAY)!.paid_satang, repo.summary(couple.id, DAY)!.settled], [0, 0])
  assert.equal(net(D2), 35000)

  // 3) วันที่ปิดแล้ว: เอโอนให้บี 50 (ไม่ผูก เพราะทิศตรงข้าม) วันที่ 30 → สรุปวันที่ 30 → ลบวันที่ 1 ต.ค. → ยอดปรับปรุง
  clock.t = at('10:00', D2)
  const st = repo.createSettlement({ coupleId: couple.id, from: a.id, to: b.id, amount: 5000, day: D2, summaryId: null, createdBy: a.id })
  assert.equal(net(D2), 40000)
  clock.t = at('21:00', D2)
  await runSummary(ctx)
  const D3 = '2026-10-01'
  assert.equal(net(D3), 40000)
  repo.deleteSettlement(st.id, a.id, D3)
  assert.equal(net(D3), 35000)
  assert.equal(repo.adjustmentsSum(couple.id, D3), -5000)

  // 4) ผูกสรุปวันที่ 30 แล้วมีสรุปวันที่ 1 ต.ค. ตามมา → ลบ → ยอดปรับปรุงเข้าวันนี้
  clock.t = at('21:10', D2)
  await slip(B_ID, { amount: 400, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' })
  const lk = repo.settlementsByDay(couple.id, D3).find((x) => x.summary_id)!
  assert.ok(lk)
  clock.t = at('21:00', D3)
  await runSummary(ctx)
  const D4 = '2026-10-02'
  const before = net(D4)
  repo.deleteSettlement(lk.id, b.id, D4)
  assert.equal(net(D4), before + 40000)
})

// ---------- ปิดยอดเป็น 0 + API ----------
async function withApi(t: Awaited<ReturnType<typeof setup>>) {
  const srv = await listen(makeServer(t.ctx, handlers))
  const api = async (who: string, method: string, path: string, body?: unknown) => {
    const r = await fetch(srv.base + path, { method, headers: { authorization: `Bearer fake:${who}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: r.status, body: (await r.json()) as any }
  }
  return { api, close: srv.close }
}

test('ปิดยอดเป็น 0 → net = 0 · push แจ้งกลุ่ม 1 ครั้ง · ลบ (ยกเลิก) แล้วกลับเท่าเดิม · ทั้งมีและไม่มีสรุปค้าง', async () => {
  const t = await setup({ now: at('08:00') })
  const { api, close } = await withApi(t)
  try {
    await t.say(A_ID, 'กาแฟ 700')
    t.clock.t = at('21:00')
    await runSummary(t.ctx)
    t.line.take()
    t.clock.t = at('09:00', '2026-09-30')
    await t.say(B_ID, 'ข้าว 100')
    const D2 = '2026-09-30'
    assert.equal(t.net(D2), 30000)
    const r = await api(A_ID, 'POST', '/api/settle/close')
    assert.equal(r.status, 200)
    assert.deepEqual([r.body.amount, r.body.net_after], [30000, 0])
    assert.equal(t.net(D2), 0)
    const pushed = t.line.take().filter((o) => o.kind === 'push')
    assert.equal(pushed.length, 1)
    assert.match(txt(pushed), /เอ ปิดยอดเป็น 0 แล้ว \(เดิม บี โอนให้ เอ ฿300\.00\)/)
    const today = (await api(B_ID, 'GET', '/api/today')).body
    const mc = today.settlements.find((s: any) => s.kind === 'manual_close')
    assert.ok(mc)
    assert.equal(today.pending, null)
    assert.equal((await api(A_ID, 'POST', '/api/settle/close')).status, 400, 'เป็น 0 แล้วปิดซ้ำไม่ได้')
    const del = await api(B_ID, 'DELETE', `/api/settlements/${mc.id}`)
    assert.deepEqual([del.status, del.body.net], [200, 30000])
    assert.equal((await api(B_ID, 'DELETE', `/api/settlements/${mc.id}`)).status, 404)
    assert.equal(t.repo.summary(t.couple.id, DAY)!.settled, 0)
    // ปิดยอดที่ผูกกับสรุป → สรุปนั้นถือว่าปิดแล้ว (ปฏิทินขึ้นเคลียร์แล้ว · โอนครั้งหน้าไม่ไปจับคู่กับสรุปเก่า)
    await api(A_ID, 'POST', '/api/settle/close')
    assert.equal(t.repo.summary(t.couple.id, DAY)!.settled, 1)
    // ทิศตรงข้ามกับสรุปที่ค้าง (ไม่ผูก) → สรุปยังค้าง แต่ยอดสดเป็น 0 → แท็บเคลียร์ยอดต้องไม่เรียกเก็บ
    const del2 = (await api(B_ID, 'GET', '/api/today')).body.settlements.find((s: any) => s.kind === 'manual_close')
    await api(B_ID, 'DELETE', `/api/settlements/${del2.id}`)
    await t.say(B_ID, 'ตั๋ว 1000')
    assert.equal(t.net(D2), -20000)
    await api(A_ID, 'POST', '/api/settle/close')
    assert.equal(t.net(D2), 0)
    assert.equal(t.repo.summary(t.couple.id, DAY)!.settled, 0)
    assert.equal((await api(B_ID, 'GET', '/api/today')).body.pending, null)
  } finally {
    await close()
  }
})

test('API: นับสลิปที่ไม่นับทีหลังได้ · ตั้งเลขท้ายบัญชี (ตรวจรูปแบบ) · วันในประวัติมี settlement', async () => {
  const t = await setup()
  const { api, close } = await withApi(t)
  try {
    await t.slip(A_ID, { amount: 500, sender_name: 'นาย เอ ส.', receiver_name: 'TrueMoney Wallet' })
    await t.slip(B_ID, { amount: 100, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' })
    const today = (await api(A_ID, 'GET', '/api/today')).body
    assert.deepEqual(today.ignored_slips.map((s: any) => [s.amount, s.label]), [[50000, 'เติมเงิน/โอนเข้าบัญชีตัวเอง']])
    const c = await api(A_ID, 'POST', `/api/slips/${today.ignored_slips[0].id}/count`)
    assert.deepEqual([c.status, c.body.net], [200, 25000 - 10000])
    assert.equal((await api(A_ID, 'POST', `/api/slips/${today.ignored_slips[0].id}/count`)).status, 404, 'นับแล้วนับซ้ำไม่ได้')
    // นับแล้วลบรายการ → หายจริง ไม่กลับไปโผล่ใน "สลิปที่ไม่นับ"
    const counted = (await api(A_ID, 'GET', '/api/today')).body.expenses.find((e: any) => e.slip_id === today.ignored_slips[0].id)
    assert.equal((await api(A_ID, 'DELETE', `/api/expenses/${counted.id}`)).status, 200)
    assert.deepEqual((await api(A_ID, 'GET', '/api/today')).body.ignored_slips, [])
    // สลิปที่ไม่นับ กดลบออกจากรายการได้ · ยอดไม่เปลี่ยน · ลบซ้ำ/นับหลังลบไม่ได้
    await t.slip(A_ID, { amount: 200, sender_name: 'นาย เอ ส.', receiver_name: 'TrueMoney Wallet' })
    const ign = (await api(A_ID, 'GET', '/api/today')).body
    assert.equal(ign.ignored_slips.length, 1)
    const d = await api(A_ID, 'POST', `/api/slips/${ign.ignored_slips[0].id}/dismiss`)
    assert.equal(d.status, 200)
    const after = (await api(A_ID, 'GET', '/api/today')).body
    assert.deepEqual([after.ignored_slips, after.net], [[], ign.net])
    assert.equal((await api(A_ID, 'POST', `/api/slips/${ign.ignored_slips[0].id}/dismiss`)).status, 404)
    assert.equal((await api(A_ID, 'POST', `/api/slips/${ign.ignored_slips[0].id}/count`)).status, 404)
    assert.equal((await api(A_ID, 'PATCH', '/api/settings', { account_suffixes: ['12a4'] })).status, 400)
    assert.equal((await api(A_ID, 'PATCH', '/api/settings', { stale_slip_hours: -1 })).status, 400)
    const ok = await api(A_ID, 'PATCH', '/api/settings', { account_suffixes: ['1234', '5678'], stale_slip_hours: 48 })
    assert.equal(ok.status, 200)
    assert.deepEqual(ok.body.members[0].account_suffixes, ['1234', '5678'])
    assert.equal(ok.body.settings.stale_slip_hours, 48)
    const day = (await api(A_ID, 'GET', `/api/days/${DAY}`)).body
    assert.equal(day.settlements.length, 1)
  } finally {
    await close()
  }
})

// ---------- ลบข้อมูลทั้งหมดในแอป ----------
test('ลบทั้งหมดในแอป: พิมพ์คำอื่น → ไม่มีอะไรหาย · สำรองล้ม → ไม่ลบ · สำเร็จ → สำรองก่อน แจ้งกลุ่ม + การ์ดตั้งค่า', async () => {
  const t = await setup()
  const { api, close } = await withApi(t)
  try {
    await t.say(A_ID, 'กาแฟ 90')
    const counts = (await api(A_ID, 'GET', '/api/wipe')).body
    assert.deepEqual(counts, { expenses: 1, settlements: 0, slips: 0, summaries: 0 })
    for (const confirm of ['ลบม', 'delete', '', undefined]) {
      assert.equal((await api(A_ID, 'POST', '/api/wipe', { confirm })).status, 400)
    }
    assert.equal(t.repo.expensesByDay(t.couple.id, DAY).length, 1)
    // สำรองล้ม (BACKUP_DIR เป็นไฟล์ สร้างโฟลเดอร์ไม่ได้)
    const realBackup = t.ctx.cfg.backupDir
    const blocker = join(tmpDir(), 'not-a-dir')
    writeFileSync(blocker, 'x')
    t.ctx.cfg.backupDir = blocker
    const fail = await api(A_ID, 'POST', '/api/wipe', { confirm: 'ลบ' })
    assert.equal(fail.status, 503)
    assert.equal(t.repo.expensesByDay(t.couple.id, DAY).length, 1)
    t.ctx.cfg.backupDir = realBackup
    t.line.take()
    const ok = await api(A_ID, 'POST', '/api/wipe', { confirm: 'ลบ' })
    assert.equal(ok.status, 200)
    assert.equal(t.repo.coupleByGroup('C_fake_group'), undefined)
    assert.equal(readdirSync(realBackup).filter((f) => f.endsWith('.db.gz')).length, 1)
    const out = t.line.take()
    assert.deepEqual(out.map((o) => o.kind), ['push'])
    assert.match(txt(out), /ลบข้อมูลทั้งหมดจากแอปแล้ว/)
    assert.match(txt(out), /ลงทะเบียนครบ 2 คน \(0\/2\)/)
  } finally {
    await close()
  }
})

test('ลบทั้งหมดจากแชท: สำรองล้ม → ไม่ลบ · สำเร็จ → การ์ดตั้งค่า', async () => {
  const t = await setup()
  await t.say(A_ID, 'กาแฟ 90')
  const realBackup = t.ctx.cfg.backupDir
  const blocker = join(tmpDir(), 'not-a-dir')
  writeFileSync(blocker, 'x')
  t.ctx.cfg.backupDir = blocker
  let out = await t.say(A_ID, 'ลบข้อมูลทั้งหมด')
  out = await t.tap(A_ID, tapData(out, 'ใช่ ลบทั้งหมด'))
  out = await t.tap(A_ID, tapData(out, 'ลบถาวร'))
  assert.match(txt(out), /สำรองข้อมูลไม่สำเร็จ/)
  assert.equal(t.repo.expensesByDay(t.couple.id, DAY).length, 1)
  t.ctx.cfg.backupDir = realBackup
  out = await t.say(A_ID, 'ลบข้อมูลทั้งหมด')
  out = await t.tap(A_ID, tapData(out, 'ใช่ ลบทั้งหมด'))
  out = await t.tap(A_ID, tapData(out, 'ลบถาวร'))
  assert.match(txt(out), /ลบข้อมูลทั้งหมดของกลุ่มนี้แล้ว/)
  assert.match(txt(out), /เริ่มใหม่: ตั้งค่าหารกัน/)
  assert.equal(t.repo.coupleByGroup('C_fake_group'), undefined)
  assert.ok(existsSync(realBackup))
})

// ---------- onboarding ----------
test('onboarding: เข้ากลุ่ม → การ์ด · คนที่ 1/2 ลงทะเบียน → reply ความคืบหน้า (ไม่บล็อก) · "ตั้งค่า" → การ์ด · เตือนต่อท้ายการ์ดไม่เกินวันละครั้ง', async () => {
  const t = makeCtx({ now: at('08:00') })
  t.line.profiles.set(B_ID, 'น้องบี 🐰')
  const send = async (e: any) => (await handleEvent(t.ctx, e, handlers), t.line.take())
  let out = await send(ev.join())
  assert.equal(out[0].messages[0].type, 'flex')
  assert.match(txt(out), /ลงทะเบียนครบ 2 คน \(0\/2\)/)
  out = await send(ev.text(A_ID, 'กาแฟ 90'))
  assert.match(txt(out), /ลงทะเบียน เอ แล้ว ✓ รออีก 1 คน/)
  out = await send(ev.text(B_ID, 'ข้าว 100'))
  assert.equal(out.length, 1, 'reply token เดียว')
  assert.match(txt(out), /ลงทะเบียน น้องบี 🐰 แล้ว ✓ พร้อมใช้แล้ว ✨/)
  assert.match(txt(out), /บันทึกแล้ว/, 'ครบ 2 คนใช้งานได้ทันที')
  assert.match(txt(out), /ยังตั้งค่าไม่ครบ/, 'เตือนครั้งแรกของวัน')
  out = await send(ev.text(A_ID, 'ชา 40'))
  assert.doesNotMatch(txt(out), /ยังตั้งค่าไม่ครบ/, 'วันเดียวกันไม่เตือนซ้ำ')
  out = await send(ev.text(A_ID, 'ตั้งค่า'))
  // B18: ชื่อบัญชีว่าง = ⚠️ ทุกคน (เดิม B17 เดาจากตัวชื่อแล้วขึ้น ✓ ไม่จำเป็น)
  assert.match(txt(out), /⚠️ น้องบี 🐰: ใส่ชื่อต้นตามสลิป/)
  assert.match(txt(out), /⚠️ เอ: ใส่ชื่อต้นตามสลิป/)
  t.clock.t = at('09:00', '2026-09-30')
  out = await send(ev.text(A_ID, 'ชา 40'))
  assert.match(txt(out), /ยังตั้งค่าไม่ครบ/, 'วันใหม่เตือนได้อีกครั้ง')
  const [a, b] = t.repo.members(t.repo.allCouples()[0].id)
  t.repo.updateMember(a.id, { bank_names: ['เอ'] })
  t.repo.updateMember(b.id, { bank_names: ['บี'] })
  out = await send(ev.text(A_ID, 'ชา 40'))
  out = await send(ev.text(A_ID, 'ตั้งค่า'))
  assert.match(txt(out), /พร้อมใช้แล้ว/)
})

// ---------- log การทำงานปกติ ----------
test('log info: webhook_event · slip_read · slip_classified · create/delete · ไม่มีชื่อ เลขบัญชี transRef ข้อความแชท token', async () => {
  const dir = tmpDir()
  initLog(dir)
  const t = await setup()
  const ref = 'FAKELOGREF0001'
  const png = await makeSlipPng({ title: 'FAKE BANK', lines: ['synthetic'], qr: slipVerify({ sendingBank: '014', transRef: ref }) })
  const out = await t.slip(A_ID, { amount: 400, sender_name: 'นาย เอ ส.', sender_account: 'xxx-xxx-4321', receiver_name: `นางสาว ${FAKE_PERSON} ท.`, receiver_account: 'xxx-x-x9876-x' }, png)
  await t.slip(B_ID, { amount: 100, sender_name: 'น.ส. บี ส.', receiver_name: 'นาย เอ ส.' })
  await t.say(B_ID, 'ยกเลิก')
  await t.say(A_ID, 'ข้าวมันไก่ลับสุดยอด 55')
  await t.tap(A_ID, tapData(out, 'ไม่นับ'))
  const raw = readFileSync(join(dir, 'harnkan.log'), 'utf8')
  const lines = raw.trim().split('\n').map((l) => JSON.parse(l))
  const ev1 = (name: string) => lines.filter((l) => l.event === name)
  assert.ok(ev1('webhook_event').some((l) => l.type === 'message' && l.msg === 'image'))
  assert.ok(ev1('webhook_event').some((l) => l.type === 'postback'))
  assert.deepEqual(ev1('slip_read')[0], { ...ev1('slip_read')[0], level: 'info', qr: 'yes', ai: 'yes', confidence: 0.99 })
  assert.deepEqual(ev1('slip_classified').map((l) => [l.rule, l.pending]), [['person', false], ['partner', false]])
  assert.ok(ev1('expense_create').some((l) => l.satang === 40000 && typeof l.member === 'number'))
  assert.ok(ev1('settlement_create').some((l) => l.satang === 10000))
  assert.ok(ev1('settlement_delete').length === 1)
  assert.ok(ev1('expense_delete').length === 1)
  // negative control: ข้อมูลเหล่านี้อยู่ใน input จริง แต่ต้องไม่อยู่ใน log
  for (const s of [FAKE_PERSON, 'เอ ส.', 'บี ส.', '9876', '4321', ref, 'ข้าวมันไก่ลับสุดยอด', 'U_fake_a', 'fake:']) {
    assert.ok(!raw.includes(s), `log มี "${s}"`)
  }
  assert.doesNotMatch(raw, /"rt\d+"/, 'reply token')
})

// ---------- migration ----------
test('migrate จาก user_version 2 ที่มีข้อมูลทุกตาราง → ข้อมูลเดิมครบ ยอดเดิมเท่าเดิม · เพิ่มอย่างเดียว', () => {
  const p = join(tmpDir(), 'v2.db')
  const db = new DatabaseSync(p)
  db.exec('PRAGMA foreign_keys = ON')
  for (const [i, sql] of MIGRATIONS.slice(0, 2).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1}`)
  db.exec(`
    INSERT INTO couples (id, line_group_id, ai_daily_cap) VALUES (1, 'C_fake_group', 10);
    INSERT INTO members (id, couple_id, line_user_id, display_name, bank_names) VALUES (1, 1, 'U_fake_a', 'เอ', '["เอ"]'), (2, 1, 'U_fake_b', 'บี', '[]');
    INSERT INTO slips (id, couple_id, member_id, qr_trans_ref, amount_satang, kind, status) VALUES (1, 1, 2, 'FAKEV2REF', 34750, 'settlement', 'done');
    INSERT INTO expenses (id, couple_id, paid_by, amount_satang, merchant, occurred_at, day, split_mode, source, created_by) VALUES
      (1, 1, 1, 70000, 'กาแฟ', '2026-09-28T01:00:00Z', '2026-09-28', 'half', 'text', 1),
      (2, 1, 2, 10000, 'ชา', '2026-09-29T01:00:00Z', '2026-09-29', 'half', 'text', 2);
    INSERT INTO expense_shares VALUES (1, 1, 35000), (1, 2, 35000), (2, 1, 5000), (2, 2, 5000);
    INSERT INTO daily_summaries (id, couple_id, date, net_satang, paid_satang, action) VALUES (1, 1, '2026-09-28', 35000, 30000, 'request');
    INSERT INTO settlements (id, couple_id, from_member, to_member, amount_satang, day, summary_id, slip_id, created_by) VALUES
      (1, 1, 2, 1, 30000, '2026-09-29', 1, 1, 2), (2, 1, 1, 2, 1000, '2026-09-29', NULL, NULL, 1);
    INSERT INTO adjustments (couple_id, day, delta_satang, expense_id, reason) VALUES (1, '2026-09-29', 200, 1, 'x');
    INSERT INTO audit_log (couple_id, entity, entity_id, member_id, action) VALUES (1, 'expense', 1, 1, 'create');
  `)
  const tables = ['couples', 'members', 'slips', 'expenses', 'expense_shares', 'daily_summaries', 'settlements', 'adjustments', 'audit_log']
  const snap = () => Object.fromEntries(tables.map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n]))
  const before = snap()
  const repoBefore = new Repo(db)
  // ยอดก่อน migrate คำนวณด้วย SQL ตรง (repo ใหม่อ่านคอลัมน์ใหม่ไม่ได้บน v2) = ยกมา 5000 − ส่วนของเอในชา 5000 + เอโอนให้บี 1000 + ปรับ 200
  const expectedNet = (35000 - 30000) - 5000 + 1000 + 200
  assert.equal(migrate(db), MIGRATIONS.length)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, MIGRATIONS.length)
  assert.deepEqual(snap(), before)
  assert.equal(repoBefore.ledger(1, '2026-09-29').net, expectedNet)
  const st = repoBefore.settlement(1)!
  assert.deepEqual([st.status, st.kind], ['active', 'transfer'])
  assert.equal(repoBefore.slip(1)!.ignored, 0)
  assert.equal(repoBefore.member(1)!.account_suffixes, '[]')
  assert.equal(repoBefore.member(1)!.bank_names, '["เอ"]')
  assert.equal(repoBefore.couple(1)!.ai_daily_cap, 10)
  // migration ใหม่ต้องเพิ่มอย่างเดียว
  for (const sql of MIGRATIONS.slice(2)) assert.doesNotMatch(sql, /\b(DROP|RENAME|INSERT INTO|DELETE FROM|UPDATE)\b/i)
})

test('npm run job:backup ไม่ migrate: DB v2 → ไฟล์สำรองยังเป็น v2 และ DB เดิมยังเป็น v2', () => {
  const dir = tmpDir()
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'harnkan.db'))
  for (const [i, sql] of MIGRATIONS.slice(0, 2).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1}`)
  db.close()
  const root = join(import.meta.dirname, '..')
  execFileSync(process.execPath, ['--experimental-strip-types', '--experimental-sqlite', '--no-warnings', join(root, 'src/jobs/backup.ts')], {
    env: { ...process.env, HARNKAN_ENV: '/nonexistent', DATA_DIR: dir, BACKUP_DIR: join(dir, 'bk') }, stdio: 'pipe',
  })
  const [gz] = readdirSync(join(dir, 'bk')).filter((f) => f.endsWith('.db.gz'))
  const restored = join(dir, 'restored.db')
  writeFileSync(restored, gunzipSync(readFileSync(join(dir, 'bk', gz))))
  const v = (p: string) => { const d = new DatabaseSync(p); const n = d.prepare('PRAGMA user_version').get()!.user_version; d.close(); return n }
  assert.equal(v(restored), 2)
  assert.equal(v(join(dir, 'harnkan.db')), 2)
})
