# SETUP-CREDENTIALS — สิ่งที่ผู้ดูแลต้องทำก่อนใช้ของจริง (ระยะที่ 5)

โค้ดทั้งหมดทดสอบในโหมด fake แล้ว (`FAKE_LINE=1`, `FAKE_AI=1`) · ขั้นตอนนี้คือการสร้างบัญชี/คีย์จริง แล้วใส่ในไฟล์ `~/.config/harnkan/.env` บน M4 **เท่านั้น** (ห้ามใส่ในรีโป)
ทำตามลำดับ · แต่ละขั้นมีคำสั่งทดสอบ ถ้าขั้นไหนไม่ผ่าน อย่าไปขั้นถัดไป

## Checklist

- [ ] 0. ติดตั้งบน M4 และ tunnel ใช้ได้ (`docs/DEPLOY.md` ข้อ 1–4) → ได้โดเมน `https://<โดเมน>`
- [ ] 1. LINE Official Account + Messaging API channel
- [ ] 2. ตั้ง webhook
- [ ] 3. LINE Login channel + LIFF app (mini app)
- [ ] 4. Anthropic API key
- [ ] 5. ไฟล์ `~/.config/harnkan/.env` ครบ แล้ว restart
- [ ] 6. ทดสอบในกลุ่มจริง
- [ ] 7. ตั้งเบอร์พร้อมเพย์ 2 คน และชื่อบัญชีตามสลิป
- [ ] 8. ทดสอบสรุป 21:00 และปิดยอด

## 0. ก่อนเริ่ม

```sh
curl -fsS https://<โดเมน>/healthz
```

ต้องได้ JSON ที่มี `"ok":true` (ตอนนี้ `mode` ยังเป็น `fake` ได้)

## 1. LINE Official Account + Messaging API

1. เข้า [LINE Developers Console](https://developers.line.biz/console/) → สร้าง Provider (เช่น "harnkan")
2. สร้าง **Messaging API channel** (ระบบจะสร้าง LINE OA ให้)
3. แท็บ **Basic settings** → คัดลอก **Channel secret** → ใส่ `LINE_CHANNEL_SECRET`
4. แท็บ **Messaging API** → ออก **Channel access token (long-lived)** → ใส่ `LINE_CHANNEL_ACCESS_TOKEN`
5. ใน LINE Official Account Manager ของ OA นี้:
   - เปิด **Allow bot to join group chats**
   - ปิด **Auto-reply messages** และ **Greeting messages** (ไม่งั้น OA ตอบซ้อนกับบอท)
   - เปิด **Webhooks**

ทดสอบ token (โหลด env ในเชลล์นั้นชั่วคราว):

```sh
set -a
source ~/.config/harnkan/.env
set +a
curl -fsS -H "Authorization: Bearer $LINE_CHANNEL_ACCESS_TOKEN" https://api.line.me/v2/bot/info
```

ต้องได้ JSON ที่มี `displayName` ของ OA

## 2. Webhook

1. แท็บ **Messaging API** → Webhook URL = `https://<โดเมน>/webhook`
2. เปิด **Use webhook**
3. กด **Verify** → ต้องขึ้น Success (ถ้า 401 = channel secret ไม่ตรง)

ดู log ว่ามี request เข้ามา:

```sh
tail -n 20 ~/data/harnkan/logs/harnkan.log
```

## 3. LINE Login channel + LIFF (mini app)

1. Provider เดียวกัน → สร้าง **LINE Login channel**
2. แท็บ **Basic settings** → คัดลอก **Channel ID** → ใส่ `LIFF_CHANNEL_ID` (ใช้ตรวจ ID token ของ mini app)
3. แท็บ **LIFF** → Add:
   - Size: **Full**
   - Endpoint URL: `https://<โดเมน>/app/`
   - Scopes: `openid`, `profile`
   - Bot link feature: **On (Normal)** เลือก OA จากข้อ 1
4. คัดลอก **LIFF ID** → ใส่ `LIFF_ID` · ลิงก์เปิดแอปคือ `https://liff.line.me/<LIFF ID>`
5. (ถ้าจะทำเป็น LINE MINI App ภายหลัง ใช้ endpoint เดิมได้ — ตอนทดสอบใช้ LIFF พอ)

ทดสอบหลัง restart (ข้อ 5): เปิด `https://liff.line.me/<LIFF ID>` ในแชท LINE → ต้องเห็นหน้า "วันนี้" (ถ้าเห็น "ยังไม่ได้อยู่ในกลุ่มหารกัน" = ยังไม่ได้พิมพ์อะไรในกลุ่ม)

## 4. Anthropic API key

1. [console.anthropic.com](https://console.anthropic.com/) → API Keys → Create key → ใส่ `ANTHROPIC_API_KEY`
2. ตั้ง **spend limit** รายเดือนของ workspace (แนะนำเริ่มต่ำๆ) · ในแอปยังมีเพดาน `AI_DAILY_CAP` (ค่าเริ่ม 30 รูป/วัน/คู่) อีกชั้น
3. โมเดลเริ่มต้น `SLIP_MODEL=claude-haiku-4-5` (ถูกและเร็วพอสำหรับสลิป) · ถ้าเปลี่ยนเป็นรุ่นที่ไม่รองรับ forced tool use ต้องแก้ `src/slip/vision.ts` (ดู report B07)

ทดสอบ key:

```sh
set -a
source ~/.config/harnkan/.env
set +a
curl -fsS https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

ต้องได้รายชื่อโมเดล

## 5. ไฟล์ env และ restart

ค่าที่ต้องมี (ดูรูปแบบใน `.env.example` และ `docs/DEPLOY.md` ข้อ 2): `FAKE_LINE=0` `FAKE_AI=0` `DATA_DIR` `BACKUP_DIR` `PUBLIC_BASE_URL` `LINE_CHANNEL_SECRET` `LINE_CHANNEL_ACCESS_TOKEN` `LIFF_CHANNEL_ID` `LIFF_ID` `ANTHROPIC_API_KEY`

```sh
chmod 600 ~/.config/harnkan/.env
cd ~/services/harnkan
npm run -s migrate
launchctl kickstart -k "gui/$(id -u)/com.harnkan.bot"
curl -fsS http://127.0.0.1:8787/healthz
```

`healthz` ต้องบอก `"mode":"real"` · ถ้า bot ไม่ขึ้น ดู `tail -n 30 ~/data/harnkan/logs/bot.stdout.log` (ขาดค่า env จะบอกชื่อตัวแปรที่ขาด)

## 6. ทดสอบในกลุ่มจริง

1. สร้างกลุ่ม LINE 2 คน → เชิญ OA เข้ากลุ่ม → บอททักทาย
2. ทั้งสองคนพิมพ์อะไรก็ได้ 1 ข้อความ (ลงทะเบียน)
3. พิมพ์ `กาแฟ 90` → ต้องได้การ์ด ✓ บันทึกแล้ว + ปุ่ม 4 ปุ่ม
4. พิมพ์ `ถึงยัง` → บอทต้อง **เงียบ**
5. ส่งรูปสลิปโอนร้านค้า → ต้องได้การ์ด · ส่งรูปเดิมซ้ำ → "สลิปนี้บันทึกแล้วเมื่อ …"
6. พิมพ์ `สรุป` → ยอดตอนนี้

## 7. เบอร์พร้อมเพย์และชื่อบัญชี

แต่ละคนเปิด mini app → **ตั้งค่า**:
- เบอร์พร้อมเพย์ (รับเงิน) — ใช้สร้าง QR ตอนสรุป
- ชื่อบัญชีตามสลิป (ชื่อ-นามสกุลตามแอปธนาคาร) — ใช้แยกว่าสลิปไหนคือ "โอนเคลียร์ยอดให้อีกคน"

## 8. สรุปและปิดยอด

ทดสอบโดยไม่ต้องรอ 21:00:

```sh
launchctl kickstart "gui/$(id -u)/com.harnkan.summary"
tail -n 5 ~/data/harnkan/logs/harnkan.log
```

- ยอด ≥ ขั้นต่ำ → กลุ่มได้การ์ดสรุป + QR (รูป QR ต้องโหลดขึ้นในแชท = tunnel และ `PUBLIC_BASE_URL` ถูก)
- สแกน QR ด้วยแอปธนาคาร → ยอดต้องตรง → โอน → ส่งสลิปในกลุ่ม → "เคลียร์แล้ว ✅"
- งานสรุปคำนวณ "วันที่ต้องปิด" เอง: รันก่อน 21:00 จะสรุปเมื่อวาน (ถ้าสรุปไปแล้วจะข้าม)

## ถ้าต้องหยุดใช้ของจริงชั่วคราว

ตั้ง `FAKE_LINE=1` `FAKE_AI=1` ใน env แล้ว restart bot หรือปิดระบบตาม `docs/DEPLOY.md` ข้อ 7

## ปัญหาที่เจอระหว่างทดสอบ 2 สัปดาห์

จดเป็น batch ใหม่ B15+ ใน `docs/PLAN.md` (อาการ · ข้อความ/ขั้นตอนที่ทำให้เกิด · เวลา) — ห้ามแนบสลิปหรือภาพหน้าจอที่มีข้อมูลจริง
