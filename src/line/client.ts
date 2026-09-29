import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type Message = Record<string, unknown> & { type: string }
export type Profile = { displayName: string }

export interface LineClient {
  reply(replyToken: string, messages: Message[]): Promise<void>
  push(to: string, messages: Message[]): Promise<string | null>
  getContent(messageId: string): Promise<Buffer>
  getGroupMemberProfile(groupId: string, userId: string): Promise<Profile>
}

const API = 'https://api.line.me/v2/bot'
const DATA_API = 'https://api-data.line.me/v2/bot'

/** เรียก Messaging API ตรงด้วย fetch (ไม่ใช้ SDK) */
export class RealLineClient implements LineClient {
  token: string
  constructor(token: string) {
    this.token = token
  }
  private async call(url: string, init: RequestInit = {}) {
    const res = await fetch(url, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json', ...(init.headers as Record<string, string>) },
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`LINE API ${res.status} ${url.replace(/\/[^/]*$/, '/…')}: ${(await res.text()).slice(0, 200)}`)
    return res
  }
  async reply(replyToken: string, messages: Message[]) {
    await this.call(`${API}/message/reply`, { method: 'POST', body: JSON.stringify({ replyToken, messages }) })
  }
  async push(to: string, messages: Message[]) {
    const res = await this.call(`${API}/message/push`, { method: 'POST', body: JSON.stringify({ to, messages }) })
    const j = (await res.json()) as { sentMessages?: { id: string }[] }
    return j.sentMessages?.[0]?.id ?? null
  }
  async getContent(messageId: string) {
    const res = await this.call(`${DATA_API}/message/${encodeURIComponent(messageId)}/content`)
    return Buffer.from(await res.arrayBuffer())
  }
  async getGroupMemberProfile(groupId: string, userId: string) {
    const res = await this.call(`${API}/group/${encodeURIComponent(groupId)}/member/${encodeURIComponent(userId)}`)
    return (await res.json()) as Profile
  }
}

export type OutboxItem = { kind: 'reply' | 'push'; to: string; messages: Message[] }

/** ไม่เรียก LINE จริง เก็บข้อความที่จะส่งไว้ใน outbox */
export class FakeLineClient implements LineClient {
  outbox: OutboxItem[] = []
  /** นับตลอดอายุ (take() ไม่ล้าง) — ใช้เทสต์ว่าการใช้งานปกติไม่เพิ่มจำนวน push */
  sent = { reply: 0, push: 0 }
  profiles = new Map<string, string>([['U_fake_a', 'เอ'], ['U_fake_b', 'บี']])
  contents = new Map<string, Buffer>()
  fixtureDir: string
  outboxFile: string | null
  private seq = 0
  /** outboxFile: เขียนข้อความที่จะส่งต่อท้ายไฟล์ jsonl ด้วย (โหมด dev/job) */
  constructor(fixtureDir = join(import.meta.dirname, '../../test/fixtures/synthetic'), outboxFile: string | null = null) {
    this.fixtureDir = fixtureDir
    this.outboxFile = outboxFile
  }
  private record(item: OutboxItem) {
    this.outbox.push(item)
    this.sent[item.kind]++
    if (this.outboxFile) {
      mkdirSync(dirname(this.outboxFile), { recursive: true })
      appendFileSync(this.outboxFile, JSON.stringify({ at: new Date().toISOString(), ...item }) + '\n')
    }
  }
  async reply(replyToken: string, messages: Message[]) {
    this.record({ kind: 'reply', to: replyToken, messages })
  }
  async push(to: string, messages: Message[]) {
    this.record({ kind: 'push', to, messages })
    return `fake_msg_${++this.seq}`
  }
  async getContent(messageId: string) {
    const b = this.contents.get(messageId)
    if (b) return b
    const f = join(this.fixtureDir, `${messageId.replace(/[^\w-]/g, '')}.png`)
    if (existsSync(f)) return readFileSync(f)
    throw new Error(`fake content ไม่มี: ${messageId}`)
  }
  async getGroupMemberProfile(_groupId: string, userId: string) {
    return { displayName: this.profiles.get(userId) ?? 'ไม่ทราบชื่อ' }
  }
  /** ข้อความทั้งหมดใน outbox เป็นข้อความเดียว (สำหรับ assert) */
  texts(): string[] {
    return this.outbox.map((o) => JSON.stringify(o.messages))
  }
  take(): OutboxItem[] {
    const o = this.outbox
    this.outbox = []
    return o
  }
}
