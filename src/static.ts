import { readFileSync, statSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import type { ServerResponse } from 'node:http'
import { send } from './http.ts'
import { cspFor } from './security.ts'

const ROOT = resolve(import.meta.dirname, '..')
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
}

/** mount: prefix URL → โฟลเดอร์ในรีโป (อ่านเฉพาะไฟล์ใต้โฟลเดอร์นั้น) */
export const MOUNTS: [string, string, RegExp][] = [
  ['/app/', 'public/app', /^[\w./-]+\.(html|js|css|json|png|svg|webmanifest)$/],
  ['/domain/', 'src/domain', /^\w+\.js$/],
]

/** เสิร์ฟไฟล์ static · คืน false ถ้า path ไม่อยู่ใน mount ใด */
export function serveStatic(res: ServerResponse, pathname: string): boolean {
  for (const [prefix, dir, allow] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue
    const rel = pathname.slice(prefix.length) || 'index.html'
    const base = resolve(ROOT, dir)
    const file = resolve(base, rel)
    if (!allow.test(rel) || rel.split('/').includes('..') || !file.startsWith(base + '/')) return send(res, 404, { error: 'not found' }), true
    try {
      if (!statSync(file).isFile()) throw new Error()
      const buf = readFileSync(file)
      const csp: Record<string, string> = extname(file) === '.html' ? { 'content-security-policy': cspFor(buf.toString('utf8')) } : {}
      send(res, 200, buf, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache', ...csp })
    } catch {
      send(res, 404, { error: 'not found' })
    }
    return true
  }
  return false
}

