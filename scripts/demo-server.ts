// เสิร์ฟเดโมแบบ static ล้วน (เหมือน Cloudflare Pages): เฉพาะ demo/ public/app/ src/domain/ test/fixtures/synthetic/
import { readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { extname, resolve } from 'node:path'

export const DEMO_DIRS = ['demo/', 'public/app/', 'src/domain/', 'test/fixtures/synthetic/']
const ROOT = resolve(import.meta.dirname, '..')
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png' }

export function demoServer() {
  return createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)
    if (path === '/') {
      res.writeHead(302, { location: '/demo/' })
      return res.end()
    }
    const rel = path.slice(1).replace(/\/$/, '/index.html')
    const file = resolve(ROOT, rel)
    const ok = DEMO_DIRS.some((d) => rel.startsWith(d)) && file.startsWith(ROOT + '/') && !rel.includes('..') && TYPES[extname(file)]
    try {
      if (!ok || !statSync(file).isFile()) throw new Error()
      res.writeHead(200, { 'content-type': TYPES[extname(file)], 'cache-control': 'no-cache' })
      res.end(readFileSync(file))
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('not found')
    }
  })
}

if (process.argv[1]?.endsWith('demo-server.ts')) {
  const port = Number(process.env.PORT) || 8788
  demoServer().listen(port, '127.0.0.1', () => console.log(`เดโม: http://127.0.0.1:${port}/demo/`))
}
