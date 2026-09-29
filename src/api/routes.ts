import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import QRCode from 'qrcode'
import type { Ctx } from '../app.ts'
import type { Couple, CoupleSettings, Expense, ExpensePatch, Member, Settlement, Slip } from '../db/repo.ts'
import { decide } from '../domain/balance.js'
import { effect, MODES } from '../domain/split.js'
import type { SplitMode } from '../domain/split.js'
import { addDays, businessDay } from '../domain/time.js'
import { isPromptpayId, promptpayPayload } from '../promptpay/qr.ts'
import { validateName } from '../domain/name.js'
import { HttpError, readBody, send } from '../http.ts'
import { closeBalance } from '../settle.ts'
import { classify, PENDING_ANSWER_HOURS, SELF_MERCHANT, STALE_SLIP_HOURS } from '../slip/classify.ts'
import { fixSlip } from '../slip/flow.ts'
import { DUP_WINDOW_MINUTES } from '../dup.ts'
import { wipedMessages, wipeWithBackup } from '../wipe.ts'

export const API_MAX_BYTES = 16 * 1024

type Auth = { couple: Couple; member: Member; members: Member[] }

async function authenticate(ctx: Ctx, req: IncomingMessage, url: URL): Promise<Auth> {
  const m = (req.headers.authorization ?? '').match(/^Bearer (\S{1,4096})$/)
  if (!m) throw new HttpError(401, 'ต้องเข้าสู่ระบบ')
  const r = await ctx.verifier.verify(m[1]).catch(() => ({ reason: 'invalid' as const }))
  if (!('sub' in r)) throw Object.assign(new HttpError(401, 'token ไม่ถูกต้อง'), { reason: r.reason })
  const mine = ctx.repo.membersByLineUser(r.sub)
  const wanted = url.searchParams.get('couple')
  const member = wanted ? mine.find((x) => String(x.couple_id) === wanted) : mine[0]
  if (!member) throw new HttpError(403, 'ยังไม่ได้อยู่ในกลุ่มหารกัน')
  return { couple: ctx.repo.couple(member.couple_id)!, member, members: ctx.repo.members(member.couple_id) }
}

const bad = (msg: string) => new HttpError(400, msg)

async function jsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const buf = await readBody(req, API_MAX_BYTES)
  try {
    const v = JSON.parse(buf.toString('utf8') || '{}')
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw 0
    return v
  } catch {
    throw bad('JSON ไม่ถูกต้อง')
  }
}

// ---------- validation ----------
const isInt = (v: unknown, min: number, max: number): v is number => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
function text(v: unknown, field: string, max = 60) {
  if (typeof v !== 'string' || !v.trim() || v.length > max) throw bad(`${field} ต้องเป็นข้อความ 1–${max} ตัวอักษร`)
  return v.trim()
}
function amount(v: unknown) {
  if (!isInt(v, 1, 100_000_000)) throw bad('amount ต้องเป็นสตางค์ (จำนวนเต็ม 1–100,000,000)')
  return v
}
function mode(v: unknown): SplitMode {
  if (!MODES.includes(v as SplitMode)) throw bad(`split_mode ต้องเป็น ${MODES.join('/')}`)
  return v as SplitMode
}
function ratio(v: unknown) {
  if (v === null) return null
  if (!isInt(v, 0, 100)) throw bad('ratio ต้องเป็น 0–100')
  return v
}
function memberId(v: unknown, a: Auth) {
  if (!a.members.some((m) => m.id === v)) throw bad('paid_by ต้องเป็นสมาชิกของคู่นี้')
  return v as number
}

export function expenseJson(e: Expense) {
  return {
    id: e.id, merchant: e.merchant, amount: e.amount_satang, paid_by: e.paid_by, payer: e.payer, split_mode: e.split_mode,
    ratio: e.ratio, shares: e.shares, effect: effect(e.payer, e.shares), day: e.day, occurred_at: e.occurred_at,
    category: e.category, source: e.source, slip_id: e.slip_id, status: e.status,
  }
}
const memberJson = (m: Member) => ({
  id: m.id, display_name: m.display_name, promptpay_id: m.promptpay_id, bank_names: JSON.parse(m.bank_names) as string[],
  account_suffixes: JSON.parse(m.account_suffixes || '[]') as string[], bank_name: m.bank_name ?? null, bank_account: m.bank_account ?? null,
})
const settingsJson = (c: Couple, cfg: Ctx['cfg']) => ({
  settle_time: c.settle_time, min_transfer: c.min_transfer, default_split: c.default_split,
  ai_daily_cap: c.ai_daily_cap ?? cfg.aiDailyCap, slip_retention_days: c.slip_retention_days ?? cfg.slipRetentionDays,
  stale_slip_hours: c.stale_slip_hours ?? STALE_SLIP_HOURS, pending_answer_hours: c.pending_answer_hours ?? PENDING_ANSWER_HOURS,
  dup_window_minutes: c.dup_window_minutes ?? DUP_WINDOW_MINUTES,
})
const settlementJson = (s: Settlement) => ({ id: s.id, from: s.from_member, to: s.to_member, amount: s.amount_satang, kind: s.kind, day: s.day, summary_id: s.summary_id, slip_id: s.slip_id })

/** สลิปที่ "ไม่นับ" (7 วันล่าสุด) ให้กดนับทีหลังได้ · ชื่อรายการตามกฎเดียวกับตอนบันทึก (บุคคลอื่นไม่ใช้ชื่อบนสลิป) */
function ignoredSlips(ctx: Ctx, a: Auth) {
  const now = ctx.now()
  ctx.repo.expireStaleSlips(a.couple.id, new Date(now - (a.couple.pending_answer_hours ?? PENDING_ANSWER_HOURS) * 3600_000).toISOString())
  return ctx.repo.ignoredSlips(a.couple.id, new Date(now - 7 * 86400_000).toISOString()).map((s: Slip) => {
    const ai = s.ai_json ? JSON.parse(s.ai_json) : null
    const poster = a.members.find((m) => m.id === s.member_id)
    const c = ai && poster ? classify({ ...ai, amount: s.amount_satang! / 100 }, poster, a.members) : null
    const label = c?.kind === 'expense' ? c.merchant : c?.kind === 'self' ? SELF_MERCHANT : c?.kind === 'settlement' ? 'โอนระหว่างคู่' : 'สลิป'
    return { id: s.id, amount: s.amount_satang, label, member_id: s.member_id, created_at: s.created_at }
  })
}

/** ยอดที่ควรโอนตอนนี้: สรุปล่าสุดที่ยังค้าง ถ้าไม่มีใช้ยอดสด · ยอดสดเป็น 0 = ไม่มีใครติดใคร (เช่นหลังปิดยอดเป็น 0) */
function pending(ctx: Ctx, a: Auth, day: string) {
  if (ctx.repo.ledger(a.couple.id, day).net === 0) return null
  const open = ctx.repo.latestSummary(a.couple.id, '9999-12-31')
  const net = open && !open.settled && ctx.repo.outstanding(open) !== 0 ? ctx.repo.outstanding(open) : ctx.repo.ledger(a.couple.id, day).net
  const d = decide(net, 0)
  if (d.action === 'zero') return null
  const to = a.members[d.to]
  return { amount: d.amount, from: a.members[d.from].id, to: to.id, promptpay_id: to.promptpay_id, bank_name: to.bank_name ?? null, bank_account: to.bank_account ?? null, summary_date: open && !open.settled ? open.date : null }
}

function ownExpense(ctx: Ctx, a: Auth, id: string) {
  const e = ctx.repo.expense(Number(id))
  if (!e || e.couple_id !== a.couple.id) throw new HttpError(404, 'ไม่พบรายการ')
  return e
}

/** จัดการ /api/* · คืน false ถ้าไม่ใช่ path ของ API */
export async function handleApi(ctx: Ctx, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith('/api/')) return false
  const a = await authenticate(ctx, req, url)
  const { repo } = ctx
  const today = businessDay(ctx.now(), a.couple.settle_time)
  const p = url.pathname
  const M = req.method
  let m: RegExpMatchArray | null

  if (M === 'GET' && p === '/api/me') {
    return send(res, 200, { me: a.member.id, couple_id: a.couple.id, members: a.members.map(memberJson), settings: settingsJson(a.couple, ctx.cfg), today }), true
  }
  if (M === 'GET' && p === '/api/today') {
    const l = repo.ledger(a.couple.id, today)
    return send(res, 200, {
      day: today, net: l.net, carried_in: l.carriedIn, adjustments: l.adjustments, expenses: l.expenses.map(expenseJson),
      settlements: repo.settlementsByDay(a.couple.id, today).map(settlementJson),
      pending: pending(ctx, a, today), ignored_slips: ignoredSlips(ctx, a),
    }), true
  }
  if (M === 'GET' && p === '/api/days') {
    const month = url.searchParams.get('month') ?? today.slice(0, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('month ต้องเป็น YYYY-MM')
    const from = `${month}-01`
    const to = addDays(`${addDays(from, 31).slice(0, 7)}-01`, -1)
    const days = new Map<string, { date: string; bills: number; spent: number; net: number | null; action: string | null; settled: boolean }>()
    const day = (d: string) => days.get(d) ?? days.set(d, { date: d, bills: 0, spent: 0, net: null, action: null, settled: false }).get(d)!
    for (const e of repo.expensesBetween(a.couple.id, from, to)) {
      const x = day(e.day)
      x.bills++
      x.spent += e.amount_satang
    }
    for (const s of repo.summariesBetween(a.couple.id, from, to)) Object.assign(day(s.date), { net: s.net_satang, action: s.action, settled: !!s.settled })
    if (today >= from && today <= to && days.has(today)) day(today).net = repo.ledger(a.couple.id, today).net
    return send(res, 200, { month, days: [...days.values()].sort((x, y) => x.date.localeCompare(y.date)) }), true
  }
  if (M === 'GET' && (m = p.match(/^\/api\/days\/(\d{4}-\d{2}-\d{2})$/))) {
    const s = repo.summary(a.couple.id, m[1])
    return send(res, 200, { date: m[1], expenses: repo.expensesByDay(a.couple.id, m[1]).map(expenseJson), settlements: repo.settlementsByDay(a.couple.id, m[1]).map(settlementJson), summary: s ?? null }), true
  }
  if (M === 'DELETE' && (m = p.match(/^\/api\/settlements\/(\d{1,12})$/))) {
    const st = repo.settlement(Number(m[1]))
    if (!st || st.couple_id !== a.couple.id || st.status !== 'active') throw new HttpError(404, 'ไม่พบรายการ')
    return send(res, 200, { settlement: settlementJson(repo.deleteSettlement(st.id, a.member.id, today)), net: repo.ledger(a.couple.id, today).net }), true
  }
  if (M === 'POST' && p === '/api/settle/close') {
    const r = await closeBalance(ctx, a.couple, a.member)
    if (!r) throw bad('ยอดเป็น 0 อยู่แล้ว')
    return send(res, 200, { ...r, net_after: repo.ledger(a.couple.id, today).net }), true
  }
  if (M === 'POST' && (m = p.match(/^\/api\/slips\/(\d{1,12})\/count$/))) {
    const s = repo.slip(Number(m[1]))
    if (!s || s.couple_id !== a.couple.id || !s.ignored || !s.amount_satang) throw new HttpError(404, 'ไม่พบสลิปที่ไม่นับ')
    fixSlip(ctx, a, s, 'count', a.member.id)
    return send(res, 200, { net: repo.ledger(a.couple.id, today).net }), true
  }
  if (p === '/api/wipe') {
    if (M === 'GET') return send(res, 200, repo.wipeCounts(a.couple.id)), true
    if (M === 'POST') {
      const b = await jsonBody(req)
      if (b.confirm !== 'ลบ') throw bad('ต้องพิมพ์คำว่า "ลบ" เพื่อยืนยัน')
      const r = wipeWithBackup(ctx, a.couple.id, a.member.id)
      if (!r.ok) throw new HttpError(503, 'สำรองข้อมูลไม่สำเร็จ จึงยังไม่ได้ลบอะไร')
      await ctx.line.push(a.couple.line_group_id, [{ type: 'text', text: `${a.member.display_name} ลบข้อมูลทั้งหมดจากแอปแล้ว (สำรองไว้ก่อนลบ)` }, ...wipedMessages(ctx).slice(1)])
      return send(res, 200, { ok: true }), true
    }
  }
  if ((m = p.match(/^\/api\/expenses\/(\d{1,12})$/))) {
    const e = ownExpense(ctx, a, m[1])
    if (M === 'GET') return send(res, 200, { expense: expenseJson(e), audit: repo.auditFor('expense', e.id).map((r) => ({ action: r.action, member_id: r.member_id })) }), true
    if (M === 'DELETE') {
      if (e.status !== 'active') throw new HttpError(404, 'ไม่พบรายการ')
      return send(res, 200, { expense: expenseJson(repo.deleteExpense(e.id, a.member.id, today)) }), true
    }
    if (M === 'PATCH') {
      if (e.status !== 'active') throw new HttpError(404, 'ไม่พบรายการ')
      const b = await jsonBody(req)
      const patch: ExpensePatch = {}
      for (const k of Object.keys(b)) {
        if (k === 'merchant') patch.merchant = text(b.merchant, 'merchant')
        else if (k === 'amount') patch.amount = amount(b.amount)
        else if (k === 'split_mode') patch.mode = mode(b.split_mode)
        else if (k === 'ratio') patch.ratio = ratio(b.ratio)
        else if (k === 'paid_by') patch.paidBy = memberId(b.paid_by, a)
        else if (k === 'category') patch.category = b.category === null ? null : text(b.category, 'category', 30)
        else throw bad(`แก้ ${k} ไม่ได้`)
      }
      if (!Object.keys(patch).length) throw bad('ไม่มีอะไรให้แก้')
      return send(res, 200, { expense: expenseJson(repo.updateExpense(e.id, patch, a.member.id, today)) }), true
    }
  }
  if (M === 'POST' && p === '/api/expenses') {
    const b = await jsonBody(req)
    const e = repo.createExpense({
      coupleId: a.couple.id, paidBy: b.paid_by === undefined ? a.member.id : memberId(b.paid_by, a), amount: amount(b.amount),
      merchant: b.merchant === undefined ? 'ไม่ระบุ' : text(b.merchant, 'merchant'), category: null,
      occurredAt: new Date(ctx.now()).toISOString(), day: today, mode: b.split_mode === undefined ? a.couple.default_split : mode(b.split_mode),
      ratio: b.ratio === undefined ? null : ratio(b.ratio), source: 'manual', createdBy: a.member.id, createdAt: new Date(ctx.now()).toISOString(),
    })
    return send(res, 201, { expense: expenseJson(e) }), true
  }
  if (M === 'GET' && (m = p.match(/^\/api\/slips\/(\d{1,12})\/image$/))) {
    const s = repo.slip(Number(m[1]))
    if (!s || s.couple_id !== a.couple.id || !s.image_path) throw new HttpError(404, 'ไม่พบรูป')
    const root = resolve(ctx.cfg.dataDir, 'slips')
    const f = resolve(ctx.cfg.dataDir, s.image_path)
    if (!f.startsWith(root + '/')) throw new HttpError(404, 'ไม่พบรูป')
    let buf: Buffer
    try {
      buf = readFileSync(f)
    } catch {
      throw new HttpError(404, 'ไม่พบรูป')
    }
    const type = f.endsWith('.png') ? 'image/png' : f.endsWith('.webp') ? 'image/webp' : 'image/jpeg'
    return send(res, 200, buf, { 'content-type': type, 'cache-control': 'private, max-age=86400' }), true
  }
  if (M === 'GET' && p === '/api/settle/qr.png') {
    const pd = pending(ctx, a, today)
    if (!pd || !pd.promptpay_id) throw new HttpError(404, 'ไม่มียอดค้างหรือยังไม่ได้ตั้งพร้อมเพย์')
    const png = await QRCode.toBuffer(promptpayPayload(pd.promptpay_id, pd.amount), { width: 480, margin: 2 })
    return send(res, 200, png, { 'content-type': 'image/png', 'cache-control': 'no-store' }), true
  }
  if (M === 'PATCH' && p === '/api/settings') {
    const b = await jsonBody(req)
    const c: CoupleSettings = {}
    const me: Parameters<typeof repo.updateMember>[1] = {}
    for (const k of Object.keys(b)) {
      const v = b[k]
      if (k === 'settle_time') {
        if (typeof v !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) throw bad('settle_time ต้องเป็น HH:MM')
        c.settle_time = v
      } else if (k === 'min_transfer') {
        if (!isInt(v, 0, 1_000_000)) throw bad('min_transfer ต้องเป็นสตางค์ 0–1,000,000')
        c.min_transfer = v
      } else if (k === 'default_split') {
        const md = mode(v)
        if (md === 'ratio') throw bad('default_split เป็น ratio ไม่ได้')
        c.default_split = md
      } else if (k === 'ai_daily_cap') {
        if (v !== null && !isInt(v, 0, 500)) throw bad('ai_daily_cap ต้องเป็น 0–500')
        c.ai_daily_cap = v as number | null
      } else if (k === 'slip_retention_days') {
        if (v !== null && !isInt(v, 1, 3650)) throw bad('slip_retention_days ต้องเป็น 1–3650')
        c.slip_retention_days = v as number | null
      } else if (k === 'promptpay_id') {
        if (v !== null && (typeof v !== 'string' || !isPromptpayId(v))) throw bad('promptpay_id ต้องเป็นเบอร์ 10 หลัก เลขบัตร 13 หลัก หรือ e-wallet 15 หลัก')
        me.promptpay_id = v === null ? null : (v as string).replace(/[\s-]/g, '')
      } else if (k === 'bank_names') {
        if (!Array.isArray(v) || v.length > 5 || !v.every((x) => typeof x === 'string' && x.trim() && x.length <= 60)) throw bad('bank_names ต้องเป็นรายชื่อไม่เกิน 5 ชื่อ')
        me.bank_names = v.map((x: string) => x.trim())
      } else if (k === 'stale_slip_hours') {
        if (v !== null && !isInt(v, 0, 720)) throw bad('stale_slip_hours ต้องเป็น 0–720 (0 = ไม่ถาม)')
        c.stale_slip_hours = v as number | null
      } else if (k === 'pending_answer_hours') {
        if (v !== null && !isInt(v, 1, 168)) throw bad('pending_answer_hours ต้องเป็น 1–168')
        c.pending_answer_hours = v as number | null
      } else if (k === 'dup_window_minutes') {
        if (v !== null && !isInt(v, 0, 1440)) throw bad('dup_window_minutes ต้องเป็น 0–1440 (0 = ไม่เตือน)')
        c.dup_window_minutes = v as number | null
      } else if (k === 'bank_name') {
        if (v !== null && (typeof v !== 'string' || !v.trim() || v.length > 30)) throw bad('bank_name ต้องเป็นข้อความ 1–30 ตัว')
        me.bank_name = v === null ? null : (v as string).trim()
      } else if (k === 'bank_account') {
        const d = typeof v === 'string' ? v.replace(/[\s-]/g, '') : v
        if (d !== null && (typeof d !== 'string' || !/^\d{10,15}$/.test(d))) throw bad('bank_account ต้องเป็นเลข 10–15 หลัก')
        me.bank_account = d as string | null
      } else if (k === 'account_suffixes') {
        if (!Array.isArray(v) || v.length > 5 || !v.every((x) => typeof x === 'string' && /^\d{4}$/.test(x))) throw bad('เลขท้ายบัญชีต้องเป็นเลข 4 หลัก ไม่เกิน 5 บัญชี')
        me.account_suffixes = v as string[]
      } else if (k === 'display_name') {
        const r = validateName(v, a.members.filter((m) => m.id !== a.member.id).map((m) => m.display_name))
        if (!r.ok) throw new HttpError(400, r.error, 'display_name')
        me.display_name = r.name
      } else throw bad(`ตั้ง ${k} ไม่ได้`)
    }
    const couple = Object.keys(c).length ? repo.updateCouple(a.couple.id, c, a.member.id) : a.couple
    if (Object.keys(me).length) {
      const before = a.member
      const after = repo.updateMember(a.member.id, me)
      repo.audit(a.couple.id, 'member', a.member.id, a.member.id, 'settings', before, after)
    }
    return send(res, 200, { settings: settingsJson(couple, ctx.cfg), members: repo.members(a.couple.id).map(memberJson) }), true
  }
  throw new HttpError(404, 'ไม่พบ')
}

