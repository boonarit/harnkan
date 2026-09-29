import { readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Ctx } from '../app.ts'
import { QR_TTL_MS } from '../promptpay/qr.ts'
import { LOG_MAX_BYTES, log } from '../log.ts'

/**
 * ลบรูปสลิปเก่ากว่า slip_retention_days (ค่าต่อคู่ใน DB, ไม่ตั้งใช้ SLIP_RETENTION_DAYS) — ตัวเลขใน DB เก็บไว้
 * + ลบรูป QR หมดอายุ + ตัด stdout log ของ launchd ที่เกินขนาด
 */
export function runRetention(ctx: Ctx) {
  const { repo, cfg } = ctx
  const now = ctx.now()
  let slips = 0
  for (const c of repo.allCouples()) {
    const days = c.slip_retention_days ?? cfg.slipRetentionDays
    const cutoff = new Date(now - days * 86400_000).toISOString()
    for (const s of repo.slipImages(c.id)) {
      if (s.created_at >= cutoff) continue
      const f = resolve(cfg.dataDir, s.image_path!)
      if (f.startsWith(resolve(cfg.dataDir, 'slips') + '/')) rmSync(f, { force: true })
      repo.updateSlip(s.id, { image_path: null })
      slips++
    }
  }
  let qr = 0
  const qrDir = join(cfg.dataDir, 'qr')
  for (const f of safeList(qrDir)) {
    if (now - statSync(join(qrDir, f)).mtimeMs > QR_TTL_MS) {
      rmSync(join(qrDir, f), { force: true })
      qr++
    }
  }
  const logDir = join(cfg.dataDir, 'logs')
  for (const f of safeList(logDir).filter((f) => f.endsWith('.stdout.log'))) {
    if (statSync(join(logDir, f)).size > LOG_MAX_BYTES) renameSync(join(logDir, f), join(logDir, `${f}.old`))
  }
  log.info('retention_done', { slips, qr })
  return { slips, qr }
}

function safeList(dir: string) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

if (process.argv[1]?.endsWith('retention.ts')) {
  const { bootstrap } = await import('../app.ts')
  console.log(JSON.stringify({ job: 'retention', ...runRetention(bootstrap()) }))
}
