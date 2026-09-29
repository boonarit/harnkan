import type { DatabaseSync, SQLInputValue } from 'node:sqlite'
import { dailyNet } from '../domain/balance.js'
import { effect, splitShares } from '../domain/split.js'
import type { SplitMode } from '../domain/split.js'

export type Slot = 0 | 1
export type Couple = {
  id: number; line_group_id: string; settle_time: string; min_transfer: number; default_split: SplitMode
  ai_daily_cap: number | null; slip_retention_days: number | null
}
export type CoupleSettings = Partial<Pick<Couple, 'settle_time' | 'min_transfer' | 'default_split' | 'ai_daily_cap' | 'slip_retention_days'>>
export type Member = { id: number; couple_id: number; line_user_id: string; display_name: string; promptpay_id: string | null; bank_names: string }
export type Expense = {
  id: number; couple_id: number; paid_by: number; amount_satang: number; merchant: string; category: string | null
  occurred_at: string; day: string; split_mode: SplitMode; ratio: number | null; source: 'text' | 'slip' | 'manual'
  slip_id: number | null; status: 'active' | 'deleted'; created_by: number | null; created_at: string
  shares: [number, number]; payer: Slot
}
export type Slip = {
  id: number; couple_id: number; member_id: number; image_path: string | null; qr_trans_ref: string | null; bank: string | null
  amount_satang: number | null; sender_name: string | null; receiver_name: string | null; ai_json: string | null
  confidence: number | null; kind: 'expense' | 'settlement' | 'unknown'; status: 'pending' | 'await_amount' | 'done'; created_at: string
}
export type Summary = {
  id: number; couple_id: number; date: string; net_satang: number; carried_in: number; paid_satang: number
  action: 'zero' | 'carry' | 'request'; qr_token: string | null; sent_message_id: string | null; settled: number; created_at: string
}
export type Settlement = { id: number; couple_id: number; from_member: number; to_member: number; amount_satang: number; day: string; summary_id: number | null; slip_id: number | null }

export type NewExpense = {
  coupleId: number; paidBy: number; amount: number; merchant: string; category?: string | null; occurredAt: string; day: string
  mode: SplitMode; ratio?: number | null; source: Expense['source']; slipId?: number | null; createdBy: number | null
  createdAt?: string // เวลาจากนาฬิกาของแอป (ไม่ใส่ = เวลา DB)
}
export type ExpensePatch = Partial<{ merchant: string; amount: number; mode: SplitMode; ratio: number | null; paidBy: number; category: string | null }>

type Row = Record<string, SQLInputValue>

export class Repo {
  db: DatabaseSync
  private inTx = false // ไม่ใช้ db.isTransaction เพราะเพิ่งมีใน Node 22.16+
  constructor(db: DatabaseSync) {
    this.db = db
  }

  private get<T>(sql: string, ...p: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...p) as T | undefined
  }
  private all<T>(sql: string, ...p: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...p) as T[]
  }
  private run(sql: string, ...p: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...p).lastInsertRowid)
  }

  tx<T>(fn: () => T): T {
    if (this.inTx) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.inTx = true
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    } finally {
      this.inTx = false
    }
  }

  // ---------- couples ----------
  coupleByGroup(groupId: string) {
    return this.get<Couple>('SELECT * FROM couples WHERE line_group_id = ?', groupId)
  }
  couple(id: number) {
    return this.get<Couple>('SELECT * FROM couples WHERE id = ?', id)
  }
  allCouples() {
    return this.all<Couple>('SELECT * FROM couples ORDER BY id')
  }
  createCouple(groupId: string, minTransfer = 5000): Couple {
    this.run('INSERT OR IGNORE INTO couples (line_group_id, min_transfer) VALUES (?, ?)', groupId, minTransfer)
    return this.coupleByGroup(groupId)!
  }
  updateCouple(id: number, p: CoupleSettings, memberId: number | null) {
    const before = this.couple(id)!
    const cols = Object.keys(p)
    if (cols.length) this.run(`UPDATE couples SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...(Object.values(p) as SQLInputValue[]), id)
    const after = this.couple(id)!
    this.audit(id, 'couple', id, memberId, 'settings', before, after)
    return after
  }
  deleteCouple(id: number) {
    this.run('DELETE FROM couples WHERE id = ?', id)
  }

  // ---------- members ----------
  members(coupleId: number) {
    return this.all<Member>('SELECT * FROM members WHERE couple_id = ? ORDER BY id', coupleId)
  }
  member(id: number) {
    return this.get<Member>('SELECT * FROM members WHERE id = ?', id)
  }
  memberByLineUser(coupleId: number, lineUserId: string) {
    return this.get<Member>('SELECT * FROM members WHERE couple_id = ? AND line_user_id = ?', coupleId, lineUserId)
  }
  membersByLineUser(lineUserId: string) {
    return this.all<Member>('SELECT * FROM members WHERE line_user_id = ? ORDER BY id', lineUserId)
  }
  addMember(coupleId: number, lineUserId: string, displayName: string): Member {
    const id = this.run('INSERT INTO members (couple_id, line_user_id, display_name) VALUES (?, ?, ?)', coupleId, lineUserId, displayName)
    return this.member(id)!
  }
  updateMember(id: number, p: Partial<{ display_name: string; promptpay_id: string | null; bank_names: string[] }>) {
    const m = this.member(id)!
    this.run(
      'UPDATE members SET display_name = ?, promptpay_id = ?, bank_names = ? WHERE id = ?',
      p.display_name ?? m.display_name, p.promptpay_id !== undefined ? p.promptpay_id : m.promptpay_id,
      p.bank_names ? JSON.stringify(p.bank_names) : m.bank_names, id,
    )
    return this.member(id)!
  }
  slotOf(coupleId: number, memberId: number): Slot {
    const i = this.members(coupleId).findIndex((m) => m.id === memberId)
    if (i < 0) throw new Error('member ไม่อยู่ใน couple นี้')
    return i as Slot
  }

  // ---------- expenses ----------
  private hydrate(row: Omit<Expense, 'shares' | 'payer'> | undefined): Expense | undefined {
    if (!row) return undefined
    const ms = this.members(row.couple_id)
    const shares: [number, number] = [0, 0]
    for (const s of this.all<{ member_id: number; share_satang: number }>('SELECT member_id, share_satang FROM expense_shares WHERE expense_id = ?', row.id)) {
      shares[ms.findIndex((m) => m.id === s.member_id) as Slot] = s.share_satang
    }
    return { ...row, shares, payer: ms.findIndex((m) => m.id === row.paid_by) as Slot }
  }
  expense(id: number) {
    return this.hydrate(this.get('SELECT * FROM expenses WHERE id = ?', id))
  }
  expensesByDay(coupleId: number, day: string, includeDeleted = false) {
    const rows = this.all<Expense>(`SELECT * FROM expenses WHERE couple_id = ? AND day = ? ${includeDeleted ? '' : "AND status = 'active'"} ORDER BY occurred_at, id`, coupleId, day)
    return rows.map((r) => this.hydrate(r)!)
  }
  expensesBetween(coupleId: number, from: string, to: string) {
    return this.all<Expense>("SELECT * FROM expenses WHERE couple_id = ? AND day BETWEEN ? AND ? AND status = 'active' ORDER BY day, occurred_at, id", coupleId, from, to).map((r) => this.hydrate(r)!)
  }
  lastExpenseBy(coupleId: number, memberId: number) {
    return this.hydrate(this.get("SELECT * FROM expenses WHERE couple_id = ? AND created_by = ? AND status = 'active' ORDER BY id DESC LIMIT 1", coupleId, memberId))
  }

  private writeShares(e: { id: number; couple_id: number; amount_satang: number; split_mode: SplitMode; ratio: number | null; paid_by: number }) {
    const ms = this.members(e.couple_id)
    if (ms.length < 2) throw new Error('ต้องมีสมาชิกครบ 2 คนก่อนบันทึกรายการ')
    const payer = ms.findIndex((m) => m.id === e.paid_by) as Slot
    if (payer < 0) throw new Error('คนจ่ายไม่อยู่ใน couple นี้')
    const shares = splitShares(e.amount_satang, e.split_mode, payer, e.id, e.ratio ?? 50)
    this.run('DELETE FROM expense_shares WHERE expense_id = ?', e.id)
    for (const i of [0, 1] as const) this.run('INSERT INTO expense_shares (expense_id, member_id, share_satang) VALUES (?, ?, ?)', e.id, ms[i].id, shares[i])
  }

  createExpense(n: NewExpense): Expense {
    return this.tx(() => {
      const id = this.run(
        `INSERT INTO expenses (couple_id, paid_by, amount_satang, merchant, category, occurred_at, day, split_mode, ratio, source, slip_id, created_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))`,
        n.coupleId, n.paidBy, n.amount, n.merchant, n.category ?? null, n.occurredAt, n.day, n.mode, n.ratio ?? null, n.source, n.slipId ?? null, n.createdBy, n.createdAt ?? null,
      )
      const e = this.get<Expense>('SELECT * FROM expenses WHERE id = ?', id)!
      this.writeShares(e)
      const full = this.expense(id)!
      this.audit(n.coupleId, 'expense', id, n.createdBy, 'create', null, full)
      return full
    })
  }

  /** วันนั้นสรุปยอดไปแล้วหรือยัง — ถ้าแล้ว การแก้/ลบจะสร้างยอดปรับปรุงเข้าวันนี้แทน */
  isClosed(coupleId: number, day: string) {
    return !!this.get('SELECT 1 FROM daily_summaries WHERE couple_id = ? AND date = ?', coupleId, day)
  }

  private adjustIfClosed(before: Expense, after: Expense | null, today: string, reason: string) {
    if (!this.isClosed(before.couple_id, before.day)) return
    const delta = (after ? effect(after.payer, after.shares) : 0) - (before.status === 'active' ? effect(before.payer, before.shares) : 0)
    if (delta !== 0) this.run('INSERT INTO adjustments (couple_id, day, delta_satang, expense_id, reason) VALUES (?, ?, ?, ?, ?)', before.couple_id, today, delta, before.id, reason)
  }

  updateExpense(id: number, p: ExpensePatch, memberId: number | null, today: string): Expense {
    return this.tx(() => {
      const before = this.expense(id)
      if (!before || before.status !== 'active') throw new Error('ไม่พบรายการ')
      const next = {
        merchant: p.merchant ?? before.merchant,
        amount_satang: p.amount ?? before.amount_satang,
        split_mode: p.mode ?? before.split_mode,
        ratio: p.ratio !== undefined ? p.ratio : before.ratio,
        paid_by: p.paidBy ?? before.paid_by,
        category: p.category !== undefined ? p.category : before.category,
      }
      this.run('UPDATE expenses SET merchant = ?, amount_satang = ?, split_mode = ?, ratio = ?, paid_by = ?, category = ? WHERE id = ?',
        next.merchant, next.amount_satang, next.split_mode, next.ratio, next.paid_by, next.category, id)
      this.writeShares({ ...before, ...next })
      const after = this.expense(id)!
      this.adjustIfClosed(before, after, today, 'แก้รายการของวันที่ปิดยอดแล้ว')
      this.audit(before.couple_id, 'expense', id, memberId, 'update', before, after)
      return after
    })
  }

  deleteExpense(id: number, memberId: number | null, today: string): Expense {
    return this.tx(() => {
      const before = this.expense(id)
      if (!before || before.status !== 'active') throw new Error('ไม่พบรายการ')
      this.run("UPDATE expenses SET status = 'deleted' WHERE id = ?", id)
      this.adjustIfClosed(before, null, today, 'ลบรายการของวันที่ปิดยอดแล้ว')
      const after = this.expense(id)!
      this.audit(before.couple_id, 'expense', id, memberId, 'delete', before, after)
      return after
    })
  }

  adjustmentsSum(coupleId: number, day: string) {
    return this.get<{ s: number }>('SELECT COALESCE(SUM(delta_satang), 0) AS s FROM adjustments WHERE couple_id = ? AND day = ?', coupleId, day)!.s
  }

  // ---------- slips ----------
  createSlip(s: Partial<Slip> & { couple_id: number; member_id: number }): Slip {
    const cols = Object.keys(s)
    const id = this.run(`INSERT INTO slips (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, ...(Object.values(s) as SQLInputValue[]))
    return this.slip(id)!
  }
  slip(id: number) {
    return this.get<Slip>('SELECT * FROM slips WHERE id = ?', id)
  }
  slipByTransRef(ref: string) {
    return this.get<Slip>('SELECT * FROM slips WHERE qr_trans_ref = ?', ref)
  }
  updateSlip(id: number, p: Partial<Slip>) {
    const cols = Object.keys(p)
    if (cols.length) this.run(`UPDATE slips SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...(Object.values(p) as SQLInputValue[]), id)
    return this.slip(id)!
  }
  awaitingSlip(coupleId: number, memberId: number) {
    return this.get<Slip>("SELECT * FROM slips WHERE couple_id = ? AND member_id = ? AND status = 'await_amount' ORDER BY id DESC LIMIT 1", coupleId, memberId)
  }
  /** จำนวนรูปที่ส่งให้ AI อ่านตั้งแต่ sinceIso (ใช้คุมงบรายวัน) */
  aiCountSince(coupleId: number, sinceIso: string) {
    return this.get<{ n: number }>('SELECT COUNT(*) AS n FROM slips WHERE couple_id = ? AND ai_json IS NOT NULL AND created_at >= ?', coupleId, sinceIso)!.n
  }
  slipImagesBefore(beforeIso: string) {
    return this.all<Slip>('SELECT * FROM slips WHERE image_path IS NOT NULL AND created_at < ?', beforeIso)
  }
  slipImages(coupleId: number) {
    return this.all<Slip>('SELECT * FROM slips WHERE couple_id = ? AND image_path IS NOT NULL', coupleId)
  }

  // ---------- settlements ----------
  createSettlement(s: { coupleId: number; from: number; to: number; amount: number; day: string; summaryId: number | null; slipId?: number | null; createdBy: number | null }) {
    const id = this.run('INSERT INTO settlements (couple_id, from_member, to_member, amount_satang, day, summary_id, slip_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      s.coupleId, s.from, s.to, s.amount, s.day, s.summaryId, s.slipId ?? null, s.createdBy)
    const row = this.get<Settlement>('SELECT * FROM settlements WHERE id = ?', id)!
    this.audit(s.coupleId, 'settlement', id, s.createdBy, 'create', null, row)
    return row
  }
  unmatchedSettlements(coupleId: number, day: string) {
    return this.all<Settlement>('SELECT * FROM settlements WHERE couple_id = ? AND day = ? AND summary_id IS NULL ORDER BY id', coupleId, day)
  }

  // ---------- daily_summaries ----------
  summary(coupleId: number, date: string) {
    return this.get<Summary>('SELECT * FROM daily_summaries WHERE couple_id = ? AND date = ?', coupleId, date)
  }
  summaryById(id: number) {
    return this.get<Summary>('SELECT * FROM daily_summaries WHERE id = ?', id)
  }
  latestSummary(coupleId: number, beforeDate = '9999-12-31') {
    return this.get<Summary>('SELECT * FROM daily_summaries WHERE couple_id = ? AND date < ? ORDER BY date DESC LIMIT 1', coupleId, beforeDate)
  }
  summariesBetween(coupleId: number, from: string, to: string) {
    return this.all<Summary>('SELECT * FROM daily_summaries WHERE couple_id = ? AND date BETWEEN ? AND ? ORDER BY date', coupleId, from, to)
  }
  /** INSERT แบบ idempotent: มีอยู่แล้วคืน null */
  createSummary(s: { coupleId: number; date: string; net: number; carriedIn: number; action: Summary['action']; qrToken?: string | null; createdAt?: string }): Summary | null {
    const r = this.db.prepare("INSERT OR IGNORE INTO daily_summaries (couple_id, date, net_satang, carried_in, action, qr_token, settled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%dT%H:%M:%SZ','now')))")
      .run(s.coupleId, s.date, s.net, s.carriedIn, s.action, s.qrToken ?? null, s.net === 0 ? 1 : 0, s.createdAt ?? null)
    return r.changes ? this.summaryById(Number(r.lastInsertRowid))! : null
  }
  updateSummary(id: number, p: Partial<Pick<Summary, 'sent_message_id' | 'settled' | 'paid_satang' | 'qr_token' | 'action'>>) {
    const cols = Object.keys(p)
    this.run(`UPDATE daily_summaries SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, ...(Object.values(p) as SQLInputValue[]), id)
    return this.summaryById(id)!
  }

  // ---------- ledger ----------
  /** ยอดคงค้างของสรุปหนึ่งวัน (บวก = B ค้าง A) */
  outstanding(s: Summary) {
    return s.net_satang - s.paid_satang
  }
  /** สถานะยอดของวันทางบัญชี `day` ณ ตอนนี้ */
  ledger(coupleId: number, day: string) {
    const prev = this.latestSummary(coupleId, day)
    const carriedIn = prev ? this.outstanding(prev) : 0
    const expenses = this.expensesByDay(coupleId, day)
    const ms = this.members(coupleId)
    const settlements = this.unmatchedSettlements(coupleId, day).map((s) => ({ from: ms.findIndex((m) => m.id === s.from_member) as Slot, amount: s.amount_satang }))
    const adjustments = this.adjustmentsSum(coupleId, day)
    return { day, carriedIn, adjustments, expenses, settlements, net: dailyNet({ expenses, settlements, carriedIn, adjustments }) }
  }

  // ---------- audit_log ----------
  audit(coupleId: number | null, entity: string, entityId: number | null, memberId: number | null, action: string, before: unknown, after: unknown) {
    this.run('INSERT INTO audit_log (couple_id, entity, entity_id, member_id, action, before_json, after_json) VALUES (?, ?, ?, ?, ?, ?, ?)',
      coupleId, entity, entityId, memberId, action, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after))
  }
  auditFor(entity: string, entityId: number) {
    return this.all<{ action: string; member_id: number | null; before_json: string | null; after_json: string | null }>('SELECT * FROM audit_log WHERE entity = ? AND entity_id = ? ORDER BY id', entity, entityId)
  }
}
