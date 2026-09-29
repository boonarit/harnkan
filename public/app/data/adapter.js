// @ts-check
// ชั้นข้อมูลของ mini app — interface เดียว สองตัวทำจริง:
//   ApiAdapter   คุยกับ server (/api/*) ด้วย LIFF ID token
//   LocalAdapter เก็บทุกอย่างใน storage ของเบราว์เซอร์ (โหมดเดโม ไม่มี server)
//
// เมธอด: me() · today() · days(month) · day(date) · expense(id) · addExpense(body) · updateExpense(id, patch)
//        deleteExpense(id) · saveSettings(patch) · settleQr() · slipImage(id)
//        deleteSettlement(id) · closeBalance() · countSlip(id) · wipeInfo() · wipeAll(confirm)
import { dailyNet } from '#domain/balance.js'
import { effect, splitShares } from '#domain/split.js'
import { businessDay } from '#domain/time.js'
import { validateName } from '#domain/name.js'

export class ApiError extends Error {
  /** @param {number} status @param {string} message @param {string} [field] ช่องที่ผิด */
  constructor(status, message, field) {
    super(message)
    this.status = status
    this.field = field
  }
}

export class ApiAdapter {
  /**
   * @param {{ getToken: () => Promise<string>, fetch?: typeof fetch, base?: string, couple?: number | null,
   *   onUnauthorized?: () => Promise<unknown>, onOk?: () => void }} opts
   *   onUnauthorized: 401 → เข้าสู่ระบบใหม่ (ไม่ resolve = กำลัง redirect · throw = ยอมแพ้พร้อมข้อความ)
   */
  constructor(opts) {
    this.getToken = opts.getToken
    this.onUnauthorized = opts.onUnauthorized
    this.onOk = opts.onOk
    this.fetch = opts.fetch ?? globalThis.fetch.bind(globalThis)
    this.base = opts.base ?? ''
    this.couple = opts.couple ?? null
  }
  /** @param {string} method @param {string} path @param {unknown} [body] @param {boolean} [raw] */
  async call(method, path, body, raw = false) {
    const q = this.couple ? `${path.includes('?') ? '&' : '?'}couple=${this.couple}` : ''
    const res = await this.fetch(`${this.base}/api${path}${q}`, {
      method,
      headers: { authorization: `Bearer ${await this.getToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (res.status === 401 && this.onUnauthorized) await this.onUnauthorized()
    if (res.ok) this.onOk?.()
    if (!res.ok) {
      let msg = `HTTP ${res.status}`
      /** @type {string | undefined} */
      let field
      try {
        const j = await res.json()
        msg = j.error ?? msg
        field = j.field
      } catch { /* ไม่ใช่ JSON */ }
      throw new ApiError(res.status, msg, field)
    }
    return raw ? res.blob() : res.json()
  }
  me() { return this.call('GET', '/me') }
  today() { return this.call('GET', '/today') }
  /** @param {string} month */
  days(month) { return this.call('GET', `/days?month=${encodeURIComponent(month)}`) }
  /** @param {string} date */
  day(date) { return this.call('GET', `/days/${encodeURIComponent(date)}`) }
  /** @param {number} id */
  expense(id) { return this.call('GET', `/expenses/${id}`) }
  /** @param {object} body */
  addExpense(body) { return this.call('POST', '/expenses', body) }
  /** @param {number} id @param {object} patch */
  updateExpense(id, patch) { return this.call('PATCH', `/expenses/${id}`, patch) }
  /** @param {number} id */
  deleteExpense(id) { return this.call('DELETE', `/expenses/${id}`) }
  /** @param {object} patch */
  saveSettings(patch) { return this.call('PATCH', '/settings', patch) }
  /** @param {number} id */
  deleteSettlement(id) { return this.call('DELETE', `/settlements/${id}`) }
  closeBalance() { return this.call('POST', '/settle/close') }
  /** @param {number} id สลิปที่ไม่นับ → นับเป็นค่าใช้จ่าย */
  countSlip(id) { return this.call('POST', `/slips/${id}/count`) }
  wipeInfo() { return this.call('GET', '/wipe') }
  /** @param {string} confirm ต้องเป็น "ลบ" */
  wipeAll(confirm) { return this.call('POST', '/wipe', { confirm }) }
  /** @returns {Promise<string | null>} object URL ของรูป QR */
  async settleQr() {
    try { return URL.createObjectURL(await this.call('GET', '/settle/qr.png', undefined, true)) } catch { return null }
  }
  /** @param {number} slipId */
  async slipImage(slipId) {
    try { return URL.createObjectURL(await this.call('GET', `/slips/${slipId}/image`, undefined, true)) } catch { return null }
  }
}

/**
 * @typedef {{ id: number, merchant: string, amount: number, paid_by: number, split_mode: string, ratio: number | null,
 *   day: string, occurred_at: string, source: string, slip_id: number | null, category: string | null, status: string, created_by: number }} LocalExpense
 * @typedef {{ members: { id: number, display_name: string, promptpay_id: string | null, bank_names: string[] }[],
 *   settings: { settle_time: string, min_transfer: number, default_split: string, ai_daily_cap: number, slip_retention_days: number },
 *   expenses: LocalExpense[], settlements: { id: number, from: number, to: number, amount: number, day: string, kind?: string }[],
 *   settled_days: string[], audit: { entity_id: number, action: string, member_id: number }[], seq: number, me: number }} LocalState
 */

/** โหมดเดโม: state ทั้งหมดอยู่ใน storage (localStorage หรือ Map ในเทสต์) */
export class LocalAdapter {
  /**
   * @param {{ storage: { getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void },
   *   seed: () => LocalState, now?: () => number, key?: string }} opts
   */
  constructor(opts) {
    this.storage = opts.storage
    this.seed = opts.seed
    this.now = opts.now ?? Date.now
    this.key = opts.key ?? 'harnkan-demo'
  }
  /** @returns {LocalState} */
  load() {
    try {
      const raw = this.storage.getItem(this.key)
      if (raw) return JSON.parse(raw)
    } catch { /* storage ใช้ไม่ได้ → เริ่มจาก seed */ }
    const s = this.seed()
    this.save(s)
    return s
  }
  /** @param {LocalState} s */
  save(s) {
    try { this.storage.setItem(this.key, JSON.stringify(s)) } catch { /* private mode: ข้อมูลหายเมื่อปิดหน้า */ }
  }
  reset() {
    try { this.storage.removeItem(this.key) } catch { /* ignore */ }
    return this.load()
  }
  get state() { return this.load() }
  get todayDay() { return businessDay(this.now(), this.state.settings.settle_time) }

  /** @param {LocalState} s @param {LocalExpense} e */
  toJson(s, e) {
    const payer = /** @type {0 | 1} */ (s.members.findIndex((m) => m.id === e.paid_by))
    const shares = splitShares(e.amount, /** @type {any} */ (e.split_mode), payer, e.id, e.ratio ?? 50)
    return { ...e, payer, shares, effect: effect(payer, shares) }
  }
  /** @param {LocalState} s @param {string} day */
  dayNet(s, day) {
    const expenses = s.expenses.filter((e) => e.status === 'active' && e.day === day).map((e) => this.toJson(s, e))
    const settlements = s.settlements.filter((x) => x.day === day).map((x) => ({ from: /** @type {0 | 1} */ (s.members.findIndex((m) => m.id === x.from)), amount: x.amount }))
    return { expenses, settlements, net: dailyNet({ expenses, settlements }) }
  }
  /** ยอดยกมา = ผลรวมของวันก่อนหน้าที่ยังไม่ปิด @param {LocalState} s @param {string} day */
  carried(s, day) {
    const days = new Set([...s.expenses.map((e) => e.day), ...s.settlements.map((x) => x.day)])
    let c = 0
    for (const d of days) if (d < day && !s.settled_days.includes(d)) c += this.dayNet(s, d).net
    return c
  }

  async me() {
    const s = this.state
    return { me: s.me, couple_id: 1, members: s.members, settings: s.settings, today: this.todayDay }
  }
  async today() {
    const s = this.state
    const day = this.todayDay
    const d = this.dayNet(s, day)
    const carried = this.carried(s, day)
    const net = d.net + carried
    const from = net > 0 ? 1 : 0
    const to = 1 - from
    return {
      day, net, carried_in: carried, adjustments: 0, expenses: d.expenses, settlements: s.settlements.filter((x) => x.day === day), ignored_slips: [],
      pending: net ? { amount: Math.abs(net), from: s.members[from].id, to: s.members[to].id, promptpay_id: s.members[to].promptpay_id, summary_date: null } : null,
    }
  }
  /** @param {string} month */
  async days(month) {
    const s = this.state
    /** @type {Map<string, any>} */
    const out = new Map()
    for (const e of s.expenses) {
      if (e.status !== 'active' || !e.day.startsWith(month)) continue
      const x = out.get(e.day) ?? { date: e.day, bills: 0, spent: 0, net: 0, action: null, settled: s.settled_days.includes(e.day) }
      x.bills++
      x.spent += e.amount
      out.set(e.day, x)
    }
    for (const x of out.values()) {
      x.net = this.dayNet(s, x.date).net
      x.action = x.date < this.todayDay ? (x.net ? 'request' : 'zero') : null
    }
    return { month, days: [...out.values()].sort((a, b) => a.date.localeCompare(b.date)) }
  }
  /** @param {string} date */
  async day(date) {
    const s = this.state
    return { date, expenses: this.dayNet(s, date).expenses, settlements: s.settlements.filter((x) => x.day === date), summary: null }
  }
  /** @param {number} id */
  async expense(id) {
    const s = this.state
    const e = s.expenses.find((x) => x.id === id)
    if (!e) throw new ApiError(404, 'ไม่พบรายการ')
    return { expense: this.toJson(s, e), audit: s.audit.filter((a) => a.entity_id === id) }
  }
  /** @param {any} b */
  async addExpense(b) {
    const s = this.state
    if (!Number.isInteger(b.amount) || b.amount <= 0) throw new ApiError(400, 'amount ต้องเป็นสตางค์')
    /** @type {LocalExpense} */
    const e = {
      id: ++s.seq, merchant: b.merchant || 'ไม่ระบุ', amount: b.amount, paid_by: b.paid_by ?? s.me, split_mode: b.split_mode ?? s.settings.default_split,
      ratio: b.ratio ?? null, day: this.todayDay, occurred_at: new Date(this.now()).toISOString(), source: b.source ?? 'manual',
      slip_id: null, category: b.category ?? null, status: 'active', created_by: b.created_by ?? s.me,
    }
    s.expenses.push(e)
    s.audit.push({ entity_id: e.id, action: 'create', member_id: e.created_by })
    this.save(s)
    return { expense: this.toJson(s, e) }
  }
  /** @param {number} id @param {any} p */
  async updateExpense(id, p) {
    const s = this.state
    const e = s.expenses.find((x) => x.id === id && x.status === 'active')
    if (!e) throw new ApiError(404, 'ไม่พบรายการ')
    if (p.merchant !== undefined) e.merchant = p.merchant
    if (p.amount !== undefined) e.amount = p.amount
    if (p.split_mode !== undefined) e.split_mode = p.split_mode
    if (p.ratio !== undefined) e.ratio = p.ratio
    if (p.paid_by !== undefined) e.paid_by = p.paid_by
    s.audit.push({ entity_id: id, action: 'update', member_id: s.me })
    this.save(s)
    return { expense: this.toJson(s, e) }
  }
  /** @param {number} id */
  async deleteExpense(id) {
    const s = this.state
    const e = s.expenses.find((x) => x.id === id && x.status === 'active')
    if (!e) throw new ApiError(404, 'ไม่พบรายการ')
    e.status = 'deleted'
    s.audit.push({ entity_id: id, action: 'delete', member_id: s.me })
    this.save(s)
    return { expense: this.toJson(s, e) }
  }
  /** บันทึกการโอน (เดโม: จากแชทจำลอง) @param {number} from @param {number} to @param {number} amount */
  async addSettlement(from, to, amount) {
    const s = this.state
    s.settlements.push({ id: ++s.seq, from, to, amount, day: this.todayDay })
    this.save(s)
    return this.today()
  }
  /** @param {any} p */
  async saveSettings(p) {
    const s = this.state
    if (p.display_name !== undefined) {
      const r = validateName(p.display_name, s.members.filter((m) => m.id !== s.me).map((m) => m.display_name))
      if (!r.ok) throw new ApiError(400, r.error, 'display_name')
      p = { ...p, display_name: r.name }
    }
    for (const k of ['settle_time', 'min_transfer', 'default_split', 'ai_daily_cap', 'slip_retention_days']) if (p[k] !== undefined) /** @type {any} */ (s.settings)[k] = p[k]
    const me = s.members.find((m) => m.id === s.me)
    if (me) for (const k of ['promptpay_id', 'bank_names', 'display_name']) if (p[k] !== undefined) /** @type {any} */ (me)[k] = p[k]
    this.save(s)
    return { settings: s.settings, members: s.members }
  }
  /** @param {number} id */
  async deleteSettlement(id) {
    const s = this.state
    const i = s.settlements.findIndex((x) => x.id === id)
    if (i < 0) throw new ApiError(404, 'ไม่พบรายการ')
    s.settlements.splice(i, 1)
    this.save(s)
    return { net: (await this.today()).net }
  }
  /** ปิดยอดเป็น 0 = บันทึกการโอนเท่ายอดตอนนี้ (ลบทีหลังได้) */
  async closeBalance() {
    const t = await this.today()
    if (!t.net) throw new ApiError(400, 'ยอดเป็น 0 อยู่แล้ว')
    const s = this.state
    const [from, to] = t.net > 0 ? [s.members[1], s.members[0]] : [s.members[0], s.members[1]]
    s.settlements.push({ id: ++s.seq, from: from.id, to: to.id, amount: Math.abs(t.net), day: this.todayDay, kind: 'manual_close' })
    this.save(s)
    return { amount: Math.abs(t.net), net_after: 0 }
  }
  /** @param {number} _id */
  async countSlip(_id) { throw new ApiError(404, 'เดโมไม่มีสลิป') }
  async wipeInfo() {
    const s = this.state
    return { expenses: s.expenses.length, settlements: s.settlements.length, slips: 0, summaries: s.settled_days.length }
  }
  /** เดโม: กลับไปข้อมูลตัวอย่าง @param {string} confirm */
  async wipeAll(confirm) {
    if (confirm !== 'ลบ') throw new ApiError(400, 'ต้องพิมพ์คำว่า "ลบ" เพื่อยืนยัน')
    this.reset()
    return { ok: true }
  }
  async settleQr() { return null }
  /** @param {number} _id */
  async slipImage(_id) { return null }
}

