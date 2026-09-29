# SETUP-CREDENTIALS — สิ่งที่ผู้ดูแลต้องทำก่อนใช้ของจริง (ระยะที่ 5)

โค้ดทั้งหมดทดสอบในโหมด fake แล้ว (`FAKE_LINE=1`, `FAKE_AI=1`) · ขั้นตอนนี้คือการสร้างบัญชี/คีย์จริง แล้วใส่ในไฟล์ `~/.config/harnkan/.env` บน M4 **เท่านั้น** (ห้ามใส่ในรีโป)
ทำตามลำดับ · แต่ละขั้นมีคำสั่งทดสอบ ถ้าขั้นไหนไม่ผ่าน อย่าไปขั้นถัดไป

## Checklist

- [ ] 0. ติดตั้งบน M4 และ tunnel ใช้ได้ (`docs/DEPLOY.md` ข้อ 1–4) → ได้โดเมน `https://<โดเมน>`
- [ ] 1. LINE Official Account + Messaging API channel
- [ ] 2. ตั้ง webhook
- [ ] 3. LINE Login channel + LIFF app (mini app)
- [ ] 4. Gemini API key (AI Studio + billing + budget alert) — หรือ Anthropic ถ้าเลือก `AI_PROVIDER=claude`
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

## 4. ตัวอ่านสลิป (AI)

ค่าเริ่มต้นคือ **Gemini** (`AI_PROVIDER=gemini`) เหตุผลอยู่ใน `docs/decisions/006-gemini.md` · ใช้ Claude แทนได้ (ข้อ 4b)

> ⚠️ **ห้ามใช้ free tier ของ Gemini API กับสลิปจริง** — ตามเงื่อนไขของ Gemini API (ณ ตอนเขียน) ข้อมูลที่ส่งผ่าน free tier อาจถูก Google นำไปปรับปรุงผลิตภัณฑ์และให้คนตรวจอ่านได้ สลิปมีชื่อ บัญชี และยอดเงินจริง ต้องใช้ key จากโปรเจกต์ที่ **เปิด billing (paid tier)** เท่านั้น · ตรวจเงื่อนไขล่าสุดของ Google อีกครั้งก่อนใช้งาน

### 4a. Gemini (ค่าเริ่มต้น)

1. เข้า [Google AI Studio](https://aistudio.google.com/) ด้วยบัญชี Google ของผู้ดูแล → **Get API key** → **Create API key** → เลือก/สร้าง Google Cloud project สำหรับหารกันโดยเฉพาะ (แยกจากโปรเจกต์อื่น)
2. **เปิด billing ให้โปรเจกต์นั้น:** ในหน้า API keys ของ AI Studio กด **Set up billing** ที่โปรเจกต์ → ผูก Cloud Billing account → สถานะของ key ต้องเปลี่ยนจาก Free เป็น **Paid** (ถ้ายังเป็น Free ห้ามใช้กับสลิปจริง)
3. **ตั้ง budget alert:** [Google Cloud Console](https://console.cloud.google.com/) → Billing → **Budgets & alerts** → Create budget → เลือกเฉพาะโปรเจกต์นี้ → ตั้งยอดรายเดือน (เริ่มต่ำๆ) → แจ้งเตือนที่ 50% / 90% / 100% ไปอีเมลผู้ดูแล
   - budget alert **แค่แจ้งเตือน ไม่ได้หยุดการใช้จ่าย** · ตัวกันอีกชั้นคือ `AI_DAILY_CAP` ในแอป (ค่าเริ่ม 30 รูป/วัน/คู่ ปรับได้ในหน้าตั้งค่า)
   - (ถ้าต้องการ) ตั้ง quota ต่อนาที/ต่อวันของ Generative Language API ใน Cloud Console → APIs & Services → Quotas
4. คัดลอก key → ใส่ `GEMINI_API_KEY` ใน `~/.config/harnkan/.env` · ตั้ง `AI_PROVIDER=gemini`
5. **เลือกรุ่น → `SLIP_MODEL`** (ไม่มีค่าเริ่มต้นในโค้ด เพราะชื่อรุ่นเปลี่ยนบ่อย): ดูรายชื่อรุ่นที่ key นี้ใช้ได้ด้วยคำสั่งด้านล่าง แล้วเลือกรุ่นตระกูล Flash ที่รองรับ `generateContent` · ใส่ชื่อ **ไม่ต้องมี** `models/` นำหน้า

ทดสอบ key และดูรายชื่อรุ่น (key ส่งทาง header ไม่ใส่ใน URL):

```sh
set -a
source ~/.config/harnkan/.env
set +a
curl -fsS https://generativelanguage.googleapis.com/v1beta/models -H "x-goog-api-key: $GEMINI_API_KEY" | grep '"name"'
```

ต้องได้รายการ `"name": "models/…"` · ถ้าได้ 400/403 = key ผิดหรือยังไม่เปิด Generative Language API ในโปรเจกต์

### 4b. Claude (ทางเลือก)

1. [console.anthropic.com](https://console.anthropic.com/) → API Keys → Create key → ใส่ `ANTHROPIC_API_KEY`
2. ตั้ง **spend limit** รายเดือนของ workspace
3. ตั้ง `AI_PROVIDER=claude` · `SLIP_MODEL` ว่างได้ (ใช้ `claude-haiku-4-5`) · ถ้าเปลี่ยนเป็นรุ่นที่ไม่รองรับ forced tool use ต้องแก้ `src/slip/vision.ts`

```sh
set -a
source ~/.config/harnkan/.env
set +a
curl -fsS https://api.anthropic.com/v1/models -H "x-api-key: $ANTHROPIC_API_KEY" -H "anthropic-version: 2023-06-01"
```

## 5. ไฟล์ env และ restart

ค่าที่ต้องมี (ดูรูปแบบใน `.env.example` และ `docs/DEPLOY.md` ข้อ 2): `FAKE_LINE=0` `FAKE_AI=0` `DATA_DIR` `BACKUP_DIR` `PUBLIC_BASE_URL` `LINE_CHANNEL_SECRET` `LINE_CHANNEL_ACCESS_TOKEN` `LIFF_CHANNEL_ID` `LIFF_ID` `AI_PROVIDER` `SLIP_MODEL` และ `GEMINI_API_KEY` (หรือ `ANTHROPIC_API_KEY` ถ้าใช้ claude)

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
