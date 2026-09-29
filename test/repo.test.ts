import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { loadConfig } from '../src/config.ts'

const ROOT = resolve(import.meta.dirname, '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

test('CI: GitHub runner (ไม่ self-hosted) · Node 22 · npm ci → npm test → npm run check', () => {
  const y = read('.github/workflows/ci.yml')
  assert.ok(!/\t/.test(y), 'YAML ห้ามมี tab')
  assert.match(y, /^\s+runs-on: ubuntu-latest$/m)
  assert.ok(!/self-hosted/.test(y))
  assert.match(y, /node-version: 22$/m)
  const runs = [...y.matchAll(/^\s+- run: (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(runs, ['node --version', 'npm ci', 'npm test', 'npm run check'])
  // indentation เป็นเลขคู่ทุกบรรทัด
  for (const l of y.split('\n')) assert.equal((l.match(/^ */)![0].length) % 2, 0, l)
})

test('ADR 001–005 มีครบ', () => {
  for (const f of ['001-line-first', '002-sqlite', '003-satang', '004-qr-before-ai', '005-no-docker']) {
    const t = read(`docs/decisions/${f}.md`)
    assert.match(t, /^# ADR 00\d/)
    for (const h of ['## บริบท', '## ตัดสินใจ', '## ผลที่ตามมา']) assert.ok(t.includes(h), `${f} ${h}`)
  }
})

test('README: ลิงก์ในรีโปมีไฟล์จริง · คำสั่ง npm มีจริง · มี mermaid + สูตร', () => {
  const r = read('README.md')
  for (const m of r.matchAll(/\]\((?!https?:)([^)#]+)\)/g)) assert.ok(existsSync(join(ROOT, m[1])), m[1])
  const scripts = Object.keys(JSON.parse(read('package.json')).scripts)
  for (const m of r.matchAll(/npm run (?:-s )?([\w:-]+)/g)) assert.ok(scripts.includes(m[1]), m[1])
  assert.match(r, /```mermaid/)
  assert.match(r, /฿347\.50/)
  assert.match(r, /N = Σ/)
})

test('SETUP-CREDENTIALS ครอบคลุมทุกค่าที่โหมดจริงต้องใช้', () => {
  const s = read('docs/SETUP-CREDENTIALS.md')
  let missing = ''
  try {
    loadConfig({ HARNKAN_ENV: '/nonexistent', FAKE_LINE: '0', FAKE_AI: '0' })
  } catch (e) {
    missing = (e as Error).message
  }
  const required = missing.replace(/^.*?: /, '').replace(/ \(.*$/, '').split(', ')
  assert.ok(required.length >= 4, missing)
  for (const k of [...required, 'LIFF_ID', 'FAKE_LINE', 'FAKE_AI']) assert.ok(s.includes(k), k)
  for (const h of ['Messaging API', 'Webhook', 'LIFF', 'Anthropic', 'พร้อมเพย์', '~/.config/harnkan/.env']) assert.ok(s.includes(h), h)
  const env = read('.env.example')
  for (const k of required) assert.match(env, new RegExp(`^${k}=`, 'm'))
  assert.ok(existsSync(join(ROOT, dirname('docs/DEPLOY.md'), 'DEPLOY.md')))
})
