import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig } from '../src/config.ts'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const deploy = readdirSync(join(ROOT, 'deploy'))

test('launchd plist: label ตรงชื่อไฟล์ · ค่าเป็น placeholder · ครบ 4 งาน', () => {
  const plists = deploy.filter((f) => f.endsWith('.plist')).sort()
  assert.deepEqual(plists, ['com.harnkan.backup.plist', 'com.harnkan.bot.plist', 'com.harnkan.retention.plist', 'com.harnkan.summary.plist', 'com.harnkan.tunnel.plist'])
  for (const f of plists.filter((f) => f !== 'com.harnkan.tunnel.plist')) {
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

/** sandbox: HOME ปลอม + origin เป็น git จริง + stub npm/launchctl/curl/sleep ที่จดทุกคำสั่งลง calls.log */
function updateSandbox(opts: { backupFails?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'harnkan-upd-'))
  const g = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=fake', '-c', 'user.email=fake@example.com', ...a], { cwd, stdio: 'pipe' }).toString().trim()
  const work = join(home, 'work')
  mkdirSync(join(work, 'deploy'), { recursive: true })
  const v1 = read('deploy/update.sh')
  writeFileSync(join(work, 'deploy/update.sh'), v1)
  g(work, 'init', '-q', '-b', 'main')
  g(work, 'add', '.')
  g(work, 'commit', '-qm', 'v1')
  const c1 = g(work, 'rev-parse', 'HEAD')
  g(home, 'clone', '-q', '--bare', work, join(home, 'origin.git'))
  mkdirSync(join(home, 'services'))
  g(home, 'clone', '-q', join(home, 'origin.git'), join(home, 'services/harnkan'))
  // รุ่นถัดไปเพิ่มขั้นใหม่หลัง npm ci
  const v2 = v1.replace('  npm ci --omit=dev\n', '  npm ci --omit=dev\n  echo "NEW_STEP_V2" >> "$HOME/calls.log"\n')
  assert.notEqual(v1, v2)
  writeFileSync(join(work, 'deploy/update.sh'), v2)
  g(work, 'commit', '-qam', 'v2')
  g(work, 'push', '-q', join(home, 'origin.git'), 'main')
  const c2 = g(work, 'rev-parse', 'HEAD')
  mkdirSync(join(home, 'data/harnkan'), { recursive: true })
  const bin = join(home, 'bin')
  mkdirSync(bin)
  for (const c of ['npm', 'launchctl', 'curl', 'sleep']) {
    const fail = c === 'npm' && opts.backupFails ? 'case "$*" in *job:backup*) exit 1;; esac\n' : ''
    writeFileSync(join(bin, c), `#!/bin/bash\necho "${c} $*" >> "$HOME/calls.log"\n${fail}`)
    chmodSync(join(bin, c), 0o755)
  }
  const r = spawnSync('bash', [join(home, 'services/harnkan/deploy/update.sh')], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, HARNKAN_UPDATE_REEXEC: '' }, encoding: 'utf8', timeout: 30_000, killSignal: 'SIGKILL' })
  let calls: string[] = []
  try { calls = readFileSync(join(home, 'calls.log'), 'utf8').trim().split('\n') } catch { /* ไม่มีคำสั่งไหนถูกเรียก */ }
  return { r, calls, c1, c2, head: g(join(home, 'services/harnkan'), 'rev-parse', 'HEAD'), home }
}

test('update.sh (B18): สำรองก่อน git pull · exec รุ่นใหม่ครั้งเดียว ขั้นที่เพิ่มในรุ่นใหม่ถูกรันในรอบเดียวกัน · สำรองก่อน migrate เสมอ', () => {
  const { r, calls, c1, c2, head, home } = updateSandbox()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(head, c2)
  assert.equal(readFileSync(join(home, 'data/harnkan/last-good-commit'), 'utf8').trim(), c1)
  assert.ok(calls.includes('NEW_STEP_V2'), `ขั้นใหม่ไม่ถูกรัน: ${calls.join(' | ')}`)
  const at = (s: string) => calls.findIndex((c) => c.includes(s))
  assert.equal(calls.filter((c) => c.includes('job:backup')).length, 1, 'สำรองครั้งเดียว (exec ไม่วน)')
  assert.ok(at('job:backup') < at('npm ci') && at('npm ci') < at('NEW_STEP_V2') && at('NEW_STEP_V2') < at('migrate') && at('migrate') < at('launchctl'), calls.join(' | '))
  assert.match(r.stdout, /สำรอง DB ก่อน git pull/)
})

test('update.sh (B18): สำรองล้ม → หยุด ไม่ pull ไม่ migrate', () => {
  const { r, calls, c1, head } = updateSandbox({ backupFails: true })
  assert.notEqual(r.status, 0)
  assert.equal(head, c1)
  assert.ok(!calls.some((c) => c.includes('migrate') || c.includes('npm ci')), calls.join(' | '))
})

test('cloudflared (B18-9): plist tunnel ใช้ config แยก + UUID · template ใช้ 127.0.0.1 · เอกสาร: ทุกคำสั่ง cloudflared มี --config · ไม่มี service install · ใช้ HK_HOST ไม่ใช่ HOST', () => {
  const p = read('deploy/com.harnkan.tunnel.plist')
  assert.match(p, /<key>Label<\/key><string>com\.harnkan\.tunnel<\/string>/)
  assert.match(p, /<string>__CLOUDFLARED__<\/string>\s*<string>tunnel<\/string>\s*<string>--config<\/string>\s*<string>__HOME__\/\.cloudflared\/harnkan-config\.yml<\/string>\s*<string>run<\/string>\s*<string>__TUNNEL_UUID__<\/string>/)
  assert.match(p, /<key>KeepAlive<\/key><true\/>/)
  assert.ok(!/\/Users\/|\/home\//.test(p))
  assert.equal((p.match(/<dict>/g) ?? []).length, (p.match(/<\/dict>/g) ?? []).length)
  const yml = read('deploy/cloudflared-harnkan.example.yml')
  assert.ok(!/^[^#]*localhost/m.test(yml), 'ingress ต้องใช้ 127.0.0.1')
  assert.match(yml, /service: http:\/\/127\.0\.0\.1:8787/)
  const path = new RegExp(yml.match(/path: (\S+)/)![1])
  for (const ok of ['/webhook', '/healthz', '/app/', '/api/me', '/qr/x.png', '/domain/money.js']) assert.ok(path.test(ok), ok)
  for (const no of ['/', '/package.json', '/webhookx', '/.env']) assert.ok(!path.test(no), no)
  const cmds = shellLines().filter(([, l]) => /^\s*(sudo\s+)?cloudflared\s/.test(l))
  assert.ok(cmds.length >= 5)
  for (const [f, l] of cmds) assert.match(l, /--config ~\/\.cloudflared\/harnkan-config\.yml/, `${f}: ${l}`)
  const route = cmds.filter(([, l]) => l.includes('route dns'))
  assert.ok(route.length && route.every(([, l]) => l.includes('--overwrite-dns "$HK_UUID"')))
  const docs = readdirSync(join(ROOT, 'docs')).filter((f) => f.endsWith('.md')).map((f) => read(`docs/${f}`)).join('\n')
  const shDocs = shellLines().filter(([f]) => f.endsWith('.md')).map(([, l]) => l)
  assert.ok(!shDocs.some((l) => /service install/.test(l)), 'ห้ามคำสั่ง service install')
  assert.ok(!shDocs.some((l) => /(^|[\s;])HOST=|\$HOST\b|\$\{HOST\}/.test(l)), 'zsh: ใช้ HK_HOST')
  assert.match(docs, /LINE บน Mac เปิดแอปใน Chrome/)
  assert.match(docs, /mini app ในมือถือยังเป็นหน้าเก่า/)
})
