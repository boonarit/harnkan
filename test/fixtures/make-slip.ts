// วาดสลิปสังเคราะห์ (พื้นขาว + ข้อความ + QR ปลอม) — ห้ามใช้สลิปจริง
import { Jimp, loadFont } from 'jimp'
import { SANS_16_BLACK, SANS_32_BLACK } from 'jimp/fonts'
import QRCode from 'qrcode'

export async function makeSlipPng(opts: { title: string; lines: string[]; qr?: string | null }): Promise<Buffer> {
  const W = 480
  const H = 760
  const img = new Jimp({ width: W, height: H, color: 0xffffffff })
  const big = await loadFont(SANS_32_BLACK)
  const small = await loadFont(SANS_16_BLACK)
  img.print({ font: big, x: 24, y: 24, text: opts.title })
  opts.lines.forEach((text, i) => img.print({ font: small, x: 24, y: 90 + i * 28, text }))
  if (opts.qr) {
    const qr = QRCode.create(opts.qr, { errorCorrectionLevel: 'M' })
    const n = qr.modules.size
    const scale = 6
    const quiet = 4 * scale
    const x0 = (W - n * scale) / 2 - quiet
    const y0 = H - n * scale - 2 * quiet - 24
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (!qr.modules.get(r, c)) continue
        for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) img.setPixelColor(0x000000ff, x0 + quiet + c * scale + dx, y0 + quiet + r * scale + dy)
      }
    }
  }
  return img.getBuffer('image/png')
}
