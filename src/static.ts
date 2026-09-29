import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
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

/** ไฟล์ที่เสิร์ฟได้ทั้งหมด [URL, path บนดิสก์] เรียงคงที่ */
function assetFiles(root: string): [string, string][] {
  const out: [string, string][] = []
  for (const [prefix, dir, allow] of MOUNTS) {
    const base = resolve(root, dir)
    for (const f of readdirSync(base, { recursive: true }) as string[]) {
      const rel = f.split('\\').join('/')
      if (allow.test(rel) && rel !== 'index.html' && statSync(join(base, f)).isFile()) out.push([prefix + rel, join(base, f)])
    }
  }
  return out.sort((a, b) => a[0].localeCompare(b[0]))
}

/**
 * เวอร์ชันของ mini app = hash ของเนื้อไฟล์ทั้งหมด (แก้ไฟล์ไหนก็เปลี่ยน) · คำนวณทุกครั้ง ไม่ต้องจำ ไม่พึ่ง git
 * ponytail: hash ~15 ไฟล์ต่อ request ของ index/config — ถ้าไฟล์เยอะขึ้นมากค่อย cache ตาม mtime
 */
export function assetVersion(root = ROOT) {
  const h = createHash('sha256')
  for (const [url, file] of assetFiles(root)) h.update(url).update('\0').update(readFileSync(file)).update('\0')
  return h.digest('hex').slice(0, 12)
}

/**
 * index.html → ใส่ ?v=<เวอร์ชัน> ให้ CSS/JS ทุกตัว (รวม module ที่ import กันเองแบบ relative ผ่าน importmap) + meta เวอร์ชัน
 * webview ของ LINE แคชหนัก หลัง deploy จึงเห็นหน้าเก่า (เจอจริงหลัง B17)
 */
export function renderIndex(html: string, version: string, root = ROOT) {
  const imports: Record<string, string> = {}
  for (const [url] of assetFiles(root)) {
    if (!url.endsWith('.js')) continue
    imports[url] = `${url}?v=${version}`
    if (url.startsWith('/domain/')) imports[`#domain/${url.slice('/domain/'.length)}`] = `${url}?v=${version}`
  }
  return html
    .replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">${JSON.stringify({ imports })}</script>`)
    .replace(/(href|src)="\.\/([\w./-]+\.(?:css|js))"/g, `$1="./$2?v=${version}"`)
    .replace('<meta charset="utf-8">', `<meta charset="utf-8">\n  <meta name="harnkan-version" content="${version}">`)
}

const LONG = 'public, max-age=31536000, immutable'

/** เสิร์ฟไฟล์ static · คืน false ถ้า path ไม่อยู่ใน mount ใด · v = ?v= ของ URL (ตรงเวอร์ชันปัจจุบัน → แคชยาว) */
export function serveStatic(res: ServerResponse, pathname: string, v: string | null = null): boolean {
  for (const [prefix, dir, allow] of MOUNTS) {
    if (!pathname.startsWith(prefix)) continue
    const rel = pathname.slice(prefix.length) || 'index.html'
    const base = resolve(ROOT, dir)
    const file = resolve(base, rel)
    if (!allow.test(rel) || rel.split('/').includes('..') || !file.startsWith(base + '/')) return send(res, 404, { error: 'not found' }), true
    try {
      if (!statSync(file).isFile()) throw new Error()
      let buf = readFileSync(file)
      const version = assetVersion()
      const isIndex = prefix === '/app/' && rel === 'index.html'
      if (isIndex) buf = Buffer.from(renderIndex(buf.toString('utf8'), version))
      const csp: Record<string, string> = extname(file) === '.html' ? { 'content-security-policy': cspFor(buf.toString('utf8')) } : {}
      const cache = !isIndex && v === version ? LONG : 'no-cache'
      send(res, 200, buf, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': cache, ...csp })
    } catch {
      send(res, 404, { error: 'not found' })
    }
    return true
  }
  return false
}

