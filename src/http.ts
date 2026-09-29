import type { IncomingMessage, ServerResponse } from 'node:http'

export class HttpError extends Error {
  status: number
  field: string | undefined
  /** field: ชื่อช่องที่ผิด (ให้หน้าแอปแสดง error ใต้ช่องนั้น) */
  constructor(status: number, message: string, field?: string) {
    super(message)
    this.status = status
    this.field = field
  }
}

export async function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    if (size > max) throw new HttpError(413, 'body ใหญ่เกิน')
    chunks.push(c as Buffer)
  }
  return Buffer.concat(chunks)
}

import { BASE_HEADERS } from './security.ts'

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const isBuf = Buffer.isBuffer(body)
  res.writeHead(status, { ...BASE_HEADERS, 'content-type': isBuf ? 'application/octet-stream' : 'application/json; charset=utf-8', ...headers })
  res.end(isBuf ? body : JSON.stringify(body))
}
