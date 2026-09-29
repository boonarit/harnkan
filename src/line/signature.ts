import { createHmac, timingSafeEqual } from 'node:crypto'

export function sign(body: Buffer | string, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('base64')
}

/** ตรวจ x-line-signature (HMAC-SHA256 base64) แบบ timing-safe */
export function verifySignature(body: Buffer | string, signature: string | undefined, secret: string): boolean {
  if (!signature || !secret) return false
  const a = Buffer.from(sign(body, secret))
  const b = Buffer.from(signature)
  return a.length === b.length && timingSafeEqual(a, b)
}
