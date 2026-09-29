import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export type Config = {
  fakeLine: boolean
  fakeAi: boolean
  dataDir: string
  backupDir: string
  backupKeep: number
  slipRetentionDays: number
  host: string
  port: number
  publicBaseUrl: string
  lineChannelSecret: string
  lineChannelAccessToken: string
  liffChannelId: string
  liffId: string
  anthropicApiKey: string
  slipModel: string
  aiDailyCap: number
  minTransfer: number
}

// อ่านไฟล์ .env แบบง่าย (KEY=VALUE, # comment) — ไม่ทับค่าที่ตั้งไว้ใน process.env แล้ว
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

const bool = (v: string | undefined, d: boolean) => (v === undefined || v === '' ? d : v === '1' || v === 'true')
const int = (v: string | undefined, d: number) => (v ? Number.parseInt(v, 10) : d)
/** "~/data/harnkan" → path เต็ม (launchd ไม่ขยาย ~ ให้) */
const path = (v: string) => resolve(v.replace(/^~(?=\/|$)/, homedir()))

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const envPath = (env.HARNKAN_ENV || join(homedir(), '.config/harnkan/.env')).replace(/^~(?=\/)/, homedir())
  const file = existsSync(envPath) ? parseEnvFile(readFileSync(envPath, 'utf8')) : {}
  const get = (k: string) => env[k] ?? file[k]

  // ไม่มีไฟล์ env และไม่ได้ตั้งค่า → โหมด fake
  const fakeLine = bool(get('FAKE_LINE'), true)
  const fakeAi = bool(get('FAKE_AI'), true)
  const dataDir = path(get('DATA_DIR') || './.data')
  const cfg: Config = {
    fakeLine,
    fakeAi,
    dataDir,
    backupDir: path(get('BACKUP_DIR') || join(dataDir, 'backups')),
    backupKeep: int(get('BACKUP_KEEP'), 7),
    slipRetentionDays: int(get('SLIP_RETENTION_DAYS'), 365),
    host: get('HOST') || '127.0.0.1',
    port: int(get('PORT'), 8787),
    publicBaseUrl: (get('PUBLIC_BASE_URL') || 'http://127.0.0.1:8787').replace(/\/$/, ''),
    lineChannelSecret: get('LINE_CHANNEL_SECRET') || (fakeLine ? 'fake_channel_secret' : ''),
    lineChannelAccessToken: get('LINE_CHANNEL_ACCESS_TOKEN') || '',
    liffChannelId: get('LIFF_CHANNEL_ID') || '',
    liffId: get('LIFF_ID') || '',
    anthropicApiKey: get('ANTHROPIC_API_KEY') || '',
    slipModel: get('SLIP_MODEL') || 'claude-haiku-4-5',
    aiDailyCap: int(get('AI_DAILY_CAP'), 30),
    minTransfer: int(get('MIN_TRANSFER'), 5000),
  }

  const missing: string[] = []
  if (!fakeLine) {
    for (const k of ['LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN', 'LIFF_CHANNEL_ID', 'PUBLIC_BASE_URL']) if (!get(k)) missing.push(k)
  }
  if (!fakeAi && !get('ANTHROPIC_API_KEY')) missing.push('ANTHROPIC_API_KEY')
  if (missing.length) throw new Error(`ขาดค่า env: ${missing.join(', ')} (ดู docs/SETUP-CREDENTIALS.md)`)
  return cfg
}
