// @ts-check
// เซสชันของ mini app: เวอร์ชันหน้า (กันแคชหลัง deploy) + LIFF ID token (หมดอายุ ~1 ชม.)
// แยกจาก boot.js เพื่อให้เทสต์ใน node ได้ด้วย LIFF stub

/** @typedef {{ getItem(k: string): string | null, setItem(k: string, v: string): void, removeItem(k: string): void }} Store */

export const RELOAD_KEY = 'harnkan-reload'
export const RELOGIN_KEY = 'harnkan-relogin'
/** ลองเข้าสู่ระบบใหม่ได้ 1 ครั้งต่อช่วงนี้ — กลับมาแล้วยังไม่ผ่านภายในช่วง = แสดงข้อความ ไม่วน */
export const RELOGIN_WINDOW_MS = 5 * 60_000
/** token ที่เหลืออายุน้อยกว่านี้ถือว่าใกล้หมด */
export const TOKEN_MARGIN_MS = 60_000
export const EXPIRED_MSG = 'เซสชันหมดอายุ กำลังเข้าสู่ระบบใหม่…'
export const GIVE_UP_MSG = 'เซสชันหมดอายุและเข้าสู่ระบบใหม่ไม่สำเร็จ — ปิดหน้านี้แล้วเปิดแอปจาก LINE อีกครั้ง'

/**
 * หน้าเป็นเวอร์ชันเก่ากว่า server → reload 1 ครั้งต่อเวอร์ชัน (จำใน sessionStorage กันวน)
 * @param {string | null | undefined} page @param {string | null | undefined} server @param {Store} storage
 */
export function needsReload(page, server, storage) {
  if (!page || !server || page === server) return false
  const k = `${RELOAD_KEY}:${server}`
  if (storage.getItem(k)) return false
  storage.setItem(k, '1')
  return true
}

/** รอ redirect ไปหน้า login (ไม่ resolve) */
const never = () => new Promise(() => {})

export class LiffSession {
  /**
   * @param {any} liff
   * @param {{ storage: Store, href: string, now?: () => number, notify?: (msg: string) => void }} o
   */
  constructor(liff, o) {
    this.liff = liff
    this.storage = o.storage
    this.href = o.href
    this.now = o.now ?? Date.now
    this.notify = o.notify ?? (() => {})
  }
  tokenFresh() {
    const d = this.liff.getDecodedIDToken?.()
    return !!d && typeof d.exp === 'number' && d.exp * 1000 > this.now() + TOKEN_MARGIN_MS
  }
  /** logout แล้ว login ใหม่ (redirect กลับหน้าเดิม) ได้ครั้งเดียวต่อช่วง · ครั้งที่สองติดกัน throw ข้อความให้คนอ่าน */
  relogin() {
    const last = Number(this.storage.getItem(RELOGIN_KEY) || 0)
    if (last && this.now() - last < RELOGIN_WINDOW_MS) throw new Error(GIVE_UP_MSG)
    this.storage.setItem(RELOGIN_KEY, String(this.now()))
    this.notify(EXPIRED_MSG)
    if (this.liff.isLoggedIn()) this.liff.logout()
    this.liff.login({ redirectUri: this.href })
    return never()
  }
  /** ID token ที่ยังไม่หมดอายุ · หมด/ใกล้หมด (เปิดนอกแอป LINE ค้างไว้) → login ใหม่ */
  async getToken() {
    if (!this.liff.isLoggedIn() || !this.tokenFresh()) await this.relogin()
    return this.liff.getIDToken()
  }
  /** API ตอบ 401 */
  onUnauthorized() {
    return this.relogin()
  }
  /** API ผ่าน → ล้าง guard ให้ครั้งหน้า login ใหม่ได้อีก */
  onOk() {
    this.storage.removeItem(RELOGIN_KEY)
  }
}
