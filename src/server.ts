import { createServer, type Server } from 'node:http'
import { HttpError, readBody, send } from './http.ts'
import type { Ctx } from './app.ts'
import { handleEvent, type Handlers, type LineEvent } from './line/router.ts'
import { verifySignature } from './line/signature.ts'
import { readQrPng } from './promptpay/qr.ts'
import { handleApi } from './api/routes.ts'
import { serveStatic } from './static.ts'
import { log } from './log.ts'
import { health } from './health.ts'
import { clientIp, LIMITS, RateLimiter } from './security.ts'

export const WEBHOOK_MAX_BYTES = 256 * 1024

/** ตรวจรูปร่าง event ขั้นต่ำก่อนส่งให้ router (field ที่ใช้ต้องเป็นชนิดที่ถูกและไม่ยาวผิดปกติ) */
export function isEvent(e: unknown): e is LineEvent {
  if (!e || typeof e !== 'object') return false
  const ev = e as Record<string, any>
  const str = (v: unknown, max: number) => v === undefined || (typeof v === 'string' && v.length <= max)
  return typeof ev.type === 'string' && str(ev.replyToken, 200) && (ev.source === undefined || (typeof ev.source === 'object' && str(ev.source?.groupId, 100) && str(ev.source?.userId, 100)))
    && (ev.message === undefined || (typeof ev.message === 'object' && str(ev.message?.id, 100) && str(ev.message?.type, 30) && str(ev.message?.text, 5000)))
    && (ev.postback === undefined || (typeof ev.postback === 'object' && str(ev.postback?.data, 300)))
}

export function makeServer(ctx: Ctx, handlers: Handlers = {}, limits = LIMITS): Server {
  const limiters = { api: new RateLimiter(limits.api), webhook: new RateLimiter(limits.webhook) }
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://x')
      const bucket = url.pathname.startsWith('/api/') ? 'api' : url.pathname === '/webhook' ? 'webhook' : null
      if (bucket) {
        const ip = clientIp(req)
        const wait = limiters[bucket].take(ip, ctx.now())
        if (wait) {
          log.warn('rate_limited', { bucket, ip })
          return send(res, 429, { error: 'เรียกถี่เกินไป ลองใหม่อีกสักครู่' }, { 'retry-after': String(wait) })
        }
      }
      if (req.method === 'GET' && url.pathname === '/healthz') return send(res, 200, health(ctx), { 'cache-control': 'no-store' })
      const qr = url.pathname.match(/^\/qr\/([^/]+)\.png$/)
      if (req.method === 'GET' && qr) {
        const png = readQrPng(ctx.cfg.dataDir, qr[1], ctx.now())
        return png ? send(res, 200, png, { 'content-type': 'image/png', 'cache-control': 'private, max-age=3600' }) : send(res, 404, { error: 'not found' })
      }
      if (req.method === 'POST' && url.pathname === '/webhook') {
        const body = await readBody(req, WEBHOOK_MAX_BYTES)
        if (!verifySignature(body, req.headers['x-line-signature'] as string | undefined, ctx.cfg.lineChannelSecret)) {
          log.warn('webhook_bad_signature', { bytes: body.length })
          return send(res, 401, { error: 'bad signature' })
        }
        let events: unknown
        try {
          events = (JSON.parse(body.toString('utf8')) as { events?: unknown }).events ?? []
        } catch {
          return send(res, 400, { error: 'bad json' })
        }
        if (!Array.isArray(events) || events.length > 100) return send(res, 400, { error: 'events ต้องเป็น array' })
        for (const ev of events.filter(isEvent)) {
          try {
            await handleEvent(ctx, ev, handlers)
          } catch (e) {
            log.error('event_error', { type: ev.type, message: (e as Error).message }) // ตอบ 200 เสมอ กัน LINE ส่งซ้ำ
          }
        }
        return send(res, 200, { ok: true })
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/app')) return send(res, 302, { to: '/app/' }, { location: '/app/' })
      if (req.method === 'GET' && url.pathname === '/app/config.json') return send(res, 200, { liffId: ctx.cfg.liffId, fake: ctx.cfg.fakeLine })
      if (req.method === 'GET' && serveStatic(res, url.pathname)) return
      if (await handleApi(ctx, req, res, url)) return
      send(res, 404, { error: 'not found' })
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) log.error('http_error', { path: req.url?.split('?')[0], message: (e as Error).message })
      else if (status === 401) log.warn('auth_fail', { path: req.url?.split('?')[0] })
      const field = e instanceof HttpError && e.field ? { field: e.field } : {}
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'internal error' : (e as Error).message, ...field })
    }
  })
}

export async function start() {
  const { bootstrap } = await import('./app.ts')
  const { handlers } = await import('./bot.ts')
  const ctx = bootstrap()
  const server = makeServer(ctx, handlers)
  server.listen(ctx.cfg.port, ctx.cfg.host, () => console.log(`harnkan ฟังที่ http://${ctx.cfg.host}:${ctx.cfg.port} (fakeLine=${ctx.cfg.fakeLine} fakeAi=${ctx.cfg.fakeAi})`))
  return server
}

if (import.meta.main ?? process.argv[1]?.endsWith('server.ts')) await start()
