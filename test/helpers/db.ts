import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from '../../src/db/schema.ts'
import { Repo } from '../../src/db/repo.ts'

export const A_ID = 'U_fake_a'
export const B_ID = 'U_fake_b'
export const GROUP = 'C_fake_group'

export function tmpDir(prefix = 'harnkan-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** DB ชั่วคราวใน tmpdir พร้อมคู่ เอ & บี */
export function seeded() {
  const dir = tmpDir()
  const repo = new Repo(openDb(join(dir, 'harnkan.db')))
  const couple = repo.createCouple(GROUP)
  const a = repo.addMember(couple.id, A_ID, 'เอ')
  const b = repo.addMember(couple.id, B_ID, 'บี')
  return { dir, repo, couple, a, b }
}
