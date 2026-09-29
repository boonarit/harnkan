export interface IdTokenVerifier {
  /** คืน LINE user ID ของเจ้าของ token หรือ null ถ้าไม่ผ่าน */
  verify(idToken: string): Promise<string | null>
}

/** ตรวจ LIFF ID token กับ LINE (https://api.line.me/oauth2/v2.1/verify) */
export class LineIdTokenVerifier implements IdTokenVerifier {
  channelId: string
  constructor(channelId: string) {
    this.channelId = channelId
  }
  async verify(idToken: string) {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: this.channelId }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return null
    const j = (await res.json()) as { sub?: string; aud?: string; exp?: number }
    if (!j.sub || j.aud !== this.channelId || (j.exp && j.exp * 1000 < Date.now())) return null
    return j.sub
  }
}

/** โหมด fake: token รูปแบบ "fake:<LINE user ID>" */
export class FakeIdTokenVerifier implements IdTokenVerifier {
  async verify(idToken: string) {
    const m = idToken.match(/^fake:(U_fake_\w+)$/)
    return m ? m[1] : null
  }
}
