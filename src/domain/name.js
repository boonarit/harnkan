// @ts-check
// กฎชื่อที่แสดง — ใช้ร่วมกันทั้งแชท ("ตั้งชื่อ …"), API และเดโม
import { PARSER_WORDS } from './parse.js'

export const NAME_MAX = 40

/**
 * ตัดข้อความตาม code point (slice ของ string ผ่ากลางอีโมจิได้) · tail = ต่อท้ายเมื่อถูกตัด (นับรวมใน n)
 * @param {string} s @param {number} n @param {string} [tail]
 */
export function clip(s, n, tail = '') {
  const cp = [...s]
  return cp.length <= n ? s : cp.slice(0, Math.max(0, n - [...tail].length)).join('') + tail
}

/** @param {unknown} s */
export function normalizeName(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim()
}

/**
 * @param {unknown} raw ชื่อใหม่
 * @param {string[]} others ชื่อของอีกคนในคู่
 * @returns {{ ok: true, name: string } | { ok: false, error: string }}
 */
export function validateName(raw, others = []) {
  const name = normalizeName(raw)
  if (!name) return { ok: false, error: 'ชื่อต้องไม่ว่าง' }
  if ([...name].length > NAME_MAX) return { ok: false, error: `ชื่อยาวได้ไม่เกิน ${NAME_MAX} ตัว` }
  if (/[\d๐-๙]/.test(name)) return { ok: false, error: 'ชื่อห้ามมีตัวเลข (บอทใช้ตัวเลขเป็นยอดเงิน)' }
  // คำสั่งและหน่วยเงินที่เป็นคำ: ห้ามเป็นชื่อทั้งคำ · marker และสัญลักษณ์: ห้ามอยู่ส่วนไหนของชื่อ
  for (const w of [...PARSER_WORDS.commands, ...PARSER_WORDS.currency]) {
    if (name === w) return { ok: false, error: `ชื่อห้ามเป็นคำว่า "${w}" (บอทใช้คำนี้)` }
  }
  for (const w of [...PARSER_WORDS.markers, ...PARSER_WORDS.currency.filter((c) => !/\p{L}/u.test(c))]) {
    if (name.includes(w)) return { ok: false, error: `ชื่อห้ามมีคำว่า "${w}" (บอทใช้คำนี้)` }
  }
  if (others.some((o) => normalizeName(o).toLowerCase() === name.toLowerCase())) return { ok: false, error: 'ชื่อซ้ำกับอีกคนในคู่' }
  return { ok: true, name }
}
