import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { LocalAdapter } from '../public/app/data/adapter.js'
import { demoSeed } from '../demo/seed.js'
import { demoServer } from '../scripts/demo-server.ts'
import { listen } from './helpers/app.ts'

const ROOT = resolve(import.meta.dirname, '..')
const mem = () => {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) }
}

test('LocalAdapter + ข้อมูลเดโม: วันตัวอย่าง = 34750 (บี โอนให้ เอ) · ย้อนหลัง 3 สัปดาห์เคลียร์แล้ว', async () => {
  const now = () => Date.parse('2026-09-29T20:30:00+07:00')
  const api = new LocalAdapter({ storage: mem(), seed: () => demoSeed(now()), now })
  const t = await api.today()
  assert.equal(t.day, '2026-09-29')
  assert.equal(t.net, 34750)
  assert.equal(t.carried_in, 0)
  assert.equal(t.expenses.length, 5)
  assert.deepEqual([t.pending!.from, t.pending!.to, t.pending!.amount], [2, 1, 34750])
  const sep = await api.days('2026-09')
  const past = sep.days.filter((d: any) => d.date < '2026-09-29')
  assert.ok(past.length >= 20, `history ${past.length}`)
  assert.ok(past.every((d: any) => d.settled))
  // โอนเคลียร์ในเดโม
  assert.equal((await api.addSettlement(2, 1, 34750)).net, 0)
})

/** ไล่ import แบบ static จาก entry (relative + #domain/) */
function crawl(entry: string, domainDir: string) {
  const seen = new Set<string>()
  const walk = (f: string) => {
    if (seen.has(f)) return
    seen.add(f)
    const src = readFileSync(f, 'utf8')
    const specs = [...src.matchAll(/^\s*(?:import|export)\b[^;'"]*?from\s*['"]([^'"]+)['"]/gm), ...src.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)]
    for (const m of specs) {
      const spec = m[1]
      const next = spec.startsWith('#domain/') ? join(domainDir, spec.slice(8)) : spec.startsWith('.') ? resolve(dirname(f), spec) : null
      assert.ok(next, `${f} import นอกโปรเจกต์: ${spec}`)
      assert.ok(existsSync(next!), `${f} → ${spec} ไม่มีไฟล์`)
      walk(next!)
    }
  }
  walk(entry)
  return [...seen]
}

test('เดโมไม่มี request ออกเน็ตยกเว้นฟอนต์ และไม่โหลด LIFF/boot.js', () => {
  const files = [...crawl(join(ROOT, 'demo/demo.js'), join(ROOT, 'src/domain')), join(ROOT, 'demo/index.html'), join(ROOT, 'demo/demo.css'), join(ROOT, 'public/app/app.css')]
  assert.ok(files.some((f) => f.endsWith('public/app/main.js')), 'ใช้ public/app ชุดเดียวกัน')
  assert.ok(files.some((f) => f.endsWith('src/domain/parse.js')), 'ใช้ parse ตัวเดียวกับบอท')
  assert.ok(!files.some((f) => f.endsWith('boot.js')))
  const html = readFileSync(join(ROOT, 'demo/index.html'), 'utf8')
  assert.match(html, /"#domain\/": "\.\.\/src\/domain\/"/)
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    for (const m of src.matchAll(/https?:\/\/[^\s'"`)<>]+/g)) {
      const host = new URL(m[0]).host
      assert.ok(['fonts.googleapis.com', 'fonts.gstatic.com'].includes(host), `${f}: ${m[0]}`)
    }
  }
})

test('demo server เสิร์ฟเฉพาะโฟลเดอร์ที่เดโมใช้', async () => {
  const srv = await listen(demoServer())
  try {
    const get = (p: string) => fetch(srv.base + p, { redirect: 'manual' })
    assert.equal((await get('/')).status, 302)
    assert.equal((await get('/demo/')).status, 200)
    assert.equal((await get('/public/app/main.js')).status, 200)
    assert.equal((await get('/src/domain/parse.js')).status, 200)
    assert.equal((await get('/test/fixtures/synthetic/slip-settle.png')).headers.get('content-type'), 'image/png')
    for (const p of ['/package.json', '/src/config.ts', '/src/db/repo.ts', '/demo/../package.json', '/.env.example', '/scripts/check.ts'])
      assert.equal((await get(p)).status, 404, p)
  } finally {
    await srv.close()
  }
})
