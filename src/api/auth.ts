/** ผลตรวจ token: ผ่าน = LINE user ID · ไม่ผ่าน = เหตุผล (ใช้ใน log ห้ามมี token) */
export type VerifyResult = { sub: string } | { reason: 'expired' | 'bad_aud' | 'invalid' | 'unreachable' }

export interface IdTokenVerifier {
  verify(idToken: string): Promise<VerifyResult>
}

/** ตรวจ LIFF ID token กับ LINE (https://api.line.me/oauth2/v2.1/verify) แล้วเช็ก aud/exp ซ้ำเอง */
export class LineIdTokenVerifier implements IdTokenVerifier {
  channelId: string
  fetch: typeof fetch
  now: () => number
  constructor(channelId: string, fetchFn: typeof fetch = globalThis.fetch, now = Date.now) {
    this.channelId = channelId
    this.fetch = fetchFn
    this.now = now
  }
  async verify(idToken: string): Promise<VerifyResult> {
    let res: Response
    try {
      res = await this.fetch('https://api.line.me/oauth2/v2.1/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ id_token: idToken, client_id: this.channelId }),
        signal: AbortSignal.timeout(10_000),
      })
    } catch {
      return { reason: 'unreachable' }
    }
    const j = (await res.json().catch(() => ({}))) as { sub?: string; aud?: string; exp?: number; error_description?: string }
    if (!res.ok) {
      // LINE ตอบ 400 พร้อม error_description เช่น "IdToken expired." / "Invalid IdToken Audience."
      const d = (j.error_description ?? '').toLowerCase()
      return { reason: d.includes('expired') ? 'expired' : d.includes('audience') ? 'bad_aud' : 'invalid' }
    }
    if (j.aud !== this.channelId) return { reason: 'bad_aud' }
    if (typeof j.exp !== 'number' || j.exp * 1000 < this.now()) return { reason: 'expired' }
    return j.sub ? { sub: j.sub } : { reason: 'invalid' }
  }
}

/** โหมด fake: token รูปแบบ "fake:<LINE user ID>" */
export class FakeIdTokenVerifier implements IdTokenVerifier {
  async verify(idToken: string): Promise<VerifyResult> {
    const m = idToken.match(/^fake:(U_fake_\w+)$/)
    return m ? { sub: m[1] } : { reason: 'invalid' }
  }
}
