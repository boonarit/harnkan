import { join } from 'node:path'
import { loadConfig, type Config } from './config.ts'
import { Repo } from './db/repo.ts'
import { openDb } from './db/schema.ts'
import { FakeLineClient, RealLineClient, type LineClient } from './line/client.ts'
import { FakeIdTokenVerifier, LineIdTokenVerifier, type IdTokenVerifier } from './api/auth.ts'
import { initLog } from './log.ts'
import { ClaudeSlipReader, FakeSlipReader, GeminiSlipReader, type SlipReader } from './slip/vision.ts'

/** ทุกอย่างที่ handler ต้องใช้ ส่งผ่านตัวเดียว (เทสต์สร้างแบบ fake ได้ง่าย) */
export type Ctx = {
  cfg: Config
  repo: Repo
  line: LineClient
  slips: SlipReader
  verifier: IdTokenVerifier
  now: () => number
}

/** สร้าง Ctx จาก env (server และ jobs ใช้ร่วมกัน) */
export function bootstrap(): Ctx {
  const cfg = loadConfig()
  initLog(join(cfg.dataDir, 'logs'))
  const repo = new Repo(openDb(join(cfg.dataDir, 'harnkan.db')))
  const line = cfg.fakeLine ? new FakeLineClient(undefined, join(cfg.dataDir, 'fake-outbox.jsonl')) : new RealLineClient(cfg.lineChannelAccessToken)
  const slips = cfg.fakeAi ? new FakeSlipReader()
    : cfg.aiProvider === 'claude' ? new ClaudeSlipReader(cfg.anthropicApiKey, cfg.slipModel)
    : new GeminiSlipReader(cfg.geminiApiKey, cfg.slipModel)
  const verifier = cfg.fakeLine ? new FakeIdTokenVerifier() : new LineIdTokenVerifier(cfg.liffChannelId)
  return { cfg, repo, line, slips, verifier, now: Date.now }
}
