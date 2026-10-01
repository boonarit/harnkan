// B19: เวลาสรุปยอดตามที่ตั้งในแอปจริง (launchd รันถี่ + ตัดสินต่อคู่) · ข้อความสรุประบุวันที่เสมอ · ปุ่ม "<ชื่อ>เลี้ยง"
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { handlers } from '../src/bot.ts'
import { health } from '../src/health.ts'
import { runSummary } from '../src/jobs/summary.ts'
import { handleEvent } from '../src/line/router.ts'
import type { OutboxItem } from '../src/line/client.ts'
import { SUMMARY_EVERY_MIN } from '../src/domain/time.js'
import { PARSER_WORDS } from '../src/domain/parse.js'
import { validateName } from '../src/domain/name.js'
import { effect, modeLabel } from '../src/domain/split.js'
import { expenseJson } from '../src/api/routes.ts'
import { makeServer } from '../src/server.ts'
import { chipToMode, chipTreatedBy, modeToChip } from '../public/app/format.js'
import { LocalAdapter } from '../public/app/data/adapter.js'
import { demoSeed } from '../demo/seed.js'
import { tmpDir } from './helpers/db.ts'
import { A_ID, B_ID, ev, listen, makeCtx } from './helpers/app.ts'

const ROOT = resolve(import.meta.dirname, '..')
const at = (hm: string, day: string) => Date.parse(`${day}T${hm}:00+07:00`)
const pushes = (out: OutboxItem[]) => out.filter((o) => o.kind === 'push')
/** ข้อความของ push (text หรือ altText ของการ์ด) */
const pushText = (o: OutboxItem) => o.messages.map((m: any) => m.text ?? m.altText).join(' | ')

/** คู่ เอ/บี ลงทะเบียนตอน 08:00 ของวัน day · settle = เวลาสรุปที่ตั้งในแอป */
async function couple(day: string, settle = '21:00') {
  const t = makeCtx({ now: at('08:00', day) })
  const send = async (e: any) => (await handleEvent(t.ctx, e, handlers), t.line.take())
  await send(ev.text(A_ID, 'หวัดดี'))
  await send(ev.text(B_ID, 'หวัดดี'))
  const c = t.repo.allCouples()[0]
  const [a, b] = t.repo.members(c.id)
  if (settle !== '21:00') t.repo.updateCouple(c.id, { settle_time: settle }, a.id)
  /** พิมพ์รายการตอน hm ของวัน d */
  const say = (who: string, text: string, hm: string, d = day) => ((t.clock.t = at(hm, d)), send(ev.text(who, text)))
  /** จำลอง launchd: รันงานสรุปทุก SUMMARY_EVERY_MIN นาที ตั้งแต่ from ถึง to (รวม) · คืน push ที่เกิดพร้อมเวลา */
  const tick = async (from: number, to: number) => {
    const got: { at: number; item: OutboxItem }[] = []
    for (let x = from; x <= to; x += SUMMARY_EVERY_MIN * 60_000) {
      t.clock.t = x
      await runSummary(t.ctx)
      for (const item of pushes(t.line.take())) got.push({ at: x, item })
    }
    return got
  }
  return { ...t, send, say, tick, c: () => t.repo.couple(c.id)!, a, b }
}

// ---------- 1. สรุปตามเวลาที่ตั้ง ----------
test('เวลาสรุป (B19-1): settle 23:00 → 21:00 ไม่สรุปวันนี้ · 23:00–23:00+N สรุปวันนี้ครั้งเดียว · หัวการ์ด "สรุปวันนี้ (1 ต.ค.)" · รันซ้ำ 10 รอบไม่ส่งซ้ำ', async () => {
  const t = await couple('2026-10-01', '23:00')
  await t.say(A_ID, 'ข้าวเย็น 327', '19:00')
  // รอบที่ระบบเดิมรัน (21:00 ตายตัว) + ทุกรอบจนถึงก่อน 23:00 → ไม่มีสรุปของวันนี้
  assert.deepEqual(await t.tick(at('20:00', '2026-10-01'), at('22:50', '2026-10-01')), [])
  assert.equal(t.repo.summary(t.c().id, '2026-10-01'), undefined)
  // ตั้งแต่ 23:00 → push เดียว ภายใน N นาทีหลังเวลาสรุป
  const got = await t.tick(at('23:00', '2026-10-01'), at('23:50', '2026-10-01'))
  assert.equal(got.length, 1)
  assert.ok(got[0].at >= at('23:00', '2026-10-01') && got[0].at < at('23:00', '2026-10-01') + SUMMARY_EVERY_MIN * 60_000)
  assert.match(pushText(got[0].item), /^สรุปวันนี้ \(1 ต\.ค\.\): บี โอนให้ เอ ฿163\.50/)
  assert.equal(t.repo.summary(t.c().id, '2026-10-01')!.net_satang, 16350)
  // รันซ้ำอีก 10 รอบ (รวมข้ามเที่ยงคืน) → ไม่ส่งซ้ำ
  for (let i = 0; i < 10; i++) {
    t.clock.t = at('23:55', '2026-10-01') + i * 60_000 * 7
    await runSummary(t.ctx)
  }
  assert.equal(pushes(t.line.take()).length, 0)
})

test('เวลาสรุป (B19-1): เคสที่เกิดจริง — job รัน 21:00 · settle 23:00 · เมื่อวานยอด 0 → ข้อความมีวันที่ของเมื่อวาน ไม่ใช่ "วันนี้"', async () => {
  const t = await couple('2026-09-30', '23:00')
  await t.say(A_ID, 'ข้าว 100 เลี้ยง', '12:00') // 30 ก.ย. มีรายการ แต่ยอด 0
  t.clock.t = at('21:00', '2026-09-30')
  await runSummary(t.ctx) // ยังไม่ถึง 23:00 ของ 30 ก.ย. → ไม่สรุป
  assert.equal(pushes(t.line.take()).length, 0)
  await t.say(B_ID, 'ส้มตำ 327', '12:00', '2026-10-01') // ยอดวันนี้ค้าง ฿163.50
  // เครื่องหลับตอน 23:00 ของ 30 ก.ย. → รอบแรกที่ตื่นคือ 21:00 ของ 1 ต.ค.
  t.clock.t = at('21:00', '2026-10-01')
  await runSummary(t.ctx)
  const out = pushes(t.line.take())
  assert.equal(out.length, 1)
  const text = pushText(out[0])
  assert.match(text, /^สรุปย้อนหลัง 30 ก\.ย\.: ไม่มีใครติดใคร/)
  assert.ok(!text.includes('วันนี้'), text)
  assert.equal(t.repo.summary(t.c().id, '2026-10-01'), undefined, 'ยอดวันนี้ยังไม่ถูกสรุป')
  // 23:00 ของ 1 ต.ค. → สรุปวันนี้ตามปกติ
  const got = await t.tick(at('23:00', '2026-10-01'), at('23:30', '2026-10-01'))
  assert.equal(got.length, 1)
  assert.match(pushText(got[0].item), /^สรุปวันนี้ \(1 ต\.ค\.\): เอ โอนให้ บี ฿163\.50/)
})

test('เวลาสรุป (B19-1): การ์ดย้อนหลัง (มียอด) ระบุวันที่ · ไม่มีคำว่า "วันนี้" ทั้งการ์ด', async () => {
  const t = await couple('2026-09-30')
  await t.say(A_ID, 'กาแฟ 120', '10:00')
  t.clock.t = at('07:00', '2026-10-01') // เครื่องหลับตั้งแต่ก่อน 21:00 ตื่นเช้าวันถัดไป
  await runSummary(t.ctx)
  const [card] = pushes(t.line.take())
  const json = JSON.stringify(card.messages)
  assert.match(json, /สรุปย้อนหลัง 30 ก\.ย\./)
  assert.ok(!json.includes('วันนี้'), json)
})

test('เวลาสรุป (B19-1): settle 21:00 พฤติกรรมเดิมไม่เปลี่ยน — 20:50 ไม่สรุป · 21:00 สรุปวันนี้ครั้งเดียว', async () => {
  const t = await couple('2026-10-01')
  await t.say(A_ID, 'กาแฟ 120', '10:00')
  assert.deepEqual(await t.tick(at('20:00', '2026-10-01'), at('20:50', '2026-10-01')), [])
  const got = await t.tick(at('21:00', '2026-10-01'), at('23:50', '2026-10-01'))
  assert.equal(got.length, 1)
  assert.equal(got[0].at, at('21:00', '2026-10-01'))
  assert.match(pushText(got[0].item), /^สรุปวันนี้ \(1 ต\.ค\.\): บี โอนให้ เอ ฿60\.00/)
})

test('เวลาสรุป (B19-1): เปลี่ยน settle 21:00 → 23:00 ตอน 22:00 (หลังสรุปไปแล้ว) → ไม่ส่งซ้ำ · รายการช่วงนั้นไม่หาย ไปอยู่วันถัดไป', async () => {
  const t = await couple('2026-10-01')
  await t.say(A_ID, 'กาแฟ 120', '10:00')
  assert.equal((await t.tick(at('21:00', '2026-10-01'), at('21:00', '2026-10-01'))).length, 1)
  await t.say(A_ID, 'ขนม 60', '21:30') // หลังสรุป → วันถัดไป
  t.clock.t = at('22:00', '2026-10-01')
  t.repo.updateCouple(t.c().id, { settle_time: '23:00' }, t.a.id)
  await t.say(B_ID, 'น้ำ 40', '22:30') // ตามเวลาใหม่ยังเป็น 1 ต.ค. แต่ 1 ต.ค. ปิดยอดแล้ว
  assert.deepEqual(await t.tick(at('22:00', '2026-10-01'), at('22:00', '2026-10-02')), [], 'ไม่ส่งซ้ำ ไม่สรุปก่อนเวลาใหม่')
  const got = await t.tick(at('23:00', '2026-10-02'), at('23:30', '2026-10-02'))
  assert.equal(got.length, 1, 'ไม่ข้ามวัน')
  const s = t.repo.summary(t.c().id, '2026-10-02')!
  // 1 ต.ค.: บีค้างเอ 60 (ยังไม่โอน ยกมา) · 2 ต.ค.: ขนม (เอจ่าย) +30 · น้ำ (บีจ่าย) −20 → 70
  assert.equal(s.net_satang, 6000 + 3000 - 2000)
  assert.match(pushText(got[0].item), /^สรุปวันนี้ \(2 ต\.ค\.\): บี โอนให้ เอ ฿70\.00/)
  assert.match(JSON.stringify(got[0].item.messages), /จาก 2 รายการ/)
})

test('เวลาสรุป (B19-1): ไม่ย้อนไปสรุปวันที่เก่ากว่าสรุปล่าสุด — 30 ก.ย. ไม่มีสรุป (เครื่องหลับ) · 1 ต.ค. สรุปแล้ว · เลื่อนเวลาสรุปเป็น 23:00 ตอน 22:00 → ไม่มีการ์ด 30 ก.ย. โผล่', async () => {
  const t = await couple('2026-09-30')
  await t.say(A_ID, 'กาแฟ 120', '10:00', '2026-10-01')
  assert.equal((await t.tick(at('21:00', '2026-10-01'), at('21:00', '2026-10-01'))).length, 1)
  t.repo.updateCouple(t.c().id, { settle_time: '23:00' }, t.a.id)
  assert.deepEqual(await t.tick(at('22:00', '2026-10-01'), at('22:50', '2026-10-01')), [])
  assert.equal(t.repo.summary(t.c().id, '2026-09-30'), undefined)
})

test('เวลาสรุป (B19-1): ไม่สรุปวันก่อนที่คู่ถูกสร้าง (เช่นหลังลบข้อมูลทั้งหมด)', async () => {
  const t = await couple('2026-10-01')
  t.clock.t = at('08:10', '2026-10-01')
  const [r] = await runSummary(t.ctx)
  assert.equal(r.action, 'skip')
  assert.equal(t.repo.summary(t.c().id, '2026-09-30'), undefined)
})

test('healthz (B19-1): stale นับคืนที่ขาดตาม settle_time ของคู่ — settle 23:00 ตอน 22:00 ยังไม่นับคืนนี้ · เลย 23:00 แล้วขาด 2 คืน → stale', async () => {
  const t = await couple('2026-09-29', '23:00')
  await t.say(A_ID, 'กาแฟ 90', '10:00')
  t.clock.t = at('23:00', '2026-09-29')
  await runSummary(t.ctx)
  t.line.take()
  await t.say(A_ID, 'กาแฟ 90', '10:00', '2026-10-01')
  // งานสรุปไม่ได้รันเลยหลัง 29 ก.ย. · ตอน 22:00 ของ 1 ต.ค. ยังไม่ถึงเวลาสรุปของคืนนี้ → ขาดคืนเดียว (30 ก.ย.)
  t.clock.t = at('22:00', '2026-10-01')
  assert.equal(health(t.ctx).stale, false, JSON.stringify(health(t.ctx).reasons))
  t.clock.t = at('23:05', '2026-10-01')
  const h = health(t.ctx)
  assert.equal(h.stale, true)
  assert.match(h.reasons.join(), /ไม่ได้สรุปยอด 2 คืน/)
})

test('plist (B19-1): งานสรุปรันทุก SUMMARY_EVERY_MIN นาที (StartInterval 300–900 วิ) ไม่ใช่เวลาตายตัว · หน้าตั้งค่าบอก N นาที', () => {
  const p = readFileSync(join(ROOT, 'deploy/com.harnkan.summary.plist'), 'utf8')
  assert.ok(!p.includes('StartCalendarInterval'), 'ห้ามเวลาตายตัว')
  const sec = Number(p.match(/<key>StartInterval<\/key><integer>(\d+)<\/integer>/)![1])
  assert.equal(sec, SUMMARY_EVERY_MIN * 60)
  assert.ok(sec >= 300 && sec <= 900)
  const main = readFileSync(join(ROOT, 'public/app/main.js'), 'utf8')
  assert.match(main, /การ์ดสรุปจะมาภายใน \$\{SUMMARY_EVERY_MIN\} นาทีหลังเวลานี้/)
  assert.match(readFileSync(join(ROOT, 'docs/DEPLOY.md'), 'utf8'), new RegExp(`ทุก ${SUMMARY_EVERY_MIN} นาที`))
})

// ---------- 2. ปุ่ม "<ชื่อ>เลี้ยง" ----------
const quick = (out: OutboxItem[]) => out.flatMap((o) => o.messages).flatMap((m: any) => m.quickReply?.items ?? []).map((i: any) => i.action)
/** แถว "หาร" ในการ์ดรายการ */
const splitRow = (out: OutboxItem[]) => {
  const card = out.flatMap((o) => o.messages).find((m: any) => m.type === 'flex') as any
  const row = card.contents.body.contents.find((c: any) => c.contents?.[0]?.text === 'หาร')
  return row.contents[1].text as string
}

test('เลี้ยง (B19-2): 5 ปุ่ม × คนจ่าย 2 คน → ผลต่อยอดถูก + ป้ายถูก (การ์ด · แอป)', async () => {
  const t = await couple('2026-10-01')
  const { a, b } = t
  const name = { [a.id]: 'เอ', [b.id]: 'บี' }
  for (const [payer, uid] of [[a, A_ID], [b, B_ID]] as const) {
    for (const btn of ['หารครึ่ง', 'ของเอ', 'ของบี', 'เอเลี้ยง', 'บีเลี้ยง']) {
      const card = await t.say(uid, 'ข้าว 100', '10:00')
      const act = quick(card).find((x) => x.label === btn)
      assert.ok(act, `${btn} ไม่มีในการ์ด`)
      assert.equal(act.displayText, btn)
      const out = await t.send(ev.postback(uid, act.data))
      const e = t.repo.expensesByDay(t.c().id, '2026-10-01').at(-1)!
      // ใครรับผิดชอบทั้งก้อน: ของX / Xเลี้ยง = X · หารครึ่ง = ครึ่ง
      const bearer = btn === 'หารครึ่ง' ? null : btn.includes('เอ') ? a : b
      const want = bearer === null ? (payer.id === a.id ? 5000 : -5000) : bearer.id === payer.id ? 0 : bearer.id === a.id ? -10000 : 10000
      assert.equal(effect(e.payer, e.shares), want, `${name[payer.id]}จ่าย กด ${btn}`)
      assert.equal(splitRow(out), btn, `ป้ายการ์ด ${name[payer.id]}จ่าย กด ${btn}`)
      assert.equal(modeLabel(expenseJson(e), t.repo.members(t.c().id)), btn, 'ป้ายในแอป')
      if (btn.endsWith('เลี้ยง')) {
        assert.equal(e.treated_by, bearer!.id)
        assert.equal(e.split_mode, bearer!.id === payer.id ? 'treat' : 'theirs')
      } else assert.equal(e.treated_by, null)
    }
  }
})

test('เลี้ยง (B19-2): postback อ้าง member id — สร้างการ์ด → เปลี่ยนชื่อ → กดปุ่มเก่า → treated_by ถูกคน · การ์ดใหม่ใช้ชื่อใหม่ · การ์ดก่อน B19 (split:<id>:treat) = คนจ่ายเลี้ยง', async () => {
  const t = await couple('2026-10-01')
  const card = await t.say(A_ID, 'ราดหน้า 120', '10:00')
  const old = quick(card).find((x) => x.label === 'บีเลี้ยง')
  assert.equal(old.data, `split:${t.repo.expensesByDay(t.c().id, '2026-10-01')[0].id}:treat:${t.b.id}`)
  await t.send(ev.text(B_ID, 'ตั้งชื่อ ส้ม'))
  const out = await t.send(ev.postback(A_ID, old.data))
  const e = t.repo.expensesByDay(t.c().id, '2026-10-01')[0]
  assert.equal(e.treated_by, t.b.id)
  assert.equal(effect(e.payer, e.shares), 12000)
  assert.equal(splitRow(out), 'ส้มเลี้ยง', 'ชื่อปัจจุบันตอนแสดง')
  assert.ok(quick(out).some((x) => x.label === 'ส้มเลี้ยง' && x.data.endsWith(`:treat:${t.b.id}`)))
  // บีเลี้ยง → กด "ของส้ม" (โหมดเงินเท่ากัน = theirs) → ป้ายต้องเปลี่ยนเป็น "ของส้ม"
  const own = quick(out).find((x) => x.label === 'ของส้ม')
  assert.equal(splitRow(await t.send(ev.postback(A_ID, own.data))), 'ของส้ม')
  assert.equal(t.repo.expense(e.id)!.treated_by, null)
  // ปุ่มของการ์ดรุ่นก่อน
  const legacy = await t.send(ev.postback(B_ID, `split:${e.id}:treat`))
  const e2 = t.repo.expense(e.id)!
  assert.deepEqual([e2.split_mode, e2.treated_by, effect(e2.payer, e2.shares)], ['treat', t.a.id, 0])
  assert.equal(splitRow(legacy), 'เอเลี้ยง')
  // member id ที่ไม่อยู่ในคู่ → ไม่ทำอะไร
  assert.deepEqual(await t.send(ev.postback(A_ID, `split:${e.id}:treat:999`)), [])
  assert.equal(t.repo.expense(e.id)!.split_mode, 'treat')
})

test('เลี้ยง (B19-2): ชื่อยาว 40 ตัว (มีอีโมจิ) → label ไม่เกิน 20 ตัว ไม่ผ่ากลางอีโมจิ คำว่าเลี้ยง/ของยังอยู่', async () => {
  const t = await couple('2026-10-01')
  const long = 'บี🐰'.repeat(13) + 'บ' // 40 code point · อีโมจิ = surrogate pair
  assert.equal([...long].length, 40)
  assert.ok(validateName(long, ['เอ']).ok)
  t.repo.updateMember(t.b.id, { display_name: long })
  const acts = quick(await t.say(A_ID, 'ข้าว 100', '10:00'))
  assert.equal(acts.length, 5)
  for (const x of acts) {
    assert.ok([...x.label].length <= 20, `${x.label} ยาว ${[...x.label].length}`)
    assert.ok(x.label.isWellFormed(), `ผ่ากลางอีโมจิ: ${x.label}`)
  }
  const treat = acts.find((x) => x.data.endsWith(`:treat:${t.b.id}`))
  assert.match(treat.label, /^บี🐰.*…เลี้ยง$/)
  assert.equal(treat.displayText, `${long}เลี้ยง`)
  assert.match(acts[2].label, /^ของบี🐰.*…$/)
})

test('เลี้ยง (B19-2): พิมพ์ "<ชื่อ>เลี้ยง" เทียบ display_name ปัจจุบัน · "เลี้ยง" เฉยๆ = คนจ่ายเลี้ยง · ชื่อที่ไม่ใช่สมาชิก → ไม่เข้าโหมดเลี้ยง', async () => {
  const t = await couple('2026-10-01')
  const last = () => t.repo.expensesByDay(t.c().id, '2026-10-01').at(-1)!
  const n = () => t.repo.expensesByDay(t.c().id, '2026-10-01').length
  let out = await t.say(A_ID, 'ราดหน้า 120 บีเลี้ยง', '10:00')
  assert.deepEqual([last().merchant, last().split_mode, last().treated_by, effect(last().payer, last().shares)], ['ราดหน้า', 'theirs', t.b.id, 12000])
  assert.equal(splitRow(out), 'บีเลี้ยง')
  out = await t.say(A_ID, 'บีเลี้ยง ส้มตำ 80', '10:01')
  assert.deepEqual([last().merchant, last().treated_by], ['ส้มตำ', t.b.id])
  out = await t.say(B_ID, 'กาแฟ 90 บีเลี้ยง', '10:02')
  assert.deepEqual([last().split_mode, last().treated_by, effect(last().payer, last().shares)], ['treat', t.b.id, 0])
  out = await t.say(A_ID, 'ข้าวเย็น 420 เลี้ยง', '10:03')
  assert.deepEqual([last().split_mode, last().treated_by], ['treat', t.a.id])
  assert.equal(splitRow(out), 'เอเลี้ยง')
  // negative control: ชื่อที่ไม่ใช่สมาชิก
  const before = n()
  await t.say(A_ID, 'ราดหน้า 120 ซีเลี้ยง', '10:04')
  assert.ok(n() === before || last().treated_by === null, 'ชื่อที่ไม่ใช่สมาชิกต้องไม่เข้าโหมดเลี้ยง')
  // เปลี่ยนชื่อแล้ว: ชื่อเก่าใช้ไม่ได้ ชื่อใหม่ใช้ได้
  await t.send(ev.text(B_ID, 'ตั้งชื่อ ส้ม'))
  const c1 = n()
  await t.say(A_ID, 'ขนม 50 บีเลี้ยง', '10:05')
  assert.ok(n() === c1 || last().treated_by === null)
  await t.say(A_ID, 'ขนม 50 ส้มเลี้ยง', '10:06')
  assert.deepEqual([last().merchant, last().treated_by], ['ขนม', t.b.id])
  // กฎชื่อสอดคล้องกับ parser: ชื่อห้ามมีคำว่าเลี้ยง (ไม่งั้น "<ชื่อ>เลี้ยง" กำกวม)
  assert.ok(PARSER_WORDS.markers.includes('เลี้ยง'))
  assert.equal(validateName('ส้มเลี้ยง', []).ok, false)
})

test('เลี้ยง (B19-2): mini app — ตัวเลือก 5 แบบ · POST/PATCH treated_by · เปลี่ยนโหมดแล้วคนเลี้ยงถูกล้าง · treated_by ต้องเป็นสมาชิก', async () => {
  const t = await couple('2026-10-01')
  t.clock.t = at('10:00', '2026-10-01')
  const srv = await listen(makeServer(t.ctx))
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(srv.base + path, { method, headers: { authorization: `Bearer fake:${A_ID}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  try {
    const ms = t.repo.members(t.c().id).map((m) => ({ id: m.id, display_name: m.display_name }))
    // ฟอร์มในแอป: เอจ่าย กด "บีเลี้ยง"
    const body = { amount: 12000, merchant: 'ราดหน้า', paid_by: t.a.id, split_mode: chipToMode('t1', 0), treated_by: chipTreatedBy('t1', ms) }
    let r = await call('POST', '/api/expenses', body)
    assert.equal(r.status, 201)
    assert.deepEqual([r.body.expense.split_mode, r.body.expense.treated_by, r.body.expense.effect], ['theirs', t.b.id, 12000])
    assert.equal(modeLabel(r.body.expense, ms), 'บีเลี้ยง')
    assert.equal(modeToChip(r.body.expense.split_mode, 0, ms.findIndex((m) => m.id === r.body.expense.treated_by)), 't1', 'เปิดแก้แล้ว chip เดิมถูกเลือก')
    const id = r.body.expense.id
    r = await call('PATCH', `/api/expenses/${id}`, { split_mode: 'half' })
    assert.deepEqual([r.body.expense.split_mode, r.body.expense.treated_by], ['half', null])
    r = await call('PATCH', `/api/expenses/${id}`, { split_mode: chipToMode('t0', 0), treated_by: chipTreatedBy('t0', ms) })
    assert.deepEqual([r.body.expense.split_mode, r.body.expense.treated_by, r.body.expense.effect], ['treat', t.a.id, 0])
    assert.equal(modeLabel(r.body.expense, ms), 'เอเลี้ยง')
    assert.equal((await call('PATCH', `/api/expenses/${id}`, { split_mode: 'theirs', treated_by: 999 })).status, 400)
    // บีเลี้ยง → "ของบี" (theirs ไม่ส่ง treated_by เหมือนปุ่มแก้สลิป) → ป้ายต้องเป็น ของบี ไม่ใช่ บีเลี้ยง
    await call('PATCH', `/api/expenses/${id}`, { split_mode: 'theirs', treated_by: t.b.id })
    r = await call('PATCH', `/api/expenses/${id}`, { split_mode: 'theirs' })
    assert.deepEqual([r.body.expense.treated_by, modeLabel(r.body.expense, ms)], [null, 'ของบี'])
    const main = readFileSync(join(ROOT, 'public/app/main.js'), 'utf8')
    for (const chip of ['half', '0', '1', 't0', 't1']) assert.ok(main.includes(`data-chip="${chip}"`), chip)
    // ฟอร์มส่ง treated_by จาก chip ที่เลือก (ไม่มี DOM ในเทสต์ → ตรวจบรรทัดที่สร้าง body)
    assert.match(main, /paid_by: me\.members\[payer\]\.id, split_mode: .*, treated_by: chipTreatedBy\(chip, me\.members\) \}/)
  } finally {
    await srv.close()
  }
})

test('migrate v4 → v5 (B19): treat เดิม → ป้าย "<คนจ่าย>เลี้ยง" ยอดเท่าเดิม · treated_by ของเดิมเป็น null', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { MIGRATIONS, migrate } = await import('../src/db/schema.ts')
  const { Repo } = await import('../src/db/repo.ts')
  const db = new DatabaseSync(join(tmpDir(), 'v4.db'))
  for (const [i, sql] of MIGRATIONS.slice(0, 4).entries()) db.exec(`${sql}; PRAGMA user_version = ${i + 1}`)
  db.exec(`
    INSERT INTO couples (id, line_group_id) VALUES (1, 'C_fake_group');
    INSERT INTO members (id, couple_id, line_user_id, display_name) VALUES (1, 1, 'U_fake_a', 'เอ'), (2, 1, 'U_fake_b', 'บี');
    INSERT INTO expenses (id, couple_id, paid_by, amount_satang, merchant, occurred_at, day, split_mode, source, created_by) VALUES
      (1, 1, 2, 42000, 'ข้าวเย็น', '2026-09-29T13:00:00Z', '2026-09-29', 'treat', 'text', 2),
      (2, 1, 1, 9000, 'กาแฟ', '2026-09-29T01:00:00Z', '2026-09-29', 'half', 'text', 1);
    INSERT INTO expense_shares VALUES (1, 1, 0), (1, 2, 42000), (2, 1, 4500), (2, 2, 4500);
  `)
  const before = new Repo(db).ledger(1, '2026-09-29').net
  assert.equal(before, 4500)
  migrate(db)
  assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, 5)
  const r = new Repo(db)
  assert.equal(r.ledger(1, '2026-09-29').net, before)
  const e = r.expense(1)!
  assert.equal(e.treated_by, null)
  const ms = r.members(1)
  assert.equal(modeLabel(e, ms), 'บีเลี้ยง')
  assert.equal(expenseJson(e).treated_by, 2)
  assert.equal(modeLabel(r.expense(2)!, ms), 'หารครึ่ง')
})

test('เลี้ยง (B19-2): เดโม (LocalAdapter) เก็บคนเลี้ยงแบบเดียวกับ server', async () => {
  const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } }
  const now = () => at('10:00', '2026-09-29')
  const api = new LocalAdapter({ storage: mem(), seed: () => demoSeed(now()), now })
  const ms = (await api.me()).members
  const [a, b] = ms
  let { expense } = await api.addExpense({ amount: 12000, merchant: 'ราดหน้า', paid_by: a.id, split_mode: 'theirs', treated_by: b.id })
  assert.deepEqual([expense.treated_by, expense.effect, modeLabel(expense, ms)], [b.id, 12000, `${b.display_name}เลี้ยง`])
  ;({ expense } = await api.updateExpense(expense.id, { split_mode: 'theirs' }))
  assert.deepEqual([expense.treated_by, modeLabel(expense, ms)], [null, `ของ${b.display_name}`])
})
