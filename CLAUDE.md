# CLAUDE.md — harnkan (หารกัน)

LINE bot + mini app ที่ช่วยคนสองคนหารค่าใช้จ่ายรายวัน แล้วสรุปเป็นยอดโอนเดียวต่อวัน
ส่งสลิปหรือพิมพ์ "กาแฟ 90" ในกลุ่ม LINE → บอทบันทึก หารครึ่ง → 21:00 สรุปยอดเดียว + QR พร้อมเพย์ → ส่งสลิปโอนกลับ → ปิดยอด

แผนงานทั้งหมดอยู่ที่ `docs/PLAN.md` — อ่านก่อนเริ่มทุก batch

## กติกาที่ห้ามละเมิด (รีโปนี้จะเป็นสาธารณะ)

1. **ห้ามมีข้อมูลจริงในรีโป** — ไม่มีชื่อจริง เลขบัญชี เบอร์โทร สลิปจริง LINE user ID จริง ภาพหน้าจอที่มีข้อมูลจริง
   - ในโค้ด เทสต์ และ fixture ใช้คนสมมติ `เอ` กับ `บี` (ID `U_fake_a`, `U_fake_b`) และเบอร์พร้อมเพย์ปลอม `0800000001`, `0800000002`
   - สลิปตัวอย่างต้อง **สร้างขึ้นเองในเทสต์** (วาดรูป + QR ปลอม) ห้ามใช้สลิปจริง
2. **ห้าม commit ความลับ** — token, secret, API key อยู่ใน `~/.config/harnkan/.env` (นอกรีโป) เท่านั้น ในรีโปมีแค่ `.env.example`
3. **ข้อมูลรันไทม์อยู่นอกโค้ด** — ฐานข้อมูล รูปสลิป log อยู่ใต้ `DATA_DIR` (dev: `./.data/` ซึ่ง gitignore / prod: `~/data/harnkan`)
4. **รัน `npm run check` ก่อนทุก commit** ถ้าตรวจเจอความลับหรือข้อมูลส่วนตัว ห้าม commit ห้าม push
5. **ห้ามแตะอะไรนอกโฟลเดอร์รีโปนี้** (ยกเว้น `~/.config/harnkan/`) ห้ามแก้การตั้งค่าเครื่องหรือโปรเจกต์อื่น ห้ามคัดลอกโค้ดจากโปรเจกต์อื่น · ข้อยกเว้นเฉพาะเครื่องของผู้ดูแลอยู่ใน `CLAUDE.local.md` (ไม่ commit)
6. **ห้ามเดาค่า credential** ถ้าต้องใช้ของจริง ให้ทำ fake/adapter แล้วจดไว้ใน `docs/SETUP-CREDENTIALS.md`

## Stack

- **Node 22** เป็นเป้าหมาย (เครื่อง production ใช้ Node 22) → ห้ามใช้ API ที่มีเฉพาะ Node ≥23 · `package.json` ต้องมี `"engines": { "node": ">=22.6" }`
- TypeScript รันตรงด้วย `node --experimental-strip-types` (ไม่มีขั้น build) — ใช้เฉพาะ syntax ที่ strip ได้ (ห้าม `enum`, `namespace`, parameter properties) · import ต้องลงท้าย `.ts`
- ฐานข้อมูล `node:sqlite` (`--experimental-sqlite`) · HTTP ด้วย `node:http` · เทสต์ด้วย `node:test` + `node:assert`
- dependency ให้น้อยที่สุด อนุญาต: `promptparse` (QR สลิป + QR พร้อมเพย์), `qrcode` (วาด QR), `jsqr` + `jimp` (อ่าน QR จากรูป), `@anthropic-ai/sdk` (อ่านสลิป) — ถ้าจะเพิ่มตัวอื่นต้องจดเหตุผลใน report
- package manager: **npm** (ไม่ใช้ pnpm) · ไม่ใช้ Docker
- mini app: ไฟล์ static (HTML + CSS + ES modules ธรรมดา) เสิร์ฟจาก server เดียวกัน ไม่มี framework ไม่มี build
- เงินเก็บเป็น **สตางค์ (integer)** ทุกที่ ห้ามใช้ float กับเงิน

## Loop engineering: วิธีทำงานทีละ batch

ทำ batch ตามลำดับใน `docs/PLAN.md` แต่ละ batch วนแบบนี้:

1. อ่านหัวข้อ batch ใน PLAN (ขอบเขต + เกณฑ์ผ่าน)
2. เขียนเทสต์ของเกณฑ์ผ่านก่อน แล้วเขียนโค้ดจนผ่าน
3. รัน `npm test` และ `npm run check` ต้องเขียวทั้งคู่
4. เขียน report ของ batch (ที่เก็บ report อยู่ใน `CLAUDE.local.md`) + เพิ่ม 2–3 บรรทัดใน `docs/CHANGELOG.md` ของรีโป — รายละเอียดตาม "กฎ Loop Engineering เพิ่มเติม"
5. commit ข้อความรูปแบบ `feat(bXX): <สรุปภาษาไทย>` (หนึ่ง batch อาจหลาย commit ได้)
6. ถ้ามี remote `origin` แล้ว push ได้ (ต้องผ่าน `npm run check` ก่อน)
7. ไป batch ถัดไป

**ติดขัด:** ถ้า batch ไหนติดเกิน 3 รอบแก้ หรือต้องการการตัดสินใจจากผู้ดูแล → จดใน `docs/QUESTIONS.md` (ปัญหา · ทางเลือก · ที่แนะนำ) แล้วข้ามไปทำ batch ที่ไม่พึ่งเรื่องนั้น อย่าหยุดทั้งแผน

**ห้าม:** ข้ามเทสต์ · ปิดเทสต์ที่ล้ม · แก้เกณฑ์ผ่านให้ง่ายลงเอง · commit ตอนเทสต์แดง

## คำสั่ง

| คำสั่ง | ทำอะไร |
|---|---|
| `npm run dev` | รัน server โหมด fake (ไม่ต่อ LINE/AI จริง) ที่ `127.0.0.1:8787` |
| `npm test` | เทสต์ทั้งหมด (ต้องไม่ต่อเน็ต) |
| `npm run check` | ตรวจความลับ + ข้อมูลส่วนตัว + ตรวจว่าไม่ใช้ API นอก Node 22 |
| `npm run job:summary` | งานสรุปยอด 21:00 (launchd เรียก) |
| `npm run demo` | เสิร์ฟโหมดเดโม (ข้อมูลในเบราว์เซอร์ล้วน) |

## โหมดการทำงาน (env)

- `FAKE_LINE=1` — ไม่เรียก LINE API จริง บันทึกข้อความที่จะส่งไว้ในหน่วยความจำ/ไฟล์
- `FAKE_AI=1` — อ่านสลิปด้วยผลที่เตรียมไว้ ไม่เรียก Claude API
- dev และเทสต์ต้องเปิดทั้งสองค่าเสมอ ของจริงใช้หลังผู้ดูแลใส่ credential

## โครงโฟลเดอร์

```
src/
  domain/      money, split, balance, parse (pure functions ไม่มี I/O)
  db/          schema, migrations, repositories (node:sqlite)
  line/        client (จริง + fake), signature, webhook router, flex messages
  slip/        qr decode, vision (จริง + fake), classify
  promptpay/   สร้าง QR พร้อมเพย์ใส่ยอด
  api/         REST สำหรับ mini app (ตรวจ LIFF token)
  jobs/        summary, retention, backup
  server.ts    จุดเริ่ม http server
public/app/    mini app (static)
demo/          โหมดเดโม (static, deploy ขึ้น Cloudflare Pages ได้)
deploy/        template launchd / cloudflared / สคริปต์สำรอง (ไม่มีค่าจริง)
docs/          PLAN, CHANGELOG, decisions (ADR), SETUP-CREDENTIALS, DEPLOY, PRIVACY
test/          เทสต์ + fixture สังเคราะห์
```

## บริบทการ deploy

dev → push GitHub → เครื่อง production `git pull` → launchd `com.harnkan.*` + cloudflared (ขั้นตอนเต็มใน `docs/DEPLOY.md`)
โค้ด `~/services/harnkan` · ข้อมูล `~/data/harnkan` · สำรอง `~/backups/harnkan` · server bind `127.0.0.1` เท่านั้น

## กฎ Loop Engineering เพิ่มเติม (ผู้ดูแล, 2026-09-29)

1. หยุดกลางทางได้แค่ 3 กรณี: ข้อมูลจะหาย / ต้องใช้ credential จริงที่ fake แทนไม่ได้ / สมมติฐานใน PLAN ผิดจนงานที่เหลือไม่มีความหมาย · กรณีอื่นตัดสินเองแล้วเขียนเหตุผลลง report
2. ขั้น 0 ทุก batch (เขียนไว้หัว report ก่อนลงมือ): มีโค้ดที่ทำเรื่องนี้อยู่แล้วไหม (grep) · "สิ่งนี้จะตายเมื่อ ___" · รู้ได้ยังไงว่ามันตาย
3. ทุกงานมี ASSERT + stash-test: ถอดโค้ดที่เทสต์อ้างว่าตรวจออก เทสต์ต้องแดงจริง แล้วคืนโค้ด จดผลลง report · เทสต์ต้องเรียกฟังก์ชันจริง ห้ามเขียนตรรกะเลียนแบบ · รันเทสต์ทั้งชุดทุกรอบ
4. report ต้องมี: สถานะแต่ละงาน [เสร็จ / ติดตรงไหน / ยังไม่ทำ] พร้อม output ดิบ · ป้าย [วัดได้] หรือ [คำนวณ] ทุกตัวเลข · หัวข้อ "เคลมไม่ได้" · commit hash · สิ่งที่คนทำต่อควรรู้ · ปฏิเสธงานต้องเขียนเหตุผล · ห้ามเขียนทับ report เดิม รอบสองใช้ batch-XXb.md
5. ค่าจูนแก้ได้โดยไม่แก้โค้ด: settle_time, min_transfer, default_split, AI_DAILY_CAP, SLIP_RETENTION_DAYS เก็บใน DB + หน้า "ตั้งค่า" ใน mini app (B10)
6. สัญญาณว่าระบบตาย (B12): `GET /healthz` คืน last_expense_at, last_summary_sent_at และ stale=true เมื่อไม่มีรายการเกิน 3 วัน หรือไม่ได้ส่งสรุปเกิน 2 คืน
7. ปิดระบบได้โดยไม่ลบโค้ด: คำสั่ง unload และ rollback อยู่ใน `docs/DEPLOY.md`
8. Tier: batch ที่เป็นโหมด fake ทั้งหมด commit และ push main ได้เอง · อะไรที่แตะ credential จริงหรือ deploy เครื่อง production ห้ามทำเอง
9. สคริปต์และเอกสาร: ห้ามใช้ `2>/dev/null` กลืน error · ห้ามคอมเมนต์ท้ายบรรทัดคำสั่ง shell (zsh ไม่อ่าน # เป็นคอมเมนต์)
10. ตอบแชทสั้น 2–3 บรรทัด พร้อมที่อยู่ของ report ห้ามวางรายงานเต็มในแชท
11. ในรีโปเก็บแค่ `docs/CHANGELOG.md` สำหรับพอร์ต: batch ละ 2–3 บรรทัด + commit hash ห้ามมีรายละเอียดส่วนตัว · report เต็มอยู่นอกรีโป (ดู `CLAUDE.local.md`) ห้ามเขียน key/secret ลง report บอกได้แค่ชื่อตัวแปร
12. คำต้องห้ามส่วนตัว (เช่นชื่อเจ้าของ) อยู่ใน `~/.config/harnkan/private-words.txt` นอกรีโป บรรทัดละคำ · `npm run check` ตรวจทุกไฟล์ที่ track · ห้ามเขียนคำจริงลงโค้ด เทสต์ หรือ report
