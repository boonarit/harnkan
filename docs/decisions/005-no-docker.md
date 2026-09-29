# ADR 005 · ไม่ใช้ Docker

**สถานะ:** ใช้อยู่ · 2026-09

## บริบท
เครื่องที่รันคือ Mac mini (M4) ซึ่งรันบริการอื่นด้วย launchd + cloudflared อยู่แล้ว · โปรเจกต์ต้องไม่มีขั้น build

## ตัดสินใจ
- รัน `node --experimental-strip-types` ตรงจากซอร์ส TypeScript (ไม่มี build/bundle)
- launchd คุม process (KeepAlive) และงานตามเวลา (21:00 / 04:00) · cloudflared เปิดเฉพาะ path ที่ต้องใช้
- ข้อมูลอยู่นอกโค้ด (`~/data/harnkan`) · อัปเดต = `git pull` + `npm ci` + restart (`deploy/update.sh`)

## ผลที่ตามมา
- ไม่มี VM layer บน macOS (Docker Desktop กิน RAM/แบต) · log และไฟล์อยู่ในที่ที่มองเห็นได้
- ต้องมี Node ≥ 22.6 บนเครื่อง · CI ทดสอบบน Node 22 เพื่อให้ตรงกับ M4
- ย้ายเครื่องต้องทำตาม `docs/DEPLOY.md` ด้วยมือ (ไม่กี่คำสั่ง)
