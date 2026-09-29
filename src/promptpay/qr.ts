import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { anyId } from 'promptparse/generate'
import QRCode from 'qrcode'

export const QR_TTL_MS = 24 * 3600_000
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/

/** เบอร์มือถือ 10 หลัก / เลขบัตร 13 หลัก / e-wallet 15 หลัก → payload พร้อมเพย์ใส่ยอด */
export function promptpayPayload(target: string, amountSatang: number): string {
  const t = target.replace(/\D/g, '')
  const type = t.length === 10 ? 'MSISDN' : t.length === 13 ? 'NATID' : t.length === 15 ? 'EWALLETID' : null
  if (!type) throw new Error('พร้อมเพย์ต้องเป็นเบอร์ 10 หลัก เลขบัตร 13 หลัก หรือ e-wallet 15 หลัก')
  return anyId({ type, target: t, amount: amountSatang / 100 })
}

export function isPromptpayId(s: string) {
  return /^(\d{10}|\d{13}|\d{15})$/.test(s.replace(/[\s-]/g, ''))
}

/** สร้างรูป QR เก็บที่ DATA_DIR/qr/<token>.png · คืน token (สุ่ม เดาไม่ได้) */
export async function makeQrPng(dataDir: string, target: string, amountSatang: number): Promise<string> {
  const token = randomBytes(18).toString('base64url')
  const dir = join(dataDir, 'qr')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${token}.png`), await QRCode.toBuffer(promptpayPayload(target, amountSatang), { width: 480, margin: 2 }), { mode: 0o600 })
  return token
}

/** อ่านรูป QR ถ้า token ถูกรูปแบบและยังไม่หมดอายุ 24 ชม. */
export function readQrPng(dataDir: string, token: string, now = Date.now()): Buffer | null {
  if (!TOKEN.test(token)) return null
  const f = join(dataDir, 'qr', `${token}.png`)
  try {
    if (now - statSync(f).mtimeMs > QR_TTL_MS) return null
    return readFileSync(f)
  } catch {
    return null
  }
}
