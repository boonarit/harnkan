# DEPLOY — ติดตั้งบน M4 (macOS + launchd + cloudflared)

> ทุกค่าในไฟล์นี้เป็นตัวอย่าง · ความลับอยู่ใน `~/.config/harnkan/.env` เท่านั้น
> ทำตามลำดับ · คำสั่งทุกบรรทัดคัดลอกไปวางใน zsh ได้ตรงๆ (ไม่มีคอมเมนต์ท้ายบรรทัด)

## โครงโฟลเดอร์บน M4

| อะไร | ที่ไหน |
|---|---|
| โค้ด | `~/services/harnkan` (git clone) |
| ข้อมูล (DB, รูปสลิป, QR, log) | `~/data/harnkan` |
| สำรอง | `~/backups/harnkan` |
| ความลับ | `~/.config/harnkan/.env` (chmod 600) |
| launchd | `~/Library/LaunchAgents/com.harnkan.*.plist` |

## 1. เตรียมเครื่อง

ต้องมี Node ≥ 22.6 และ git

```sh
node --version
mkdir -p ~/services ~/data/harnkan/logs ~/backups/harnkan ~/.config/harnkan
git clone https://github.com/boonarit/harnkan.git ~/services/harnkan
cd ~/services/harnkan
npm ci --omit=dev
```

## 2. ไฟล์ความลับ

```sh
cp ~/services/harnkan/.env.example ~/.config/harnkan/.env
chmod 600 ~/.config/harnkan/.env
open -e ~/.config/harnkan/.env
```

ค่าที่ต้องตั้งบน M4 — บรรทัดที่ว่างให้ใส่ค่าจริงหลัง `=` (ดู `docs/SETUP-CREDENTIALS.md`):

```
FAKE_LINE=0
FAKE_AI=0
DATA_DIR=~/data/harnkan
BACKUP_DIR=~/backups/harnkan
PUBLIC_BASE_URL=https://<โดเมน tunnel>
LINE_CHANNEL_SECRET=
LINE_CHANNEL_ACCESS_TOKEN=
LIFF_CHANNEL_ID=
LIFF_ID=
AI_PROVIDER=gemini
SLIP_MODEL=
GEMINI_API_KEY=
```

ทดสอบว่า config โหลดได้และสร้าง DB:

```sh
cd ~/services/harnkan
npm run -s migrate
```

## 3. launchd (bot + งานตามเวลา)

แทน `__HOME__` และ `__NODE__` แล้วติดตั้ง:

```sh
cd ~/services/harnkan
NODE_BIN=$(command -v node)
for f in deploy/com.harnkan.*.plist; do sed -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$NODE_BIN#g" "$f" > ~/Library/LaunchAgents/$(basename "$f"); done
for f in ~/Library/LaunchAgents/com.harnkan.*.plist; do plutil -lint "$f"; done
for f in ~/Library/LaunchAgents/com.harnkan.*.plist; do launchctl bootstrap "gui/$(id -u)" "$f"; done
launchctl list | grep harnkan
curl -fsS http://127.0.0.1:8787/healthz
```

| งาน | เวลา | ทำอะไร |
|---|---|---|
| `com.harnkan.bot` | ตลอด (KeepAlive) | server `127.0.0.1:8787` |
| `com.harnkan.summary` | 21:00 ทุกวัน | สรุปยอด + push |
| `com.harnkan.backup` | 04:00 ทุกวัน | สำรอง DB → `~/backups/harnkan` เก็บ `BACKUP_KEEP` ชุด |
| `com.harnkan.retention` | อาทิตย์ 04:30 | ลบรูปสลิปเก่า / QR หมดอายุ / ตัด stdout log |

ถ้าเครื่องหลับตอน 21:00 launchd จะรันงานสรุปตอนตื่น (งานคำนวณวันที่จากเวลาปิดยอด จึงยังสรุปวันที่ถูก)

ลองรันงานด้วยมือ:

```sh
launchctl kickstart "gui/$(id -u)/com.harnkan.summary"
tail -n 5 ~/data/harnkan/logs/harnkan.log
```

## 4. cloudflared tunnel

```sh
cloudflared tunnel login
cloudflared tunnel create harnkan
cp ~/services/harnkan/deploy/cloudflared-harnkan.example.yml ~/.cloudflared/harnkan.yml
open -e ~/.cloudflared/harnkan.yml
cloudflared tunnel route dns harnkan harnkan.example.com
cloudflared tunnel --config ~/.cloudflared/harnkan.yml run harnkan
```

แก้ `<TUNNEL_ID>`, `__HOME__` และ hostname ใน `harnkan.yml` ให้ตรง · เปิดเฉพาะ `/webhook /healthz /qr/ /app/ /api/ /domain/` ที่เหลือ 404
ให้ tunnel รันตลอดด้วย `sudo cloudflared service install` หรือ launchd ตามที่ใช้กับบริการอื่นบน M4

## 5. อัปเดตเวอร์ชัน

```sh
bash ~/services/harnkan/deploy/update.sh
```

สคริปต์จด commit ก่อนอัปเดตไว้ที่ `~/data/harnkan/last-good-commit` → git pull → npm ci → migrate → restart bot → เช็ค healthz

## 6. ตรวจว่าระบบยังมีชีวิต

```sh
curl -fsS http://127.0.0.1:8787/healthz
```

- `stale: true` = ไม่มีรายการใหม่เกิน 3 วัน หรือไม่ได้สรุปยอดตั้งแต่ 2 คืนขึ้นไป (ดู `reasons`)
- `mode: "fake"` บน M4 = ลืมตั้ง `FAKE_LINE=0 FAKE_AI=0`
- ตั้ง uptime monitor ให้เรียก `https://<โดเมน>/healthz` แล้วแจ้งเตือนเมื่อ `stale` เป็น true

## 7. ปิดระบบชั่วคราว (ไม่ลบโค้ด ไม่ลบข้อมูล)

```sh
for l in bot summary backup retention; do launchctl bootout "gui/$(id -u)/com.harnkan.$l"; done
launchctl list | grep harnkan
```

ถ้าเจอ error ว่าไม่พบ service แปลว่าปิดอยู่แล้ว · หยุด tunnel ด้วย `Ctrl+C` หรือ `sudo launchctl bootout system/com.cloudflare.cloudflared` ถ้าติดตั้งเป็น service

เปิดกลับ:

```sh
for f in ~/Library/LaunchAgents/com.harnkan.*.plist; do launchctl bootstrap "gui/$(id -u)" "$f"; done
```

ระหว่างปิด LINE จะส่ง webhook ไม่สำเร็จ (ข้อความช่วงนั้นไม่ถูกบันทึก) · ปิดเฉพาะงานสรุปได้ด้วย `launchctl bootout "gui/$(id -u)/com.harnkan.summary"`

## 8. Rollback

### โค้ด (กลับไป commit ก่อนอัปเดต)

```sh
cd ~/services/harnkan
git log --oneline -5
git checkout "$(cat ~/data/harnkan/last-good-commit)"
npm ci --omit=dev
launchctl kickstart -k "gui/$(id -u)/com.harnkan.bot"
curl -fsS http://127.0.0.1:8787/healthz
```

กลับมา main ภายหลังด้วย `git checkout main && bash deploy/update.sh`
migration เป็นแบบเพิ่มอย่างเดียว (ADD COLUMN/TABLE) โค้ดเก่าจึงเปิด DB ใหม่ได้ · ถ้า migration ไหนไม่ใช่แบบนั้นจะจดไว้ใน CHANGELOG

### ข้อมูล (กู้ DB จาก backup)

```sh
for l in bot summary backup retention; do launchctl bootout "gui/$(id -u)/com.harnkan.$l"; done
ls -1t ~/backups/harnkan | head -3
mv ~/data/harnkan/harnkan.db ~/data/harnkan/harnkan.db.broken-$(date +%Y%m%d%H%M)
rm -f ~/data/harnkan/harnkan.db-wal ~/data/harnkan/harnkan.db-shm
gunzip -c ~/backups/harnkan/<ไฟล์ล่าสุด>.db.gz > ~/data/harnkan/harnkan.db
for f in ~/Library/LaunchAgents/com.harnkan.*.plist; do launchctl bootstrap "gui/$(id -u)" "$f"; done
curl -fsS http://127.0.0.1:8787/healthz
```

backup เก็บเฉพาะ DB · รูปสลิปใน `~/data/harnkan/slips` ไม่ได้สำรอง (ตัวเลขทั้งหมดอยู่ใน DB แล้ว)

## 9. ถอนการติดตั้งทั้งหมด

ทำข้อ 7 ก่อน แล้ว:

```sh
rm ~/Library/LaunchAgents/com.harnkan.*.plist
```

โค้ด ข้อมูล และ backup ยังอยู่ · ลบเองเมื่อแน่ใจ

## เดโม (Cloudflare Pages)

- Build command: ว่าง · Output directory: `/` (รากรีโป)
- เปิด `https://<project>.pages.dev/demo/`
- เดโมใช้ `demo/` `public/app/` `src/domain/` `test/fixtures/synthetic/` แบบ static ล้วน ไม่มี server ไม่เก็บข้อมูลนอกเบราว์เซอร์
