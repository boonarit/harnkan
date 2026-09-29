# PLAN — harnkan สัปดาห์ 1–4 (loop engineering)

เป้าหมาย: เขียนรวดเดียวจบทั้ง 4 สัปดาห์ในโหมด fake (ไม่ต้องมี credential) ทุก batch มีเทสต์ยืนยัน
หลังจบแผน ผู้ดูแลใส่ credential ตาม `docs/SETUP-CREDENTIALS.md` แล้วทดสอบกับของจริง (ระยะที่ 5)

อ่าน `CLAUDE.md` ก่อน กติกาในนั้นมาก่อนแผนนี้เสมอ

## ข้อมูลหลักที่ใช้ทั้งโปรเจกต์

**ตัวอย่าง 1 วัน (ต้องเป็นเทสต์ end-to-end ใน B14)** — คน `A`=เอ, `B`=บี

| เวลา | รายการ | จ่ายโดย | หาร | B ค้าง A | A ค้าง B |
|---|---|---|---|---|---|
| 08:10 | กาแฟ 2 แก้ว 90 | A | ครึ่ง | 45.00 | – |
| 12:30 | ข้าวกลางวัน 240 | B | ครึ่ง | – | 120.00 |
| 18:45 | 7-Eleven 127 | A | ครึ่ง | 63.50 | – |
| 19:10 | ครีมกันแดด 359 | A | ของ B | 359.00 | – |
| 20:00 | ข้าวเย็น 420 | B | เลี้ยง | – | – |

ผลที่ต้องได้: **B โอนให้ A ฿347.50 ครั้งเดียว** (34750 สตางค์)

**สูตรยอดสุทธิ** (บวก = B ต้องโอนให้ A)

```
N = Σ ส่วนของ B ในบิลที่ A จ่าย − Σ ส่วนของ A ในบิลที่ B จ่าย + ยอดยกมา − ที่ B โอนให้ A แล้ว + ที่ A โอนให้ B แล้ว
```

**โหมดหาร:** `half` (50/50, ค่าเริ่มต้น) · `mine` (ของคนจ่ายเอง) · `theirs` (ของอีกคนทั้งหมด) · `treat` (เลี้ยง ไม่นับเข้ายอด แต่บันทึกไว้) · `ratio` (เช่น 60/40)
เศษสตางค์คี่: สลับกันรับทีละรายการ (ใช้ลำดับ id เพื่อให้ผลคงที่)

**ตาราง DB:** couples · members · expenses · expense_shares · slips · settlements · daily_summaries · audit_log (รายละเอียดใน B03)

---

## สัปดาห์ 1 — บอทพื้นฐาน

### B01 · โครงโปรเจกต์
- `package.json` (`"type": "module"`, engines node >=22.6, scripts ตาม CLAUDE.md), `tsconfig.json` (ไว้ให้ editor ตรวจ type เท่านั้น), `.gitignore` (`.data/`, `node_modules/`, `*.db*`, `*.log`, `.env*` ยกเว้น `.env.example`), `.env.example`, `LICENSE` (MIT, ผู้ถือลิขสิทธิ์ "boonarit"), `README.md` โครงเปล่า
- `src/config.ts`: โหลด env จาก `HARNKAN_ENV` (ค่าเริ่มต้น `~/.config/harnkan/.env`) ถ้าไม่มีไฟล์ใช้ค่าเริ่มต้นแบบ fake · ตรวจค่าที่จำเป็นตามโหมด
- `scripts/check.ts`: สแกนไฟล์ที่ git ติดตาม หา pattern ความลับ (token ยาว, `sk-ant-`, private key header, channel secret 32 hex), เลขบัญชี/เบอร์โทรไทยรูปแบบจริงที่ไม่ใช่ `08000000xx`, และไฟล์รูปนอก `test/fixtures/synthetic/` → ล้มถ้าเจอ
- เกณฑ์ผ่าน: `npm test` (smoke 1 ตัว) และ `npm run check` เขียว · `node --version` 22 และ 26 รันได้ทั้งคู่ (ห้ามใช้ API ใหม่กว่า 22)

### B02 · เงินและการหาร (pure)
- `src/domain/money.ts`: แปลง "1,250", "฿90", "90บ", "63.5" ↔ สตางค์ · format แสดงผล `฿347.50`
- `src/domain/split.ts`: คำนวณ `shares` ของแต่ละโหมด รวมแล้วต้องเท่ายอดบิลพอดี
- `src/domain/balance.ts`: ยอดสุทธิรายวัน + ยอดยกมา + หักการโอนเคลียร์ + กฎยอดขั้นต่ำ (`MIN_TRANSFER` ค่าเริ่ม 5000 สตางค์ ต่ำกว่านี้ทบวันถัดไป)
- เกณฑ์ผ่าน: เทสต์ตัวอย่าง 1 วันได้ 34750 · เทสต์เศษคี่ (127 → 6350/6350, 101 สตางค์ สลับรับ) · property test ง่ายๆ: ผลรวม shares = ยอดบิลเสมอ (สุ่ม 1000 เคส seed คงที่)

### B03 · ฐานข้อมูล
- `src/db/schema.ts` + migrations แบบลำดับเลข, เปิด WAL, foreign keys on
- ตาราง: `couples`(line_group_id unique, settle_time '21:00', min_transfer, default_split) · `members`(couple_id, line_user_id, display_name, promptpay_id, bank_names json) · `expenses`(paid_by, amount_satang, merchant, category, occurred_at, split_mode, ratio, source text|slip|manual, status active|deleted, created_by) · `expense_shares` · `slips`(image_path, qr_trans_ref unique nullable, bank, amount_satang, sender_name, receiver_name, ai_json, confidence, kind expense|settlement|unknown) · `settlements` · `daily_summaries`(couple_id+date unique, net_satang, carried_in, sent_message_id, settled) · `audit_log`(entity, entity_id, member_id, action, before_json, after_json, at)
- repository ต่อตาราง, ทุกการแก้/ลบ expense เขียน audit_log
- เกณฑ์ผ่าน: เทสต์บน DB ชั่วคราวใน `os.tmpdir()` · ลบ expense = soft delete · แก้ย้อนหลังของวันที่ปิดยอดแล้ว → สร้างยอดปรับปรุงเข้าวันนี้ ไม่แก้ daily_summaries เดิม

### B04 · Webhook LINE
- `src/line/signature.ts`: ตรวจ `x-line-signature` (HMAC-SHA256 base64 ด้วย channel secret, เทียบแบบ timingSafeEqual)
- `src/line/client.ts`: interface `LineClient` (reply, push, getContent, getGroupMemberProfile) + `RealLineClient` (fetch ตรง ไม่ใช้ SDK) + `FakeLineClient` (เก็บ outbox ไว้ตรวจในเทสต์)
- `src/server.ts`: `POST /webhook`, `GET /healthz` · bind `127.0.0.1` · จำกัดขนาด body
- router: `join` กลุ่ม → สร้าง couple · ข้อความแรกของสมาชิก → ลงทะเบียน member (ดึงชื่อจาก profile) · รองรับสูงสุด 2 คนต่อกลุ่ม คนที่ 3 ตอบสุภาพว่ารองรับ 2 คน
- เกณฑ์ผ่าน: fixture event ที่เซ็นถูก → 200, เซ็นผิด → 401 · join + 2 ข้อความ → couple 1 + members 2

### B05 · บันทึกจากข้อความ + ปุ่มลัด
- `src/domain/parse.ts`: "กาแฟ 90" · "ข้าว 1,250" · "ข้าวเย็น 420 เลี้ยง" · "ครีมกันแดดของบี 359" / "ของ<ชื่อ>" · "90" เฉยๆ (ชื่อ = "ไม่ระบุ") · คำสั่ง "สรุป", "ยกเลิก" (ลบรายการล่าสุดของผู้ส่ง), "ช่วยด้วย"
- ข้อความที่ไม่ใช่รายการ → บอทเงียบ (ห้ามรบกวนแชทปกติของคู่)
- ตอบกลับเป็น Flex card: ✓ บันทึกแล้ว · ชื่อ ยอด · ใครจ่าย · โหมดหาร · ผลต่อยอด + quick reply 4 ปุ่ม (หารครึ่ง · ของ<A> · ของ<B> · เลี้ยง) ส่ง postback `split:<expenseId>:<mode>`
- postback เปลี่ยนโหมด → ตอบการ์ดใหม่ + audit_log
- "สรุป" → ตอบยอดตอนนี้ (reply ไม่เสียโควตา)
- เกณฑ์ผ่าน: เทสต์ parse ≥ 25 เคส (รวมเคสที่ต้องเงียบ) · ครอบคลุม reply/postback ผ่าน FakeLineClient

## สัปดาห์ 2 — อ่านสลิปและเคลียร์ยอด

### B06 · ถอด QR จากรูปสลิป
- `src/slip/qr.ts`: อ่านรูป (jimp) → jsqr → ถ้าเป็น payload Slip Verify ใช้ `promptparse` แยก `sendingBank`, `transRef`
- กันซ้ำด้วย `qr_trans_ref` unique → ถ้าซ้ำตอบ "สลิปนี้บันทึกแล้วเมื่อ HH:MM"
- fixture: สร้างรูปสลิปสังเคราะห์ในเทสต์ (พื้นขาว + ข้อความ + QR ที่ encode payload ปลอม) เก็บที่ `test/fixtures/synthetic/`
- เกณฑ์ผ่าน: อ่าน transRef จากรูปสังเคราะห์ได้ · ส่งซ้ำถูกจับได้ · รูปไม่มี QR → ไม่พัง คืน null

### B07 · อ่านสลิปด้วย AI
- `src/slip/vision.ts`: interface `SlipReader` + `ClaudeSlipReader` (`@anthropic-ai/sdk`, model จาก env `SLIP_MODEL` ค่าเริ่ม `claude-haiku-4-5`, ย่อรูปด้านยาวไม่เกิน 1568px, บังคับผลเป็น JSON ผ่าน tool schema) + `FakeSlipReader` (อ่านผลจาก fixture ตามชื่อไฟล์)
- JSON: type(transfer_slip|receipt|other), amount, datetime, sender_name, receiver_name, merchant, items[], category, confidence
- `src/slip/classify.ts`: ผู้รับตรงกับชื่อ/bank_names ของอีกคน → settlement · ไม่ตรง → expense (คนจ่าย = คนส่งรูป) · confidence < 0.8 หรือไม่มียอด → ถามกลับ 1 คำถามพร้อมปุ่ม "ใช่ ฿X" / "แก้ยอด"
- งบกัน AI บานปลาย: `AI_DAILY_CAP` ต่อ couple (ค่าเริ่ม 30 รูป) เกินแล้วขอให้พิมพ์ยอดแทน
- เก็บรูปใน `DATA_DIR/slips/<couple>/<yyyy-mm>/` ชื่อไฟล์เป็น uuid
- เกณฑ์ผ่าน: flow รูป → บันทึก expense ครบ (ด้วย Fake) · สลิปโอนหาอีกคน → settlement · confidence ต่ำ → ถามกลับ

### B08 · QR พร้อมเพย์ + สรุป 21:00 + ปิดยอด
- `src/promptpay/qr.ts`: payload พร้อมเพย์ใส่ยอด (`promptparse`) → PNG (`qrcode`) เก็บ `DATA_DIR/qr/`
- เสิร์ฟรูปผ่าน `GET /qr/<token>.png` token สุ่มอายุ 24 ชม. (LINE ต้องการ URL https — ของจริงผ่าน tunnel)
- `src/jobs/summary.ts` (`npm run job:summary`): ทุก couple คำนวณยอดวันนี้ → ยอด ≥ ขั้นต่ำ ส่ง push Flex (ยอดเดียว · ใครโอนให้ใคร · จำนวนบิล · QR · ปุ่ม "ทบไปพรุ่งนี้") · ยอด = 0 ส่ง "วันนี้ไม่มีใครติดใคร" · ต่ำกว่าขั้นต่ำ → ทบ ไม่ push · **idempotent** รันซ้ำวันเดียวกันไม่ส่งซ้ำ
- settlement เข้ามา → จับคู่กับ daily_summaries ที่ยังไม่ปิด · ยอดตรง → ปิด + ตอบ "เคลียร์แล้ว" · ขาด/เกิน → ส่วนต่างเป็นยอดยกมา
- เกณฑ์ผ่าน: เทสต์ตัวอย่าง 1 วัน → push 1 ข้อความที่ยอด 34750 · รันซ้ำไม่ส่งซ้ำ · สลิปโอน 347.50 → ปิดยอด

## สัปดาห์ 3 — Mini app

### B09 · API สำหรับ mini app
- auth: header `Authorization: Bearer <LIFF ID token>` → ตรวจกับ `https://api.line.me/oauth2/v2.1/verify` (interface + fake) → หา member → จำกัดข้อมูลเฉพาะ couple ของตัวเอง
- `GET /api/today` · `GET /api/days?month=` · `GET /api/expenses/:id` · `PATCH /api/expenses/:id` (split_mode, ชื่อ, ยอด) · `DELETE /api/expenses/:id` (soft) · `POST /api/expenses` (เพิ่มเอง) · `GET /api/slips/:id/image` (เฉพาะสมาชิก couple)
- เกณฑ์ผ่าน: เทสต์สิทธิ์ (คนต่าง couple เข้าไม่ได้ = 404) · ทุก PATCH/DELETE มี audit_log

### B10 · หน้าจอ mini app
- `public/app/`: index.html + ES modules + CSS · ใช้ดีไซน์จากโปรโตไทป์ (พื้น #F5F1EA, การ์ดยอดสีเข้ม #24211D, สีคน A #2F5FD0 / B #B54A15, ฟอนต์ IBM Plex Sans Thai Looped + Mitr, ปุ่มสูง ≥ 44px, ตัวหนังสือ ≥ 16px)
- หน้า: วันนี้ · เพิ่มรายการ (แป้นตัวเลข + เลือกคนจ่าย + โหมดหาร + แสดงผลต่อยอดก่อนบันทึก) · รายละเอียด/แก้ไข · เคลียร์ยอด (QR + บันทึกรูป + คัดลอกเบอร์ + วิธีสแกน 2 แบบ) · ประวัติ (ปฏิทินรายเดือน แตะวันดูยอด)
- ชั้นข้อมูลแยก: `public/app/data/adapter.js` interface เดียว มี `ApiAdapter` (ของจริง) และ `LocalAdapter` (เดโม)
- โหลด LIFF SDK จาก `https://static.line-scdn.net/liff/edge/2/sdk.js` เมื่อไม่ใช่เดโม
- เกณฑ์ผ่าน: เทสต์ logic ของ adapter/formatter ด้วย node:test · เปิดทุกหน้าได้โดยไม่มี error ใน `npm run dev` (FAKE auth)

### B11 · โหมดเดโม
- `demo/`: ใช้ `public/app` ชุดเดียวกัน + `LocalAdapter` (localStorage) + ข้อมูลคู่สมมติ เอ & บี (ตัวอย่าง 1 วัน + ย้อนหลัง 3 สัปดาห์)
- หน้าแชทจำลอง: พิมพ์ "กาแฟ 90" หรือกดเลือกสลิปสังเคราะห์ 3 ใบ → เห็นการ์ดบอทตอบ + ยอดเปลี่ยนทันที (ใช้ parse.ts ตัวเดียวกัน)
- ปุ่ม "เริ่มใหม่" ล้างข้อมูล · แถบบนบอกชัดว่า "โหมดเดโม ข้อมูลสมมติ"
- `npm run demo` เสิร์ฟ `demo/` · deploy เป็น static ได้ (ไม่มี server)
- เกณฑ์ผ่าน: เทสต์ LocalAdapter ให้ยอด 34750 กับข้อมูลวันตัวอย่าง · ไม่มี request ออกเน็ตยกเว้นฟอนต์

## สัปดาห์ 4 — เก็บงาน

### B12 · Ops และ log (บทเรียนจาก M4: log ห้ามบวม)
- `src/log.ts`: log JSON บรรทัดเดียวไปที่ `DATA_DIR/logs/` หมุนไฟล์เมื่อเกิน 5 MB เก็บ 5 ไฟล์ ห้ามมี token/รูป/ข้อมูลสลิปเต็มใน log
- `src/jobs/backup.ts`: `sqlite .backup` → gzip → `BACKUP_DIR` เก็บ `BACKUP_KEEP` ชุด (ค่าเริ่ม 7) ลบเก่าหลังสำรองใหม่สำเร็จเท่านั้น
- `src/jobs/retention.ts`: ลบรูปสลิปเก่ากว่า `SLIP_RETENTION_DAYS` (ค่าเริ่ม 365) เก็บข้อมูลตัวเลขไว้
- `deploy/`: template `com.harnkan.bot.plist` (KeepAlive), `com.harnkan.summary.plist` (21:00), `com.harnkan.backup.plist` (04:00), `com.harnkan.retention.plist` (รายสัปดาห์), `cloudflared-harnkan.example.yml`, `update.sh` (git pull → npm ci → migrate → launchctl kickstart) — ค่าทั้งหมดเป็น placeholder
- `docs/DEPLOY.md`: ขั้นตั้ง M4 ทีละขั้น (โฟลเดอร์ `~/services` `~/data` `~/backups`, launchd, tunnel)
- เกณฑ์ผ่าน: เทสต์ rotation และ backup retention บน tmpdir

### B13 · ความปลอดภัยและความเป็นส่วนตัว
- rate limit ต่อ IP บน `/api` และ `/webhook` · ตรวจ input ทุก endpoint · header ความปลอดภัยพื้นฐาน
- คำสั่งในแชท "ลบข้อมูลทั้งหมด" → ยืนยันด้วยปุ่ม 2 ขั้น → ลบ couple + รูป
- `docs/PRIVACY.md` สั้นๆ ภาษาไทย: เก็บอะไร เก็บที่ไหน ลบอย่างไร
- เกณฑ์ผ่าน: เทสต์ rate limit, ลบข้อมูลทั้งหมด, `npm run check` ผ่าน

### B14 · End-to-end + CI + README พอร์ต
- `test/e2e/day.test.ts`: จำลองวันตัวอย่างทั้งวันผ่าน webhook (ข้อความ + สลิปสังเคราะห์) → job:summary → สลิปโอน → ปิดยอด ตรวจข้อความใน FakeLineClient ทุกขั้น
- `.github/workflows/ci.yml`: `npm ci && npm test && npm run check` บน **Node 22** (runner ของ GitHub เท่านั้น ห้าม self-hosted)
- `README.md` สำหรับพอร์ต: ปัญหา · ภาพหน้าจอ (ใส่ placeholder ให้ผู้ดูแลเติม) · สถาปัตยกรรม (mermaid) · สูตรหาร · วิธีรัน `npm run dev` / `npm run demo` · ลิงก์ decisions
- `docs/decisions/`: ADR 001 LINE-first · 002 SQLite แทน Postgres · 003 เงินเป็นสตางค์ · 004 ถอด QR ก่อนใช้ AI · 005 ไม่ใช้ Docker
- `docs/SETUP-CREDENTIALS.md`: checklist ที่ผู้ดูแลต้องทำ (สร้าง LINE OA + Messaging API channel, LINE MINI App/LIFF, webhook URL, Anthropic API key, เบอร์พร้อมเพย์ 2 คน, ไฟล์ `~/.config/harnkan/.env`) พร้อมคำสั่งทดสอบทีละขั้น
- เกณฑ์ผ่าน: e2e เขียว · CI config ถูกต้อง (ตรวจ syntax) · `npm run check` ผ่านทั้งรีโป

---

## ระยะที่ 5 (ผู้ดูแลทำ หลังจบ B14) — ใส่ credential แล้วทดสอบจริง
ตาม `docs/SETUP-CREDENTIALS.md` · ทดสอบในกลุ่ม LINE จริงกับแฟน 2 สัปดาห์ · ปัญหาที่เจอจดเป็น batch ใหม่ B15+

## สรุปสถานะ (อัปเดตท้าย batch ทุกครั้ง)

report เต็มอยู่ใน vault `claude_ai/projects/harnkan/reports/` · สรุปสั้นใน `docs/CHANGELOG.md`

| Batch | สถานะ | commit |
|---|---|---|
| B01 | ✅ เสร็จ | `6b1d3d3` |
| B02 | ✅ เสร็จ | `5468e16` |
| B03 | ✅ เสร็จ | `7057807` |
| B04 | ✅ เสร็จ | `8c6a220` |
| B05 | ✅ เสร็จ | `2b19093` |
| B06 | ✅ เสร็จ | `8566abd` |
| B07 | ✅ เสร็จ | `ab0c15f` |
| B08 | ✅ เสร็จ | `3e1271d` |
| B09 | ✅ เสร็จ | `96b4a67` |
| B10 | ✅ เสร็จ | `f46aad4` |
| B11 | ✅ เสร็จ | `2686e37` |
| B12 | ✅ เสร็จ | `11bb6e5` |
| B13 | ✅ เสร็จ | `8be82ed` |
| B14 | ✅ เสร็จ | `7efa83e` |
| B15 | ✅ เสร็จ | `81c9ec6` `75a21fc` |
| B16 | ✅ เสร็จ | `6ffb749` |

ครบ B01–B14 ในโหมด fake · เทสต์ 98 ตัวเขียวบน Node 26 (M1) และ Node 22 · `npm run check` ผ่าน · ไม่มีเรื่องติดที่ต้องจด QUESTIONS.md

## สิ่งที่ผู้ดูแลต้องทำต่อ (ระยะที่ 5)

1. **ดูผล CI บน GitHub** — แท็บ Actions ของ `boonarit/harnkan` (ผมเช็คจาก M1 ไม่ได้: `gh` ของเครื่องนี้ได้ 404 กับรีโปนี้) ถ้าแดงให้ดู log แล้วเปิดเป็น B15
2. **ติดตั้งบน M4** ตาม `docs/DEPLOY.md` ข้อ 1–4 (clone, env, launchd, cloudflared)
3. **สร้าง credential** ตาม `docs/SETUP-CREDENTIALS.md` ข้อ 1–4: LINE Messaging API channel · webhook · LINE Login + LIFF · Anthropic API key (+ spend limit)
4. ใส่ค่าใน `~/.config/harnkan/.env` บน M4 → `FAKE_LINE=0 FAKE_AI=0` → restart → `/healthz` ต้องบอก `mode: real`
5. ทดสอบในกลุ่มจริงตาม SETUP-CREDENTIALS ข้อ 6–8 แล้วใช้จริงกับแฟน 2 สัปดาห์ · ตั้ง **เบอร์พร้อมเพย์** และ **ชื่อบัญชีตามสลิป** ของทั้งคู่ในหน้าตั้งค่า
6. ตั้ง uptime monitor เรียก `https://<โดเมน>/healthz` แจ้งเตือนเมื่อ `stale: true`
7. (ถ้าจะใช้เป็นพอร์ต) deploy เดโมขึ้น Cloudflare Pages และเติมภาพหน้าจอใน README (ภาพจากเดโมเท่านั้น อัปโหลดผ่าน GitHub ไม่ commit ไฟล์รูป)

### การตัดสินใจที่ต่างจาก PLAN — ทบทวนได้ถ้าไม่เห็นด้วย

- `src/domain/` เป็น `.js` + JSDoc ไม่ใช่ `.ts` เพราะ mini app/เดโมในเบราว์เซอร์ต้อง import ไฟล์เดียวกันโดยไม่มี build
- เพิ่มตาราง `adjustments` (ยอดปรับปรุงเมื่อแก้รายการของวันที่ปิดแล้ว)
- ยอด 0 และไม่มีรายการเลยทั้งวัน → ไม่ push "วันนี้ไม่มีใครติดใคร" (ประหยัดโควตา) · มีรายการแต่ยอด 0 → push
- รายการหลังเวลาปิดยอด (21:00) นับเป็นของวันถัดไป
- `/healthz` stale เมื่อขาดสรุป **ตั้งแต่ 2 คืนติด** (1 คืนยังไม่เตือน)
- เดโมไม่มีรูป QR จริง (ไม่มี lib วาด QR ฝั่งเบราว์เซอร์ และไม่เพิ่ม dependency)
- หน้าเพิ่มรายการยังไม่มีโหมด ratio (ตั้งผ่าน API ได้)
