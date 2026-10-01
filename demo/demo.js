// @ts-check
// เดโม: แอปชุดเดียวกับของจริง + LocalAdapter + แชท LINE จำลอง (ไม่มี server ไม่มี request ออกนอกนอกจากฟอนต์)
import { LocalAdapter } from '../public/app/data/adapter.js'
import { baht, esc, modeLabel, netSentence } from '../public/app/format.js'
import { refresh, start } from '../public/app/main.js'
import { parseMessage } from '#domain/parse.js'
import { treatSplit } from '#domain/split.js'
import { demoSeed } from './seed.js'

/** localStorage ใช้ไม่ได้ (private mode) → เก็บในหน่วยความจำแทน */
function safeStorage() {
  try {
    localStorage.setItem('__t', '1')
    localStorage.removeItem('__t')
    return localStorage
  } catch {
    const m = new Map()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
  }
}

const api = new LocalAdapter({ storage: safeStorage(), seed: () => demoSeed(Date.now()) })
const $ = (s) => /** @type {HTMLElement} */ (document.querySelector(s))
let speaker = 1
const HELP = 'วิธีใช้หารกัน 🧾\n• "กาแฟ 90" → หารครึ่ง\n• "ข้าวเย็น 420 เลี้ยง" → เลี้ยง\n• "ครีมกันแดดของบี 359" → ของอีกคน\n• "สรุป" ดูยอด · "ยกเลิก" ลบรายการล่าสุด'

const members = () => api.state.members
const nameOf = (id) => members().find((m) => m.id === id)?.display_name ?? '?'

async function updateHead() {
  const t = await api.today()
  $('[data-testid=chat-net]').textContent = `ยอดตอนนี้: ${netSentence(t.net, members())} ${t.net ? baht(Math.abs(t.net)) : ''}`
  await refresh()
}

/** @param {string} html @param {'me' | 'bot' | 'card'} who */
function push(html, who) {
  const li = document.createElement('li')
  li.className = `msg ${who}`
  li.innerHTML = html
  $('#log').append(li)
  li.scrollIntoView({ block: 'end' })
  return li
}

const botText = (text) => push(`<span class="from">หารกัน</span>${esc(text)}`, 'bot')

async function card(e, title = '✓ บันทึกแล้ว') {
  const t = await api.today()
  const ms = members()
  const eff = e.effect === 0 ? 'ไม่นับเข้ายอด' : `${ms[e.effect > 0 ? 1 : 0].display_name} ค้าง ${ms[e.effect > 0 ? 0 : 1].display_name} ${baht(Math.abs(e.effect))}`
  const owner = (slot) => (slot === e.payer ? 'mine' : 'theirs')
  const treat = (m) => JSON.stringify(treatSplit(m.id, e.paid_by))
  const li = push(`<span class="from">หารกัน</span><span class="ok">${title}</span>
    <div class="t"><span>${esc(e.merchant)}</span><span>${baht(e.amount)}</span></div>
    จ่ายโดย ${esc(nameOf(e.paid_by))} · ${esc(modeLabel(e, ms))}<br>ผลต่อยอด: ${esc(eff)}<br><b>ยอดตอนนี้: ${esc(netSentence(t.net, ms))} ${t.net ? baht(Math.abs(t.net)) : ''}</b>
    <div class="quick">${[['หารครึ่ง', JSON.stringify({ mode: 'half' })], ...ms.map((m, i) => [`ของ${m.display_name}`, JSON.stringify({ mode: owner(i) })]), ...ms.map((m) => [`${m.display_name}เลี้ยง`, treat(m)])]
      .map(([l, m]) => `<button type="button" data-mode="${esc(m)}">${esc(l)}</button>`).join('')}</div>`, 'card')
  li.querySelector('.quick')?.addEventListener('click', async (ev) => {
    const b = /** @type {HTMLElement} */ (ev.target).closest('button')
    if (!b?.dataset.mode) return
    push(esc(b.textContent), 'me')
    const want = JSON.parse(b.dataset.mode)
    const { expense } = await api.updateExpense(e.id, { split_mode: want.mode, treated_by: want.treatedBy ?? null })
    await card(expense, '✓ เปลี่ยนการหารแล้ว')
  })
  await updateHead()
}

async function say(text) {
  push(`<span class="from">${esc(nameOf(speaker))}</span>${esc(text)}`, 'me')
  const ms = members()
  const intent = parseMessage(text, ms.map((m) => m.display_name))
  if (!intent) return // ไม่ใช่รายการ → บอทเงียบ เหมือนของจริง
  if (intent.kind === 'command') {
    if (intent.command === 'help') return void botText(HELP)
    if (intent.command === 'summary') {
      const t = await api.today()
      return void botText(`ยอดตอนนี้: ${netSentence(t.net, ms)} ${t.net ? baht(Math.abs(t.net)) : ''}\n(${t.expenses.length} รายการวันนี้)`)
    }
    if (intent.command === 'undo') {
      const last = (await api.today()).expenses.filter((e) => e.created_by === speaker).at(-1)
      if (!last) return void botText('ยังไม่มีรายการของคุณให้ยกเลิก')
      await api.deleteExpense(last.id)
      botText(`ลบ "${last.merchant} ${baht(last.amount)}" แล้ว`)
      return updateHead()
    }
    return void botText('เดโมไม่รองรับคำสั่งนี้')
  }
  const owner = ms.find((m) => m.display_name === intent.forName)
  const treater = ms.find((m) => m.display_name === intent.treatName)
  const split = treater ? treatSplit(treater.id, speaker) : { mode: intent.mode ?? (owner ? (owner.id === speaker ? 'mine' : 'theirs') : api.state.settings.default_split), treatedBy: null }
  const { expense } = await api.addExpense({ amount: intent.amount, merchant: intent.merchant, paid_by: speaker, split_mode: split.mode, treated_by: split.treatedBy, created_by: speaker, source: 'text' })
  await card(expense)
}

const first = (s) => String(s ?? '').replace(/^(นางสาว|นาง|นาย|น\.ส\.)\s*/, '').split(/\s+/)[0]

async function sendSlip(name) {
  push(`<span class="from">${esc(nameOf(speaker))}</span><img src="../test/fixtures/synthetic/${name}.png" alt="สลิปสังเคราะห์">`, 'me')
  const ai = await (await fetch(`../test/fixtures/synthetic/${name}.json`)).json()
  const me = members().find((m) => m.id === speaker)
  const other = members().find((m) => m.id !== speaker)
  const is = (m, n) => !!m && [m.display_name, ...m.bank_names].some((x) => first(x) === first(n))
  // สลิปโอนหากัน: ผู้รับเป็นอีกคน (คนโพสต์โอน) หรือผู้รับเป็นคนโพสต์เอง (อีกคนโอนมา) — ตรรกะเดียวกับ src/slip/classify.ts
  const dir = ai.type !== 'transfer_slip' ? null : is(other, ai.receiver_name) ? [me, other] : is(me, ai.receiver_name) && is(other, ai.sender_name) ? [other, me] : null
  if (dir) {
    const amount = Math.round(ai.amount * 100)
    const t = await api.addSettlement(dir[0].id, dir[1].id, amount)
    botText(`รับโอน ${dir[0].display_name} → ${dir[1].display_name} ${baht(amount)} แล้ว\n${t.net === 0 ? 'เคลียร์แล้ว ✅ ไม่มีใครติดใคร' : `ยอดตอนนี้: ${netSentence(t.net, members())} ${baht(Math.abs(t.net))}`}`)
    return updateHead()
  }
  const { expense } = await api.addExpense({ amount: Math.round(ai.amount * 100), merchant: ai.merchant ?? 'สลิป', paid_by: speaker, split_mode: 'half', created_by: speaker, source: 'slip' })
  await card(expense)
}

// ---------- สลับมุมมอง / ปุ่ม ----------
function show(view) {
  const chat = view === 'chat'
  $('#chat').hidden = !chat
  $('#app').hidden = chat
  document.querySelector('nav.tabs')?.toggleAttribute('hidden', chat)
  $('#show-chat').setAttribute('aria-selected', String(chat))
  $('#show-app').setAttribute('aria-selected', String(!chat))
}
$('#show-chat').addEventListener('click', () => show('chat'))
$('#show-app').addEventListener('click', () => show('app'))
$('#say').addEventListener('submit', (ev) => {
  ev.preventDefault()
  const input = /** @type {HTMLInputElement} */ ($('#msg'))
  const text = input.value.trim()
  input.value = ''
  if (text) say(text)
})
$('#say').addEventListener('click', (ev) => {
  const b = /** @type {HTMLElement} */ (ev.target).closest('[data-as]')
  if (!b) return
  speaker = Number(/** @type {HTMLElement} */ (b).dataset.as)
  document.querySelectorAll('[data-as]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)))
})
document.querySelector('.slips')?.addEventListener('click', (ev) => {
  const b = /** @type {HTMLElement} */ (ev.target).closest('[data-slip]')
  if (b) sendSlip(/** @type {HTMLElement} */ (b).dataset.slip)
})
$('#reset').addEventListener('click', async () => {
  api.reset()
  $('#log').innerHTML = ''
  botText('เริ่มใหม่แล้ว — ข้อมูลกลับเป็นวันตัวอย่าง')
  await updateHead()
})

await start(api)
botText('สวัสดี! นี่คือเดโมของหารกัน 👋\nลองพิมพ์ "กาแฟ 90" หรือกดส่งสลิปด้านล่าง')
await updateHead()
// ลิงก์แชร์แบบ "ลองพิมพ์ให้ดู": ?try=กาแฟ 90 (หลายข้อความคั่นด้วย |) · ?slip=slip-settle
const q = new URLSearchParams(location.search)
for (const m of (q.get('try') ?? '').split('|').filter(Boolean)) await say(m)
if (q.get('slip')) await sendSlip(q.get('slip'))
if (location.hash && location.hash !== '#/chat') show('app')
