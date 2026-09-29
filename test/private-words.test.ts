// คำต้องห้ามส่วนตัว: เทสต์ใช้คำสมมติเท่านั้น (ห้ามใส่คำจริงในรีโป)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { checkFiles, loadPrivateWords, scanWords } from '../scripts/check.ts'
import { tmpDir } from './helpers/db.ts'

const ROOT = resolve(import.meta.dirname, '..')
const FAKE = ['Zorblax', 'นกฮูกม่วง']

test('loadPrivateWords: บรรทัดละคำ ข้ามบรรทัดว่าง/# · ไม่มีไฟล์ = null', () => {
  const f = join(tmpDir(), 'words.txt')
  writeFileSync(f, `${FAKE[0]}\n\n# comment\n  ${FAKE[1]}  \n`)
  assert.deepEqual(loadPrivateWords(f), FAKE)
  assert.equal(loadPrivateWords(join(tmpDir(), 'missing.txt')), null)
})

test('scanWords: เจอแบบไม่สนตัวพิมพ์ · ไม่พิมพ์คำออกมาใน output', () => {
  const p = scanWords('a.md', 'line1\nhello zORBLAX there\nนกฮูกม่วงบินได้', FAKE)
  assert.deepEqual(p, ['a.md:2 คำต้องห้ามส่วนตัว #1', 'a.md:3 คำต้องห้ามส่วนตัว #2'])
  assert.ok(!p.join().toLowerCase().includes('zorblax'))
  assert.deepEqual(scanWords('a.md', 'clean text', FAKE), [])
})

test('checkFiles ตรวจคำต้องห้ามทุกไฟล์ข้อความ รวมไฟล์ที่ข้าม pattern ความลับ', () => {
  const files = ['package-lock.json', 'scripts/check.ts', 'docs/x.md']
  const p = checkFiles(files, (f) => (f === 'docs/x.md' ? 'ok' : `"name": "zorblax"`), FAKE)
  assert.deepEqual(p, ['package-lock.json:1 คำต้องห้ามส่วนตัว #1', 'scripts/check.ts:1 คำต้องห้ามส่วนตัว #1'])
})

function repoWith(content: string) {
  const dir = tmpDir('harnkan-check-')
  execFileSync('git', ['init', '-q', dir])
  mkdirSync(join(dir, 'docs'))
  writeFileSync(join(dir, 'docs/note.md'), content)
  return dir
}
const runCheck = (cwd: string, wordsFile: string) =>
  spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(ROOT, 'scripts/check.ts')], { cwd, env: { ...process.env, HARNKAN_PRIVATE_WORDS: wordsFile }, encoding: 'utf8' })

test('CLI: มีไฟล์คำ → เจอคำแล้ว exit 1 · สะอาด → exit 0', () => {
  const words = join(tmpDir(), 'w.txt')
  writeFileSync(words, FAKE.join('\n'))
  const bad = runCheck(repoWith('ผู้ดูแลชื่อ Zorblax'), words)
  assert.equal(bad.status, 1, bad.stdout + bad.stderr)
  assert.match(bad.stderr, /docs\/note\.md:1 คำต้องห้ามส่วนตัว #1/)
  assert.ok(!bad.stderr.includes('Zorblax'))
  const ok = runCheck(repoWith('ผู้ดูแล'), words)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.match(ok.stdout, /คำต้องห้ามส่วนตัว 2 คำ/)
})

test('CLI: ไม่มีไฟล์คำ (เช่น CI) → ข้ามพร้อมบอก ไม่ล้ม', () => {
  const r = runCheck(repoWith('Zorblax'), join(tmpDir(), 'missing.txt'))
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /ข้ามตรวจคำต้องห้ามส่วนตัว/)
})

test('.gitignore กัน CLAUDE.local.md · CLAUDE.md ไม่มีกฎส่วนตัว', async () => {
  const { readFileSync } = await import('node:fs')
  assert.match(readFileSync(join(ROOT, '.gitignore'), 'utf8'), /^CLAUDE\.local\.md$/m)
  const c = readFileSync(join(ROOT, 'CLAUDE.md'), 'utf8')
  for (const w of [/vault/i, /ssh/i, /\/Users\//, /openclaw/i, /ImpressMe/i, /AffiliateMe/i]) assert.ok(!w.test(c), String(w))
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
  assert.ok(!tracked.split('\n').includes('CLAUDE.local.md'))
})
