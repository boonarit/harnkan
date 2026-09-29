import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from '../src/config.ts'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const deploy = readdirSync(join(ROOT, 'deploy'))

test('launchd plist: label ตรงชื่อไฟล์ · ค่าเป็น placeholder · ครบ 4 งาน', () => {
  const plists = deploy.filter((f) => f.endsWith('.plist')).sort()
  assert.deepEqual(plists, ['com.harnkan.backup.plist', 'com.harnkan.bot.plist', 'com.harnkan.retention.plist', 'com.harnkan.summary.plist'])
  for (const f of plists) {
    const x = read(`deploy/${f}`)
    assert.match(x, new RegExp(`<key>Label</key><string>${f.replace('.plist', '').replace(/\./g, '\\.')}</string>`))
    assert.match(x, /__HOME__/)
    assert.match(x, /<string>__NODE__<\/string>/)
    assert.ok(!/\/Users\/|\/home\//.test(x), `${f} มี path จริง`)
    assert.equal((x.match(/<dict>/g) ?? []).length, (x.match(/<\/dict>/g) ?? []).length)
  }
  assert.match(read('deploy/com.harnkan.summary.plist'), /<key>Hour<\/key><integer>21<\/integer><key>Minute<\/key><integer>0<\/integer>/)
  assert.match(read('deploy/com.harnkan.backup.plist'), /<key>Hour<\/key><integer>4<\/integer>/)
  assert.match(read('deploy/com.harnkan.retention.plist'), /<key>Weekday<\/key>/)
  assert.match(read('deploy/com.harnkan.bot.plist'), /<key>KeepAlive<\/key><true\/>/)
})

/** บรรทัดคำสั่ง shell จากสคริปต์ และจากบล็อก ```sh ใน docs */
function shellLines() {
  const out: [string, string][] = []
  for (const f of deploy.filter((f) => f.endsWith('.sh'))) for (const l of read(`deploy/${f}`).split('\n')) if (l.trim() && !l.trim().startsWith('#')) out.push([f, l])
  for (const f of readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md'))) {
    const blocks = read(`docs/${f}`).match(/```(?:sh|bash|zsh)\n[\s\S]*?```/g) ?? []
    for (const b of blocks) for (const l of b.split('\n').slice(1, -1)) if (l.trim()) out.push([f, l])
  }
  return out
}

test('สคริปต์/เอกสาร: ไม่กลืน error ด้วย 2>/dev/null · ไม่มีคอมเมนต์ท้ายบรรทัดคำสั่ง', () => {
  const lines = shellLines()
  assert.ok(lines.length > 20)
  for (const [f, l] of lines) {
    assert.ok(!l.includes('2>/dev/null') && !l.includes('&>/dev/null'), `${f}: ${l}`)
    const unquoted = l.replace(/"[^"]*"|'[^']*'/g, '""')
    assert.ok(!/\S\s+#/.test(unquoted), `${f} คอมเมนต์ท้ายบรรทัด: ${l}`)
  }
  for (const [k, v] of Object.entries(JSON.parse(read('package.json')).scripts as Record<string, string>)) assert.ok(!v.includes('/dev/null') || v.includes('HARNKAN_ENV=/dev/null'), k)
})

test('update.sh: syntax ถูก · set -euo pipefail · จด commit ก่อนอัปเดต · DEPLOY.md มี unload และ rollback', () => {
  execFileSync('bash', ['-n', join(ROOT, 'deploy/update.sh')])
  const u = read('deploy/update.sh')
  assert.match(u, /set -euo pipefail/)
  assert.match(u, /last-good-commit/)
  assert.match(u, /npm run -s migrate/)
  const d = read('docs/DEPLOY.md')
  assert.match(d, /## 7\. ปิดระบบชั่วคราว/)
  assert.match(d, /launchctl bootout/)
  assert.match(d, /## 8\. Rollback/)
  assert.match(d, /last-good-commit/)
  assert.match(d, /gunzip -c/)
})

test('config: ~ ใน DATA_DIR / BACKUP_DIR ขยายเป็น home (launchd ไม่ขยายให้)', () => {
  const c = loadConfig({ HARNKAN_ENV: '/nonexistent', DATA_DIR: '~/data/harnkan', BACKUP_DIR: '~/backups/harnkan' })
  assert.equal(c.dataDir, join(homedir(), 'data/harnkan'))
  assert.equal(c.backupDir, join(homedir(), 'backups/harnkan'))
})
