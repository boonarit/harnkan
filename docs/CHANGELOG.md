# CHANGELOG

สรุปสั้นต่อ batch (รายละเอียดเต็มอยู่ใน report ภายนอกรีโป)

- **B01 · โครงโปรเจกต์** `6b1d3d3` — package.json/tsconfig/.env.example/LICENSE, `src/config.ts` (ไม่มี env → โหมด fake), `scripts/check.ts` ตรวจความลับ ข้อมูลส่วนตัว และ API นอก Node 22
- **B02 · เงินและการหาร** `5468e16` — money/split/balance/time เป็น pure JS + JSDoc (ใช้ร่วมกับเบราว์เซอร์), 5 โหมดหาร, เศษสตางค์สลับรับ, property test 1000 เคส, ตัวอย่าง 1 วัน = ฿347.50
- **B03 · ฐานข้อมูล** `7057807` — node:sqlite + migrations + WAL, Repo ทุกตาราง, soft delete + audit_log, แก้วันที่ปิดยอดแล้วสร้างยอดปรับปรุงเข้าวันนี้ (ตาราง adjustments)
- **B04 · Webhook LINE** `8c6a220` — ตรวจลายเซ็น HMAC แบบ timing-safe, LineClient จริง (fetch) + fake (outbox), join → couple, ข้อความแรก → member, รองรับ 2 คนต่อกลุ่ม
- **B05 · บันทึกจากข้อความ** `2b19093` — parse ข้อความไทย (รายการ/เลี้ยง/ของ<ชื่อ>/คำสั่ง) ข้อความทั่วไปบอทเงียบ, การ์ด Flex + quick reply เปลี่ยนการหาร, สรุป/ยกเลิก/ช่วยด้วย
- **B06 · ถอด QR สลิป** `8566abd` — jimp + jsQR + promptparse ดึง transRef กันสลิปซ้ำ, เก็บรูปใต้ DATA_DIR, fixture สลิปสังเคราะห์ 5 ใบ
- **B07 · อ่านสลิปด้วย AI** `ab0c15f` — SlipReader (Claude จริง + fake), จัดประเภท expense/settlement, ถามยืนยันเมื่อ confidence ต่ำ, งบ AI รายวันต่อคู่, รูปทั่วไปในแชทบอทเงียบ
- **B08 · สรุป 21:00 + ปิดยอด** `3e1271d` — QR พร้อมเพย์ใส่ยอดเสิร์ฟผ่าน token อายุ 24 ชม., งานสรุปรายวัน idempotent + ส่งใหม่เมื่อ push ล้ม, สลิปโอนจับคู่กับสรุปแล้วปิดยอด ขาด/เกินยกไปวันถัดไป
- **B09 · API mini app** `96b4a67` — REST ตรวจ LIFF ID token (จริง + fake), ข้อมูลจำกัดต่อคู่ (คู่อื่น = 404), audit ทุก PATCH/DELETE, ตั้งค่าคู่เก็บใน DB แก้ผ่าน API
- **B10 · หน้าจอ mini app** `f46aad4` — HTML + ES modules ไม่มี framework/build: วันนี้ · เพิ่มรายการพร้อมพรีวิวยอด · แก้ไข · เคลียร์ยอด (QR) · ประวัติ (ปฏิทิน) · ตั้งค่า, adapter เดียวทั้ง API และ local
- **B11 · โหมดเดโม** `2686e37` — เดโม static ใช้แอปชุดเดียวกัน + LocalAdapter + แชท LINE จำลอง (parse ตัวเดียวกับบอท) + สลิปสังเคราะห์ 3 ใบ, ไม่มี request ออกนอกนอกจากฟอนต์
- **B12 · Ops และ log** `11bb6e5` — log JSON หมุนไฟล์ 5 MB × 5 ไม่มีความลับ, backup SQLite + gzip เก็บ 7 ชุด, retention รูปสลิป, /healthz บอก stale, template launchd/cloudflared + DEPLOY.md พร้อม unload/rollback
- **B13 · ความปลอดภัยและความเป็นส่วนตัว** `8be82ed` — rate limit ต่อ IP (เชื่อ CF-Connecting-IP เฉพาะผ่าน tunnel), ตรวจ event, header + CSP ไม่มี unsafe-inline, "ลบข้อมูลทั้งหมด" ยืนยัน 2 ขั้น, PRIVACY.md
- **B14 · End-to-end + CI + README** `7efa83e` — เทสต์ e2e วันตัวอย่างผ่าน webhook จริง → สรุป → QR → สลิปโอน → ปิดยอด, CI GitHub Actions บน Node 22, README พอร์ต (mermaid + สูตร), ADR 001–005, SETUP-CREDENTIALS
- **B15 · เตรียมเปิดสาธารณะ + เปลี่ยนชื่อ** `81c9ec6` `75a21fc` — ตัดข้อมูลที่โยงถึงเจ้าของ, กฎเฉพาะเครื่องย้ายไป `CLAUDE.local.md` (ไม่ commit), `npm run check` อ่านคำต้องห้ามจากไฟล์นอกรีโป, คำสั่งแชท "ตั้งชื่อ" + กฎชื่อชุดเดียว (ดึงคำสงวนจาก parser) ใช้ทั้งแชท API และหน้าตั้งค่า, parser รู้จัก "ครึ่ง"
- **B16 · Gemini อ่านสลิป** `6ffb749` — `GeminiSlipReader` เรียก REST ด้วย fetch (ไม่เพิ่ม dependency) + responseSchema ที่แปลงจาก schema เดียวกับ Claude, `AI_PROVIDER=gemini|claude` (ค่าเริ่ม gemini), key ส่งทาง header เท่านั้น, 429/500/JSON เพี้ยน → ขอให้พิมพ์ยอด, ADR 006
