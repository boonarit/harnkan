import { createHash } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

/** IP ของผู้เรียก · เชื่อ CF-Connecting-IP เฉพาะเมื่อมาจาก loopback (= ผ่าน cloudflared บนเครื่องเดียวกัน) */
export function clientIp(req: IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown'
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  const cf = req.headers['cf-connecting-ip']
  return loopback && typeof cf === 'string' && /^[0-9a-fA-F:.]{3,45}$/.test(cf) ? cf : remote
}

/** fixed window ต่อ key · ponytail: เก็บในหน่วยความจำ process เดียว พอสำหรับเครื่องเดียว */
export class RateLimiter {
  limit: number
  windowMs: number
  hits = new Map<string, { n: number; reset: number }>()
  constructor(limit: number, windowMs = 60_000) {
    this.limit = limit
    this.windowMs = windowMs
  }
  /** คืน 0 ถ้าผ่าน หรือวินาทีที่ต้องรอ */
  take(key: string, now = Date.now()): number {
    let h = this.hits.get(key)
    if (!h || now >= h.reset) {
      if (this.hits.size > 10_000) for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k)
      h = { n: 0, reset: now + this.windowMs }
      this.hits.set(key, h)
    }
    h.n++
    return h.n > this.limit ? Math.ceil((h.reset - now) / 1000) : 0
  }
}

export const LIMITS = { api: 120, webhook: 600 } // ต่อ IP ต่อนาที

/** header ทุก response */
export const BASE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
}

/** CSP ของหน้า HTML: อนุญาตแค่ตัวเอง + LIFF SDK/LINE + Google Fonts + import map inline (ด้วย hash) */
export function cspFor(html: string): string {
  const hashes = [...html.matchAll(/<script type="importmap">([\s\S]*?)<\/script>/g)].map((m) => `'sha256-${createHash('sha256').update(m[1]).digest('base64')}'`)
  return [
    "default-src 'self'",
    `script-src 'self' https://static.line-scdn.net ${hashes.join(' ')}`.trim(),
    "style-src 'self' https://fonts.googleapis.com",
    "font-src https://fonts.gstatic.com",
    "img-src 'self' blob: data: https://*.line-scdn.net",
    "connect-src 'self' https://*.line.me https://*.line-scdn.net",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
  ].join('; ')
}
