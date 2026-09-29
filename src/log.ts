import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const LOG_MAX_BYTES = 5 * 1024 * 1024
export const LOG_KEEP = 5

// ห้ามมี token/รูป/ข้อมูลสลิปเต็มใน log
const SECRET_KEY = /token|secret|authorization|password|api_?key|signature|cookie/i
const BULKY_KEY = /image|buffer|base64|ai_json|payload|body|content/i
const MAX_STR = 200

export function redact(v: unknown, key = '', depth = 0): unknown {
  if (SECRET_KEY.test(key)) return '[redacted]'
  if (BULKY_KEY.test(key)) return typeof v === 'string' ? `[${v.length} chars]` : '[omitted]'
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR) + '…' : v
  if (Buffer.isBuffer(v)) return `[${v.length} bytes]`
  if (v && typeof v === 'object') {
    if (depth > 3) return '[…]'
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, '', depth + 1))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k, depth + 1)]))
  }
  return v
}

/** log JSON บรรทัดเดียว ไปที่ <dir>/harnkan.log หมุนเมื่อเกิน maxBytes เก็บ keep ไฟล์ (รวมไฟล์ปัจจุบัน) */
export class Logger {
  dir: string | null
  maxBytes: number
  keep: number
  constructor(dir: string | null, maxBytes = LOG_MAX_BYTES, keep = LOG_KEEP) {
    this.dir = dir
    this.maxBytes = maxBytes
    this.keep = keep
    if (dir) mkdirSync(dir, { recursive: true })
  }
  get file() {
    return this.dir ? join(this.dir, 'harnkan.log') : null
  }
  /** harnkan.log → .1 → .2 … · rename ทับไฟล์เก่าสุดเอง จึงเหลือ keep ไฟล์เสมอ */
  rotate() {
    const f = this.file!
    for (let i = this.keep - 2; i >= 1; i--) if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`)
    renameSync(f, `${f}.1`)
  }
  write(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}) {
    const line = JSON.stringify({ at: new Date().toISOString(), level, event, ...(redact(fields) as object) }) + '\n'
    const f = this.file
    if (!f) {
      if (level !== 'info') process.stderr.write(line)
      return
    }
    try {
      if (existsSync(f) && statSync(f).size + Buffer.byteLength(line) > this.maxBytes) this.rotate()
      appendFileSync(f, line, { mode: 0o600 })
    } catch {
      process.stderr.write(line) // ดิสก์มีปัญหา → อย่าทำให้ request ล้ม
    }
  }
  info(event: string, fields?: Record<string, unknown>) { this.write('info', event, fields) }
  warn(event: string, fields?: Record<string, unknown>) { this.write('warn', event, fields) }
  error(event: string, fields?: Record<string, unknown>) { this.write('error', event, fields) }
}

/** logger กลางของ process — bootstrap() ตั้งให้เขียนลง DATA_DIR/logs · เทสต์ไม่ตั้ง = stderr เฉพาะ warn/error */
export let log = new Logger(null)
export function initLog(dir: string) {
  log = new Logger(dir)
  return log
}
