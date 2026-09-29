import { Jimp } from 'jimp'
import jsQR from 'jsqr'
import { slipVerify } from 'promptparse/validate'

const MAX_SIDE = 1600

/** อ่าน QR จากรูป · ไม่มี QR หรือรูปเสีย → null (ห้าม throw) */
export async function decodeQr(buf: Buffer): Promise<string | null> {
  try {
    const img = await Jimp.read(buf)
    if (Math.max(img.width, img.height) > MAX_SIDE) {
      img.scaleToFit({ w: MAX_SIDE, h: MAX_SIDE })
    }
    const { data, width, height } = img.bitmap
    const r = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width, height)
    return r?.data ?? null
  } catch {
    return null
  }
}

export type SlipQr = { payload: string; sendingBank: string; transRef: string }

/** QR ของสลิปโอน (Slip Verify) → ธนาคารผู้โอน + เลขอ้างอิง · ไม่ใช่สลิป → null */
export async function readSlipQr(buf: Buffer): Promise<SlipQr | null> {
  const payload = await decodeQr(buf)
  if (!payload) return null
  const v = slipVerify(payload, true)
  return v ? { payload, ...v } : null
}
