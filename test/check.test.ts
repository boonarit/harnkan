import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkFiles, scanText } from '../scripts/check.ts'
import { loadConfig, parseEnvFile } from '../src/config.ts'

test('check จับความลับและข้อมูลส่วนตัว', () => {
  const bad = [
    'key=' + 'sk-' + 'ant-api03-abcdefghijklmnopqrstuvwxyz',
    'uid U' + '1234567890abcdef1234567890abcdef',
    'secret: ' + 'abcdef0123456789abcdef0123456789',
    'โทร 081-234-5678',
    'บัญชี 123-4-56789-0',
  ]
  for (const s of bad) assert.ok(scanText('x.ts', s).length > 0, s)
})

test('check ปล่อยเบอร์ปลอมและ fixture สังเคราะห์', () => {
  assert.deepEqual(scanText('x.ts', 'พร้อมเพย์ 0800000001 และ 0800000002 ยอด 34750'), [])
  const files = ['test/fixtures/synthetic/a.png', 'docs/shot.png', '.env', '.env.example']
  const p = checkFiles(files, () => '')
  assert.deepEqual(p, ['docs/shot.png รูปนอก test/fixtures/synthetic/', '.env ไฟล์ env ห้าม commit'])
})

test('check จับ API นอก Node 22 และ enum', () => {
  assert.ok(scanText('a.ts', 'await sqlite.backup(db, p)').length)
  assert.ok(scanText('a.ts', 'enum X { A }').length)
  assert.deepEqual(scanText('a.md', 'enum X { A }'), [])
})

test('config: ไม่มีไฟล์ env → โหมด fake', () => {
  const c = loadConfig({ HARNKAN_ENV: '/nonexistent/.env' })
  assert.equal(c.fakeLine, true)
  assert.equal(c.fakeAi, true)
  assert.equal(c.minTransfer, 5000)
  assert.equal(c.host, '127.0.0.1')
})

test('config: โหมดจริงต้องมี credential', () => {
  assert.throws(() => loadConfig({ HARNKAN_ENV: '/nonexistent', FAKE_LINE: '0', FAKE_AI: '1' }), /LINE_CHANNEL_SECRET/)
  assert.throws(() => loadConfig({ HARNKAN_ENV: '/nonexistent', FAKE_LINE: '1', FAKE_AI: '0' }), /ANTHROPIC_API_KEY/)
  assert.deepEqual(parseEnvFile('# c\nA=1\nB="x y"\n'), { A: '1', B: 'x y' })
})
