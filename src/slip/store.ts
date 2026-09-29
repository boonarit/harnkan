import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function imageExt(buf: Buffer) {
  if (buf[0] === 0x89 && buf[1] === 0x50) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return 'bin'
}

/** เก็บรูปที่ DATA_DIR/slips/<couple>/<yyyy-mm>/<uuid>.<ext> · คืน path แบบ relative กับ DATA_DIR */
export function saveSlipImage(dataDir: string, coupleId: number, day: string, buf: Buffer): string {
  const rel = join('slips', String(coupleId), day.slice(0, 7), `${randomUUID()}.${imageExt(buf)}`)
  mkdirSync(join(dataDir, rel, '..'), { recursive: true })
  writeFileSync(join(dataDir, rel), buf, { mode: 0o600 })
  return rel
}
