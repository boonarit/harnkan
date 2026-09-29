import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { Ctx } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { openDb } from '../../src/db/schema.ts'
import { Repo } from '../../src/db/repo.ts'
import { FakeLineClient } from '../../src/line/client.ts'
import type { LineEvent } from '../../src/line/router.ts'
import { sign } from '../../src/line/signature.ts'
import { FakeSlipReader } from '../../src/slip/vision.ts'
import { FakeIdTokenVerifier } from '../../src/api/auth.ts'
import { A_ID, B_ID, GROUP, tmpDir } from './db.ts'

export { A_ID, B_ID, GROUP }

export function makeCtx(opts: { now?: number; env?: Record<string, string> } = {}) {
  const dir = tmpDir()
  const cfg = loadConfig({ HARNKAN_ENV: '/nonexistent', DATA_DIR: dir, ...opts.env })
  const repo = new Repo(openDb(join(dir, 'harnkan.db')))
  const line = new FakeLineClient()
  const clock = { t: opts.now ?? Date.parse('2026-09-29T08:00:00+07:00') }
  const slips = new FakeSlipReader()
  const ctx: Ctx = { cfg, repo, line, slips, verifier: new FakeIdTokenVerifier(), now: () => clock.t }
  return { ctx, repo, line, slips, clock, dir }
}

let n = 0
export const ev = {
  join: (): LineEvent => ({ type: 'join', replyToken: `rt${++n}`, source: { type: 'group', groupId: GROUP } }),
  text: (userId: string, text: string): LineEvent => ({
    type: 'message', replyToken: `rt${++n}`, source: { type: 'group', groupId: GROUP, userId }, message: { id: `m${n}`, type: 'text', text },
  }),
  image: (userId: string, messageId: string): LineEvent => ({
    type: 'message', replyToken: `rt${++n}`, source: { type: 'group', groupId: GROUP, userId }, message: { id: messageId, type: 'image' },
  }),
  postback: (userId: string, data: string): LineEvent => ({
    type: 'postback', replyToken: `rt${++n}`, source: { type: 'group', groupId: GROUP, userId }, postback: { data },
  }),
}

export async function listen(server: import('node:http').Server) {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { base, close: () => new Promise<void>((r) => server.close(() => r())) }
}

export async function postWebhook(base: string, secret: string, events: LineEvent[], badSig = false) {
  const body = JSON.stringify({ destination: 'fake', events })
  return fetch(`${base}/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-line-signature': badSig ? 'nope' : sign(body, secret) },
    body,
  })
}
