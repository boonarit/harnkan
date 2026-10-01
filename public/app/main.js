// @ts-check
// router + หน้าจอทั้งหมด (ES module ธรรมดา ไม่มี framework)
import { baht, chipToMode, chipTreatedBy, esc, modeLabel, modeToChip, monthGrid, netSentence, parseAmount, preview, shiftMonth, thaiDate, thaiMonth, WEEKDAYS } from './format.js'
import { SUMMARY_EVERY_MIN } from '#domain/time.js'

/** @typedef {import('./data/adapter.js').ApiAdapter | import('./data/adapter.js').LocalAdapter} Adapter */

/** @type {Adapter} */
let api
/** @type {any} */
let me = null
const $app = () => /** @type {HTMLElement} */ (document.getElementById('app'))

function showError(msg) {
  const el = document.createElement('p')
  el.className = 'error'
  el.setAttribute('role', 'alert')
  el.dataset.error = '1'
  el.textContent = msg
  $app().prepend(el)
}

function toast(msg) {
  const t = document.createElement('div')
  t.className = 'toast'
  t.setAttribute('role', 'status')
  t.textContent = msg
  document.body.append(t)
  setTimeout(() => t.remove(), 2200)
}

const payerSlot = (id) => /** @type {0 | 1} */ (me.members.findIndex((m) => m.id === id))
const name = (id) => esc(me.members.find((m) => m.id === id)?.display_name ?? '?')

function expenseRow(e) {
  const eff = e.effect === 0 ? 'ไม่นับ' : `${e.effect > 0 ? name(me.members[1].id) : name(me.members[0].id)} ค้าง ${baht(Math.abs(e.effect))}`
  return `<li><a class="row" href="#/e/${e.id}">
    <span class="dot bg${e.payer}" aria-hidden="true"></span>
    <span class="main"><span class="title">${esc(e.merchant)}</span><span class="meta">${name(e.paid_by)}จ่าย · ${esc(modeLabel(e, me.members))} · ${eff}</span></span>
    <span class="amt">${baht(e.amount)}</span></a></li>`
}

/** การโอน (เคลียร์ยอด / ปิดยอดเป็น 0) + ปุ่มลบ */
function settlementRow(s) {
  const tag = s.kind === 'manual_close' ? 'ปิดยอดเป็น 0' : 'เคลียร์ยอด'
  return `<li><div class="row">
    <span class="dot bg${payerSlot(s.from)}" aria-hidden="true"></span>
    <span class="main"><span class="title">${name(s.from)} โอนให้ ${name(s.to)}</span><span class="meta">${tag}</span></span>
    <span class="amt">${baht(s.amount)}</span>
    <button type="button" class="danger small" data-del-settlement="${s.id}" aria-label="ลบ ${tag} ${baht(s.amount)}">ลบ</button></div></li>`
}

/** กดลบการโอน (ถามยืนยัน) · ใช้ทั้งหน้าวันนี้และประวัติ */
function onSettlementDelete(root, after) {
  root.addEventListener('click', async (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest('[data-del-settlement]')
    if (!b) return
    if (!confirm('ลบการโอนนี้? ยอดจะกลับไปเท่าก่อนบันทึก')) return
    try {
      await api.deleteSettlement(Number(/** @type {HTMLElement} */ (b).dataset.delSettlement))
      toast('ลบแล้ว')
      await after()
    } catch (e) {
      showError(/** @type {Error} */ (e).message)
    }
  })
}

// ---------- หน้า: วันนี้ ----------
async function viewToday() {
  const t = await api.today()
  const p = t.pending
  $app().innerHTML = `
    <section class="hero" aria-label="ยอดตอนนี้">
      <div class="label">ยอดตอนนี้ · ${thaiDate(t.day)}</div>
      <div class="big" data-testid="net">${baht(Math.abs(t.net))}</div>
      <div class="who">${esc(netSentence(t.net, me.members))}</div>
      ${t.carried_in ? `<div class="sub">รวมยอดยกมา ${baht(t.carried_in)}</div>` : ''}
      ${p && p.summary_date ? `<div class="sub">ค้างจากสรุป ${thaiDate(p.summary_date)} ${baht(p.amount)}</div>` : ''}
    </section>
    <h2>รายการวันนี้ (${t.expenses.length})</h2>
    ${t.expenses.length ? `<ul class="list">${t.expenses.map(expenseRow).join('')}</ul>` : '<p class="muted">ยังไม่มีรายการ พิมพ์ในกลุ่ม LINE เช่น "กาแฟ 90" หรือกดเพิ่มด้านล่าง</p>'}
    ${t.settlements?.length ? `<h2>การโอนวันนี้</h2><ul class="list" data-testid="settlements">${t.settlements.map(settlementRow).join('')}</ul>` : ''}
    ${t.ignored_slips?.length ? `<h2>สลิปที่ไม่นับ</h2><ul class="list" data-testid="ignored">${t.ignored_slips.map((s) => `<li><div class="row">
      <span class="main"><span class="title">${esc(s.label)}</span><span class="meta">${name(s.member_id)}ส่ง · ไม่นับเข้ายอด</span></span>
      <span class="amt">${baht(s.amount)}</span><button type="button" class="secondary small" data-count="${s.id}">นับ</button></div></li>`).join('')}</ul>` : ''}
    <a class="btn fab" href="#/add">＋ เพิ่มรายการ</a>`
  onSettlementDelete($app(), route) // route() สร้าง #app ใหม่ กัน listener ซ้อน
  $app().querySelector('[data-testid=ignored]')?.addEventListener('click', async (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest('[data-count]')
    if (!b) return
    try {
      await api.countSlip(Number(/** @type {HTMLElement} */ (b).dataset.count))
      toast('นับเป็นค่าใช้จ่ายแล้ว')
      await route()
    } catch (e) {
      showError(/** @type {Error} */ (e).message)
    }
  })
}

// ---------- ฟอร์มรายการ (เพิ่ม/แก้ไข) ----------
function expenseForm({ title, amount = 0, merchant = '', paidBy, mode, treatedBy = null, net, editing = null }) {
  let digits = amount ? (amount / 100).toFixed(2).replace(/\.00$/, '') : ''
  let payer = payerSlot(paidBy)
  let chip = modeToChip(mode, payer, treatedBy == null ? -1 : payerSlot(treatedBy))
  const [m0, m1] = me.members
  $app().innerHTML = `
    <h1>${title}</h1>
    <div class="amount-display" data-testid="amount" aria-live="polite"></div>
    <div class="numpad" role="group" aria-label="แป้นตัวเลข">
      ${['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => `<button type="button" data-key="${k}" aria-label="${k === '⌫' ? 'ลบ' : k}">${k}</button>`).join('')}
    </div>
    <label for="merchant">ชื่อรายการ</label>
    <input id="merchant" maxlength="60" placeholder="เช่น กาแฟ" value="${esc(merchant)}">
    <label>ใครจ่าย</label>
    <div class="chips" role="group" aria-label="ใครจ่าย">
      <button type="button" class="chip p0" data-payer="0">${esc(m0.display_name)}</button>
      <button type="button" class="chip p1" data-payer="1">${esc(m1.display_name)}</button>
    </div>
    <label>หารยังไง</label>
    <div class="chips" role="group" aria-label="โหมดหาร">
      <button type="button" class="chip" data-chip="half">หารครึ่ง</button>
      <button type="button" class="chip p0" data-chip="0">ของ${esc(m0.display_name)}</button>
      <button type="button" class="chip p1" data-chip="1">ของ${esc(m1.display_name)}</button>
      <button type="button" class="chip p0" data-chip="t0">${esc(m0.display_name)}เลี้ยง</button>
      <button type="button" class="chip p1" data-chip="t1">${esc(m1.display_name)}เลี้ยง</button>
    </div>
    <div class="preview" data-testid="preview" aria-live="polite"></div>
    <div class="actions">
      ${editing ? '<button type="button" class="danger" data-act="delete">ลบรายการ</button>' : ''}
      <button type="button" data-act="save">บันทึก</button>
    </div>`
  const q = (s) => /** @type {HTMLElement} */ ($app().querySelector(s))
  const satang = () => parseAmount(digits || '0') ?? 0
  const render = () => {
    q('[data-testid=amount]').textContent = baht(satang())
    $app().querySelectorAll('[data-payer]').forEach((b) => b.setAttribute('aria-pressed', String(Number(/** @type {HTMLElement} */ (b).dataset.payer) === payer)))
    $app().querySelectorAll('[data-chip]').forEach((b) => b.setAttribute('aria-pressed', String(/** @type {HTMLElement} */ (b).dataset.chip === chip)))
    const md = chip === 'ratio' ? 'ratio' : chipToMode(/** @type {any} */ (chip), payer)
    const base = net - (editing ? editing.effect : 0)
    const pv = preview({ amount: satang(), payer, mode: md, ratio: editing?.ratio ?? 50, net: base, seq: editing?.id ?? 0 })
    const effText = pv.effect === 0 ? 'ไม่นับเข้ายอด' : `${esc(me.members[pv.effect > 0 ? 1 : 0].display_name)} ค้าง ${esc(me.members[pv.effect > 0 ? 0 : 1].display_name)} ${baht(Math.abs(pv.effect))}`
    q('[data-testid=preview]').innerHTML = `ผลต่อยอด: <b>${effText}</b><br>ยอดหลังบันทึก: ${esc(netSentence(pv.net, me.members))} ${pv.net ? baht(Math.abs(pv.net)) : ''}`
    const save = /** @type {HTMLButtonElement} */ (q('[data-act=save]'))
    save.disabled = satang() <= 0
  }
  $app().addEventListener('click', async (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest('button')
    if (!b) return
    if (b.dataset.key) {
      const k = b.dataset.key
      if (k === '⌫') digits = digits.slice(0, -1)
      else if (k === '.' ? !digits.includes('.') : !/\.\d\d$/.test(digits) && digits.replace('.', '').length < 9) digits = digits === '0' && k !== '.' ? k : digits + k
    } else if (b.dataset.payer) {
      // chip "ของเอ" / "เอเลี้ยง" ยังเป็นของเอ แม้เปลี่ยนคนจ่าย
      payer = /** @type {0 | 1} */ (Number(b.dataset.payer))
    } else if (b.dataset.chip) chip = /** @type {any} */ (b.dataset.chip)
    else if (b.dataset.act === 'save') {
      const body = { amount: satang(), merchant: /** @type {HTMLInputElement} */ (q('#merchant')).value.trim() || 'ไม่ระบุ', paid_by: me.members[payer].id, split_mode: chip === 'ratio' ? 'ratio' : chipToMode(/** @type {any} */ (chip), payer), treated_by: chipTreatedBy(chip, me.members) }
      b.setAttribute('disabled', '')
      try {
        if (editing) await api.updateExpense(editing.id, body)
        else await api.addExpense(body)
        toast('บันทึกแล้ว')
        location.hash = '#/'
      } catch (e) {
        showError(/** @type {Error} */ (e).message)
        b.removeAttribute('disabled')
      }
      return
    } else if (b.dataset.act === 'delete' && editing) {
      if (!confirm(`ลบ "${editing.merchant}" ?`)) return
      try {
        await api.deleteExpense(editing.id)
        toast('ลบแล้ว')
        location.hash = '#/'
      } catch (e) {
        showError(/** @type {Error} */ (e).message)
      }
      return
    }
    render()
  })
  render()
}

async function viewAdd() {
  const t = await api.today()
  expenseForm({ title: 'เพิ่มรายการ', paidBy: me.me, mode: me.settings.default_split, net: t.net })
}

async function viewDetail(id) {
  const [{ expense: e, audit }, t] = await Promise.all([api.expense(id), api.today()])
  if (e.status !== 'active') {
    $app().innerHTML = `<h1>${esc(e.merchant)}</h1><p class="muted">รายการนี้ถูกลบแล้ว</p>`
    return
  }
  // แก้รายการวันเก่า: ผลต่างเข้ายอดวันนี้ (ยอดปรับปรุง) จึงพรีวิวจากยอดวันนี้เสมอ
  expenseForm({ title: 'รายละเอียด / แก้ไข', amount: e.amount, merchant: e.merchant, paidBy: e.paid_by, mode: e.split_mode, treatedBy: e.treated_by, net: t.net, editing: e })
  const info = document.createElement('p')
  info.className = 'muted'
  info.textContent = `วันที่ ${thaiDate(e.day)} · ที่มา: ${{ text: 'พิมพ์ในแชท', slip: 'สลิป', manual: 'เพิ่มในแอป' }[e.source] ?? e.source} · แก้ไข ${audit.filter((a) => a.action === 'update').length} ครั้ง`
  $app().append(info)
  if (e.slip_id) {
    const url = await api.slipImage(e.slip_id)
    if (url) {
      const img = document.createElement('img')
      img.className = 'slip-img'
      img.alt = 'รูปสลิป'
      img.src = url
      $app().append(img)
    }
  }
}

// ---------- หน้า: เคลียร์ยอด ----------
async function viewSettle() {
  const t = await api.today()
  const p = t.pending
  if (!p) {
    $app().innerHTML = '<h1>เคลียร์ยอด</h1><section class="hero"><div class="big">🎉</div><div class="who">ไม่มีใครติดใคร</div></section>'
    return
  }
  const qr = await api.settleQr()
  const pp = p.promptpay_id ?? ''
  $app().innerHTML = `
    <h1>เคลียร์ยอด</h1>
    <section class="hero">
      <div class="label">${p.summary_date ? `ยอดสรุป ${thaiDate(p.summary_date)}` : 'ยอดตอนนี้'}</div>
      <div class="big" data-testid="settle-amount">${baht(p.amount)}</div>
      <div class="who">${name(p.from)} โอนให้ ${name(p.to)}</div>
    </section>
    ${qr ? `<img class="qr" src="${qr}" alt="QR พร้อมเพย์ ${baht(p.amount)}">` : p.bank_account ? `<div class="account" data-testid="account">โอนเข้า ${esc(p.bank_name ?? 'บัญชี')}<br><b>${esc(p.bank_account)}</b></div>` : `<div class="qr-placeholder">${pp ? 'QR แสดงเมื่อต่อ server จริง' : `${name(p.to)} ยังไม่ได้ตั้งเบอร์พร้อมเพย์หรือเลขบัญชี<br><a href="#/settings">ไปตั้งค่า</a>`}</div>`}
    <div class="actions">
      ${qr ? `<a class="btn secondary" href="${qr}" download="harnkan-qr.png">บันทึกรูป QR</a>` : ''}
      ${pp ? `<button type="button" class="secondary" data-copy="${esc(pp)}">คัดลอกเบอร์ ${esc(pp)}</button>` : ''}
      ${!qr && !pp && p.bank_account ? `<button type="button" class="secondary" data-copy="${esc(p.bank_account)}">คัดลอกเลขบัญชี</button>` : ''}
    </div>
    ${qr ? `<h2>วิธีสแกน</h2>
    <ol class="steps">
      <li><b>มือถือเครื่องเดียว:</b> กด "บันทึกรูป QR" → เปิดแอปธนาคาร → สแกน → เลือกรูปจากคลังภาพ</li>
      <li><b>สองเครื่อง:</b> เปิดหน้านี้ค้างไว้ แล้วใช้แอปธนาคารอีกเครื่องสแกนจากจอ</li>
    </ol>` : ''}
    <p class="muted">โอนแล้วส่งสลิปในกลุ่ม LINE บอทจะปิดยอดให้</p>
    <h2>เคลียร์กันนอกแอปแล้ว?</h2>
    <p class="muted">ปิดยอดให้เป็น 0 โดยไม่ต้องส่งสลิป · ประวัติยังอยู่ครบ ลบทีหลังได้ (ยอดจะกลับมา)</p>
    <button type="button" class="secondary" data-act="close">ปิดยอดเป็น 0</button>`
  $app().querySelector('[data-act=close]')?.addEventListener('click', async () => {
    const now = (await api.today()).net
    if (!now) return toast('ยอดเป็น 0 อยู่แล้ว')
    const who = netSentence(now, me.members)
    if (!confirm(`ปิดยอด ${who} ${baht(Math.abs(now))} ให้เป็น 0 ใช่ไหม? ประวัติยังอยู่ครบ`)) return
    try {
      await api.closeBalance()
      toast('ปิดยอดแล้ว')
      await route()
    } catch (e) {
      showError(/** @type {Error} */ (e).message)
    }
  })
  $app().querySelector('[data-copy]')?.addEventListener('click', async (ev) => {
    const v = /** @type {HTMLElement} */ (ev.currentTarget).dataset.copy ?? ''
    try {
      await navigator.clipboard.writeText(v)
      toast('คัดลอกแล้ว')
    } catch {
      prompt('คัดลอกเบอร์', v)
    }
  })
}

// ---------- หน้า: ประวัติ ----------
async function viewHistory(month, selected) {
  const m = month ?? me.today.slice(0, 7)
  const { days } = await api.days(m)
  const byDate = new Map(days.map((d) => [d.date, d]))
  const cell = (d) => {
    if (!d) return '<td></td>'
    const x = byDate.get(d)
    const cls = [x ? 'has' : '', d === me.today ? 'today' : '', x?.settled ? 'settled' : ''].join(' ')
    return `<td><button type="button" class="${cls}" data-date="${d}" aria-label="${thaiDate(d)}${x ? ` ${x.bills} รายการ` : ''}">
      ${Number(d.slice(8))}${x ? `<span class="n">${x.net === null ? '' : baht(Math.abs(x.net)).replace('฿', '')}</span>` : ''}</button></td>`
  }
  $app().innerHTML = `
    <h1>ประวัติ</h1>
    <div class="actions">
      <a class="btn secondary" href="#/history/${shiftMonth(m, -1)}" aria-label="เดือนก่อน">‹</a>
      <h2 style="text-align:center;flex:3" data-testid="month">${thaiMonth(m)}</h2>
      <a class="btn secondary" href="#/history/${shiftMonth(m, 1)}" aria-label="เดือนถัดไป">›</a>
    </div>
    <table class="cal"><thead><tr>${WEEKDAYS.map((w) => `<th scope="col">${w}</th>`).join('')}</tr></thead>
      <tbody>${monthGrid(m).map((w) => `<tr>${w.map(cell).join('')}</tr>`).join('')}</tbody></table>
    <div id="day-detail"></div>`
  const showDay = async (date) => {
    const d = await api.day(date)
    const x = byDate.get(date)
    const el = /** @type {HTMLElement} */ ($app().querySelector('#day-detail'))
    el.innerHTML = `<h2>${thaiDate(date)}</h2>
      ${x && x.net !== null ? `<p>${esc(netSentence(x.net, me.members))} ${x.net ? baht(Math.abs(x.net)) : ''} ${x.settled ? '· เคลียร์แล้ว ✅' : ''}</p>` : ''}
      ${d.expenses.length ? `<ul class="list">${d.expenses.map(expenseRow).join('')}</ul>` : '<p class="muted">ไม่มีรายการ</p>'}
      ${d.settlements?.length ? `<h2>การโอน</h2><ul class="list">${d.settlements.map(settlementRow).join('')}</ul>` : ''}`
  }
  let selectedDate = selected
  onSettlementDelete($app(), async () => {
    const target = `#/history/${m}/${selectedDate}`
    if (location.hash === target) await route()
    else location.hash = target
  })
  $app().querySelector('.cal')?.addEventListener('click', (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest('button')
    if (b?.dataset.date) showDay((selectedDate = b.dataset.date))
  })
  if (selected) await showDay(selected)
}

// ---------- หน้า: ตั้งค่า ----------
async function viewSettings() {
  me = await api.me()
  const s = me.settings
  const mine = me.members.find((m) => m.id === me.me)
  $app().innerHTML = `
    <h1>ตั้งค่า</h1>
    <form id="settings">
      <h2>ของฉัน</h2>
      <label for="display_name">ชื่อที่แสดง</label><input id="display_name" maxlength="40" aria-describedby="display_name-error" value="${esc(mine.display_name)}">
      <p class="field-error" id="display_name-error" role="alert" hidden></p>
      <label for="promptpay_id">เบอร์พร้อมเพย์ (รับเงิน)</label><input id="promptpay_id" inputmode="numeric" placeholder="เบอร์มือถือ 10 หลัก" aria-describedby="promptpay_id-help" value="${esc(mine.promptpay_id ?? '')}">
      <p class="help" id="promptpay_id-help">ใช้สร้าง QR ตอนสรุป ถ้าบัญชีไม่ผูกพร้อมเพย์ให้เว้นว่าง</p>
      <label for="bank_name">ธนาคาร (ถ้าไม่มีพร้อมเพย์)</label><input id="bank_name" maxlength="30" placeholder="เช่น กสิกร" value="${esc(mine.bank_name ?? '')}">
      <label for="bank_account">เลขบัญชีรับเงิน (ถ้าไม่มีพร้อมเพย์)</label><input id="bank_account" inputmode="numeric" aria-describedby="bank_account-help" value="${esc(mine.bank_account ?? '')}">
      <p class="help" id="bank_account-help">การ์ดสรุปจะแสดงเลขนี้ + ปุ่มคัดลอกแทน QR · เก็บในฐานข้อมูลของคู่เท่านั้น</p>
      <label for="bank_names">ชื่อบัญชีตามสลิป</label><input id="bank_names" placeholder="เช่น สมชาย" aria-describedby="bank_names-help" value="${esc((mine.bank_names ?? []).join(', '))}">
      <p class="help" id="bank_names-help">ชื่อต้นตามที่ขึ้นบนสลิป ไม่ต้องมีนาย/นามสกุล คั่นหลายชื่อด้วย ,</p>
      <label for="account_suffixes">เลขท้ายบัญชี 4 ตัว</label><input id="account_suffixes" inputmode="numeric" placeholder="เช่น 1234" aria-describedby="account_suffixes-help" value="${esc((mine.account_suffixes ?? []).join(', '))}">
      <p class="help" id="account_suffixes-help">ดูจากสลิปที่เคยโอน ช่องที่เป็น xxx-xxx-1234 · ไม่บังคับ แต่ทำให้แม่นขึ้น · หลายบัญชีคั่นด้วย ,</p>
      <h2>ของคู่เรา</h2>
      <label for="settle_time">เวลาสรุปยอด</label><input id="settle_time" type="time" aria-describedby="settle_time-help" value="${esc(s.settle_time)}">
      <p class="help" id="settle_time-help">การ์ดสรุปจะมาภายใน ${SUMMARY_EVERY_MIN} นาทีหลังเวลานี้ · เปลี่ยนแล้วมีผลตั้งแต่รอบถัดไป</p>
      <label for="min_transfer">ยอดขั้นต่ำที่จะเรียกเก็บ (บาท)</label><input id="min_transfer" inputmode="decimal" value="${s.min_transfer / 100}">
      <label for="default_split">หารแบบไหนเป็นค่าเริ่ม</label>
      <select id="default_split">${['half', 'mine', 'theirs', 'treat'].map((m) => `<option value="${m}" ${m === s.default_split ? 'selected' : ''}>${{ half: 'หารครึ่ง', mine: 'ของคนจ่าย', theirs: 'ของอีกคน', treat: 'คนจ่ายเลี้ยง' }[m]}</option>`).join('')}</select>
      <label for="ai_daily_cap">อ่านสลิปด้วย AI สูงสุดต่อวัน (รูป)</label><input id="ai_daily_cap" inputmode="numeric" value="${s.ai_daily_cap}">
      <label for="slip_retention_days">เก็บรูปสลิปกี่วัน</label><input id="slip_retention_days" inputmode="numeric" value="${s.slip_retention_days}">
      <label for="stale_slip_hours">สลิปเก่ากว่ากี่ชั่วโมงให้ถามก่อนนับ</label><input id="stale_slip_hours" inputmode="numeric" aria-describedby="stale_slip_hours-help" value="${s.stale_slip_hours ?? 24}">
      <p class="help" id="stale_slip_hours-help">0 = ไม่ถาม บันทึกทุกสลิปทันที</p>
      <label for="pending_answer_hours">ถ้าไม่ตอบภายในกี่ชั่วโมง ถือว่าไม่นับ</label><input id="pending_answer_hours" inputmode="numeric" value="${s.pending_answer_hours ?? 24}">
      <label for="dup_window_minutes">เตือนรายการที่อาจซ้ำ ถ้ายอดเท่ากันภายในกี่นาที</label><input id="dup_window_minutes" inputmode="numeric" aria-describedby="dup_window_minutes-help" value="${s.dup_window_minutes ?? 10}">
      <p class="help" id="dup_window_minutes-help">0 = ไม่เตือน · บันทึกตามปกติ แค่ต่อท้ายการ์ดให้รู้</p>
      <div class="actions"><button type="submit">บันทึกการตั้งค่า</button></div>
    </form>
    <section class="danger-zone" aria-labelledby="danger-h">
      <h2 id="danger-h">โซนอันตราย</h2>
      <p>ลบข้อมูลทั้งหมดของกลุ่มนี้: รายการ การโอน สลิป รูป และประวัติ · ระบบสำรอง DB ก่อนลบ แต่ในแอป<b>ย้อนกลับไม่ได้</b></p>
      <button type="button" class="danger" data-act="wipe">ลบข้อมูลทั้งหมด</button>
    </section>`
  $app().querySelector('[data-act=wipe]')?.addEventListener('click', async () => {
    try {
      const n = await api.wipeInfo()
      if (!confirm(`จะลบ: รายการ ${n.expenses} · การโอน ${n.settlements} · สลิป ${n.slips} · สรุปรายวัน ${n.summaries}\nย้อนกลับไม่ได้ ต้องการลบต่อไหม?`)) return
      const typed = prompt('ยืนยันขั้นสุดท้าย: พิมพ์คำว่า "ลบ"')
      if (typed === null) return
      if (typed.trim() !== 'ลบ') return toast('ไม่ได้พิมพ์ "ลบ" — ยกเลิก ข้อมูลยังอยู่ครบ')
      await api.wipeAll(typed.trim())
      toast('ลบข้อมูลทั้งหมดแล้ว')
      $app().innerHTML = '<h1>ลบข้อมูลทั้งหมดแล้ว</h1><p class="muted">พิมพ์อะไรก็ได้ในกลุ่ม LINE เพื่อเริ่มใหม่</p>'
    } catch (e) {
      showError(/** @type {Error} */ (e).message)
    }
  })
  $app().querySelector('#settings')?.addEventListener('submit', async (ev) => {
    ev.preventDefault()
    const v = (id) => /** @type {HTMLInputElement} */ ($app().querySelector(`#${id}`)).value.trim()
    const list = (id) => (v(id) ? v(id).split(',').map((x) => x.trim()).filter(Boolean) : [])
    const patch = {
      // ส่งชื่อเฉพาะเมื่อเปลี่ยน — ชื่อจากโปรไฟล์ LINE เดิมอาจไม่ผ่านกฎใหม่ แต่ต้องยังบันทึกค่าอื่นได้
      ...(v('display_name') !== mine.display_name ? { display_name: v('display_name') } : {}), settle_time: v('settle_time'), default_split: v('default_split'),
      min_transfer: parseAmount(v('min_transfer') || '0') ?? -1, ai_daily_cap: Number(v('ai_daily_cap')), slip_retention_days: Number(v('slip_retention_days')),
      stale_slip_hours: Number(v('stale_slip_hours')), pending_answer_hours: Number(v('pending_answer_hours')), dup_window_minutes: Number(v('dup_window_minutes')),
      bank_name: v('bank_name') || null, bank_account: v('bank_account') || null,
      promptpay_id: v('promptpay_id') || null, bank_names: list('bank_names'), account_suffixes: list('account_suffixes'),
    }
    const nameInput = /** @type {HTMLInputElement} */ ($app().querySelector('#display_name'))
    const nameError = /** @type {HTMLElement} */ ($app().querySelector('#display_name-error'))
    nameError.hidden = true
    nameInput.removeAttribute('aria-invalid')
    try {
      await api.saveSettings(patch)
      me = await api.me()
      toast('บันทึกแล้ว')
    } catch (e) {
      const err = /** @type {any} */ (e)
      if (err.field === 'display_name') {
        nameError.textContent = err.message
        nameError.hidden = false
        nameInput.setAttribute('aria-invalid', 'true')
        nameInput.focus()
      } else showError(err.message)
    }
  })
}

// ---------- router ----------
async function route() {
  const h = location.hash.replace(/^#/, '') || '/'
  let m
  const tab = h.startsWith('/history') ? 'history' : h.startsWith('/settle') ? 'settle' : h.startsWith('/settings') ? 'settings' : 'today'
  document.querySelectorAll('.tabs a').forEach((a) => (/** @type {HTMLElement} */ (a).dataset.tab === tab ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')))
  const fresh = $app().cloneNode(false) // ล้าง event listener ของหน้าก่อน
  $app().replaceWith(fresh)
  try {
    if (h === '/') await viewToday()
    else if (h === '/add') await viewAdd()
    else if ((m = h.match(/^\/e\/(\d+)$/))) await viewDetail(Number(m[1]))
    else if (h === '/settle') await viewSettle()
    else if ((m = h.match(/^\/history(?:\/(\d{4}-\d{2}))?(?:\/(\d{4}-\d{2}-\d{2}))?$/))) await viewHistory(m[1], m[2])
    else if (h === '/settings') await viewSettings()
    else $app().innerHTML = '<h1>ไม่พบหน้านี้</h1><a href="#/">กลับหน้าแรก</a>'
    document.body.dataset.page = tab
  } catch (e) {
    showError(`โหลดไม่สำเร็จ: ${/** @type {Error} */ (e).message}`)
  }
}

/** @param {Adapter} adapter */
export async function start(adapter) {
  api = adapter
  window.addEventListener('error', (e) => showError(`เกิดข้อผิดพลาด: ${e.message}`))
  window.addEventListener('unhandledrejection', (e) => showError(`เกิดข้อผิดพลาด: ${e.reason?.message ?? e.reason}`))
  try {
    me = await api.me()
  } catch (e) {
    showError(/** @type {any} */ (e).status === 403 ? 'ยังไม่ได้อยู่ในกลุ่มหารกัน — พิมพ์อะไรก็ได้ในกลุ่ม LINE ก่อน' : `เข้าสู่ระบบไม่สำเร็จ: ${/** @type {Error} */ (e).message}`)
    return
  }
  window.addEventListener('hashchange', route)
  await route()
}

/** ให้เดโมเรียกโหลดหน้าใหม่หลังข้อมูลเปลี่ยน */
export async function refresh() {
  me = await api.me()
  await route()
}
