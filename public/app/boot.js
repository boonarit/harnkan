// จุดเริ่มแอปจริง: โหลด config → เช็กเวอร์ชัน (กันหน้าเก่าในแคช) → LIFF (หรือ fake token ตอน dev) → ApiAdapter
import { ApiAdapter } from './data/adapter.js'
import { start } from './main.js'
import { LiffSession, needsReload } from './session.js'

const LIFF_SDK = 'https://static.line-scdn.net/liff/edge/2/sdk.js'

function loadScript(src) {
  return new Promise((ok, fail) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = ok
    s.onerror = () => fail(new Error('โหลด LIFF SDK ไม่ได้'))
    document.head.append(s)
  })
}

/** sessionStorage ใช้ไม่ได้ (private mode) → หน่วยความจำ */
function safeSession() {
  try {
    sessionStorage.setItem('__t', '1')
    sessionStorage.removeItem('__t')
    return sessionStorage
  } catch {
    const m = new Map()
    return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) }
  }
}

const notify = (msg) => {
  const app = document.getElementById('app')
  if (app) app.innerHTML = `<p class="loading">${msg}</p>`
}

async function session() {
  const storage = safeSession()
  const cfg = await (await fetch('/app/config.json', { cache: 'no-store' })).json()
  const page = document.querySelector('meta[name="harnkan-version"]')?.getAttribute('content')
  if (needsReload(page, cfg.version, storage)) {
    const u = new URL(location.href)
    u.searchParams.set('v', cfg.version)
    location.replace(u.href)
    await new Promise(() => {})
  }
  if (cfg.fake) {
    // dev: ?as=U_fake_b สลับคน (จำไว้ใน sessionStorage)
    const as = new URLSearchParams(location.search).get('as')
    if (as) storage.setItem('harnkan-as', as)
    const who = storage.getItem('harnkan-as') || 'U_fake_a'
    return { getToken: async () => `fake:${who}` }
  }
  await loadScript(LIFF_SDK)
  const liff = /** @type {any} */ (window).liff
  await liff.init({ liffId: cfg.liffId })
  const s = new LiffSession(liff, { storage, href: location.href, notify })
  return { getToken: () => s.getToken(), onUnauthorized: () => s.onUnauthorized(), onOk: () => s.onOk() }
}

const couple = Number(new URLSearchParams(location.search).get('couple')) || null
start(new ApiAdapter({ ...(await session()), couple }))
