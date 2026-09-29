import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sign, verifySignature } from '../src/line/signature.ts'
import { makeServer } from '../src/server.ts'
import { A_ID, B_ID, ev, listen, makeCtx, postWebhook } from './helpers/app.ts'

test('signature: ถูก/ผิด/ว่าง', () => {
  const s = sign('{"a":1}', 'secret')
  assert.equal(verifySignature('{"a":1}', s, 'secret'), true)
  assert.equal(verifySignature('{"a":2}', s, 'secret'), false)
  assert.equal(verifySignature('{"a":1}', undefined, 'secret'), false)
  assert.equal(verifySignature('{"a":1}', 'short', 'secret'), false)
})

test('webhook: เซ็นถูก 200 · เซ็นผิด 401 · healthz · body ใหญ่ 413', async () => {
  const { ctx } = makeCtx()
  const srv = await listen(makeServer(ctx))
  try {
    assert.equal((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [])).status, 200)
    assert.equal((await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [], true)).status, 401)
    assert.equal((await fetch(`${srv.base}/healthz`)).status, 200)
    const big = await fetch(`${srv.base}/webhook`, { method: 'POST', body: 'x'.repeat(300 * 1024) }).catch(() => null)
    assert.ok(!big || big.status === 413)
  } finally {
    await srv.close()
  }
})

test('join + 2 ข้อความ → couple 1 + members 2 · คนที่ 3 ได้คำตอบสุภาพ', async () => {
  const { ctx, repo, line } = makeCtx()
  line.profiles.set('U_fake_c', 'ซี')
  const srv = await listen(makeServer(ctx))
  try {
    const r = await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [ev.join(), ev.text(A_ID, 'สวัสดี'), ev.text(B_ID, 'หวัดดี')])
    assert.equal(r.status, 200)
    assert.equal(repo.allCouples().length, 1)
    const ms = repo.members(repo.allCouples()[0].id)
    assert.deepEqual(ms.map((m) => [m.line_user_id, m.display_name]), [[A_ID, 'เอ'], [B_ID, 'บี']])

    line.take()
    await postWebhook(srv.base, ctx.cfg.lineChannelSecret, [ev.text('U_fake_c', 'ขอด้วย'), ev.text('U_fake_c', 'อีกที')])
    assert.equal(repo.members(repo.allCouples()[0].id).length, 2)
    const out = line.take()
    assert.equal(out.length, 1)
    assert.match(JSON.stringify(out[0].messages), /2 คน/)
  } finally {
    await srv.close()
  }
})
