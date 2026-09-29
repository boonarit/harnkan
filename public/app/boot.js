// จุดเริ่มแอปจริง: โหลด config → LIFF (หรือ fake token ตอน dev) → ApiAdapter
import { ApiAdapter } from './data/adapter.js'
import { start } from './main.js'

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

async function tokenGetter() {
  const cfg = await (await fetch('/app/config.json')).json()
  if (cfg.fake) {
    // dev: ?as=U_fake_b สลับคน (จำไว้ใน sessionStorage)
    const as = new URLSearchParams(location.search).get('as')
    if (as) sessionStorage.setItem('harnkan-as', as)
    const who = sessionStorage.getItem('harnkan-as') || 'U_fake_a'
    return async () => `fake:${who}`
  }
  await loadScript(LIFF_SDK)
  const liff = /** @type {any} */ (window).liff
  await liff.init({ liffId: cfg.liffId })
  if (!liff.isLoggedIn()) {
    liff.login()
    await new Promise(() => {}) // รอ redirect
  }
  return async () => liff.getIDToken()
}

const couple = Number(new URLSearchParams(location.search).get('couple')) || null
start(new ApiAdapter({ getToken: await tokenGetter(), couple }))
