// ตรวจความลับ + ข้อมูลส่วนตัว + API นอก Node 22 ในไฟล์ที่ git ติดตาม (และไฟล์ใหม่ที่ยังไม่ ignore)
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Rule = { name: string; re: RegExp; allow?: (m: string) => boolean; only?: RegExp }

// ต่อสตริงไว้ไม่ให้ไฟล์นี้จับตัวเอง
const PK = '-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'
const rules: Rule[] = [
  { name: 'Anthropic API key', re: new RegExp('sk-' + 'ant-[A-Za-z0-9_-]{20,}') },
  { name: 'private key', re: new RegExp(PK) },
  { name: 'LINE user/group ID จริง', re: /\b[UCR][0-9a-f]{32}\b/ },
  { name: 'secret 32 hex (channel secret)', re: /(?<![0-9a-zA-Z])[0-9a-f]{32}(?![0-9a-zA-Z])/ },
  { name: 'token ยาว', re: /[A-Za-z0-9+/_=-]{120,}/ },
  { name: 'ค่า secret ใน env', re: /^(LINE_CHANNEL_SECRET|LINE_CHANNEL_ACCESS_TOKEN|ANTHROPIC_API_KEY)=\S+/m },
  {
    name: 'เบอร์โทร/พร้อมเพย์ไทย',
    re: /(?<![\w.])0[689]\d[- ]?\d{3}[- ]?\d{4}(?![\w])/g,
    allow: (m) => /^08000000\d\d$/.test(m.replace(/[- ]/g, '')),
  },
  { name: 'เลขบัญชีธนาคาร', re: /(?<![\w.])\d{3}-\d-\d{5}-\d(?![\w])/ },
  { name: 'เลขบัตรประชาชน', re: /(?<![\w.])\d-\d{4}-\d{5}-\d{2}-\d(?![\w])/ },
  // Node 22 compat: API ที่มีเฉพาะ Node ≥23 (ตรวจเฉพาะโค้ด)
  { name: 'API นอก Node 22', re: /\b(sqlite\.backup|stripTypeScriptTypes|process\.features\.typescript|URLPattern|fs\.glob\b|getCallSites|registerHooks)\b/, only: /\.(ts|js|mjs)$/ },
  { name: 'syntax ที่ strip ไม่ได้ (enum/namespace)', re: /^\s*(export\s+)?(const\s+)?(enum|namespace)\s+\w+\s*\{/m, only: /\.ts$/ },
]

const IMAGE = /\.(png|jpe?g|gif|webp|heic|bmp|tiff?)$/i
const SKIP = /^(package-lock\.json|scripts\/check\.ts|test\/check\.test\.ts)$/

export function scanText(path: string, text: string): string[] {
  const out: string[] = []
  for (const r of rules) {
    if (r.only && !r.only.test(path)) continue
    const re = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g')
    for (const m of text.matchAll(re)) {
      if (r.allow?.(m[0])) continue
      const line = text.slice(0, m.index).split('\n').length
      out.push(`${path}:${line} ${r.name}`)
      break
    }
  }
  return out
}

// คำต้องห้ามส่วนตัว (ชื่อเจ้าของ ฯลฯ) อยู่นอกรีโปเท่านั้น — ห้ามเขียนคำจริงลงโค้ด/เทสต์
export const PRIVATE_WORDS_FILE = join(homedir(), '.config/harnkan/private-words.txt')

/** บรรทัดละคำ ข้ามบรรทัดว่างและ # · ไม่มีไฟล์ = null */
export function loadPrivateWords(path: string): string[] | null {
  if (!existsSync(path)) return null
  return readFileSync(path, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
}

/** หาคำแบบไม่สนตัวพิมพ์ · รายงานเป็นลำดับคำ (#1, #2) ไม่พิมพ์คำจริงออก log */
export function scanWords(path: string, text: string, words: string[]): string[] {
  const out: string[] = []
  const lines = text.toLowerCase().split('\n')
  words.forEach((w, i) => {
    const lw = w.toLowerCase()
    const at = lines.findIndex((l) => l.includes(lw))
    if (at >= 0) out.push(`${path}:${at + 1} คำต้องห้ามส่วนตัว #${i + 1}`)
  })
  return out
}

export function checkFiles(files: string[], read: (f: string) => string, words: string[] = []): string[] {
  const problems: string[] = []
  for (const f of files) {
    if (IMAGE.test(f)) {
      if (!f.startsWith('test/fixtures/synthetic/')) problems.push(`${f} รูปนอก test/fixtures/synthetic/`)
      continue
    }
    if (/(^|\/)\.env$|(^|\/)\.env\.(?!example$)/.test(f)) problems.push(`${f} ไฟล์ env ห้าม commit`)
    const text = read(f)
    if (words.length) problems.push(...scanWords(f, text, words))
    if (SKIP.test(f)) continue
    problems.push(...scanText(f, text))
  }
  return problems
}

if (import.meta.main ?? process.argv[1]?.endsWith('check.ts')) {
  const git = (args: string[]) => execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean)
  const files = [...new Set([...git(['ls-files']), ...git(['ls-files', '--others', '--exclude-standard'])])].filter((f) => {
    try { return statSync(f).isFile() } catch { return false }
  })
  const wordsFile = process.env.HARNKAN_PRIVATE_WORDS || PRIVATE_WORDS_FILE
  const words = loadPrivateWords(wordsFile)
  if (!words) console.log(`ข้ามตรวจคำต้องห้ามส่วนตัว: ไม่มีไฟล์ ${wordsFile.replace(homedir(), '~')}`)
  const problems = checkFiles(files, (f) => readFileSync(f, 'utf8'), words ?? [])
  if (problems.length) {
    console.error('✗ check ไม่ผ่าน:\n' + problems.map((p) => '  ' + p).join('\n'))
    process.exit(1)
  }
  console.log(`✓ check ผ่าน (${files.length} ไฟล์${words ? ` · คำต้องห้ามส่วนตัว ${words.length} คำ` : ''})`)
}
