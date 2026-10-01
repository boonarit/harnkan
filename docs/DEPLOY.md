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

แทน `__HOME__` และ `__NODE__` แล้วติดตั้ง 4 งานของ node (tunnel ติดตั้งแยกในข้อ 4):

```sh
cd ~/services/harnkan
NODE_BIN=$(command -v node)
for j in bot summary backup retention; do sed -e "s#__HOME__#$HOME#g" -e "s#__NODE__#$NODE_BIN#g" "deploy/com.harnkan.$j.plist" > ~/Library/LaunchAgents/com.harnkan.$j.plist; done
for j in bot summary backup retention; do plutil -lint ~/Library/LaunchAgents/com.harnkan.$j.plist; done
for j in bot summary backup retention; do launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.harnkan.$j.plist; done
launchctl list | grep harnkan
curl -fsS http://127.0.0.1:8787/healthz
```

| งาน | เวลา | ทำอะไร |
|---|---|---|
| `com.harnkan.bot` | ตลอด (KeepAlive) | server `127.0.0.1:8787` |
| `com.harnkan.summary` | ทุก 10 นาที | สรุปยอด + push เฉพาะคู่ที่เลยเวลาสรุป (ตั้งในแอป) และวันนั้นยังไม่มีสรุป |
| `com.harnkan.backup` | 04:00 ทุกวัน | สำรอง DB → `~/backups/harnkan` เก็บ `BACKUP_KEEP` ชุด |
| `com.harnkan.retention` | อาทิตย์ 04:30 | ลบรูปสลิปเก่า / QR หมดอายุ / ตัด stdout log |

เวลาสรุปอยู่ในแอป (ตั้งค่า → เวลาสรุปยอด) ไม่ได้อยู่ใน plist · เปลี่ยนในแอปแล้วมีผลรอบถัดไปโดยไม่ต้อง deploy · การ์ดมาภายใน 10 นาทีหลังเวลาที่ตั้ง
ถ้าเครื่องหลับเลยเวลาสรุป launchd รันตอนตื่น → การ์ดขึ้นว่า "สรุปย้อนหลัง <วันที่>" (ไม่ใช่ "วันนี้")
`update.sh` ติดตั้ง plist งานสรุปรุ่นใหม่ให้เองเมื่อไฟล์ใน repo เปลี่ยน (bootout ตัวเก่า → bootstrap ตัวใหม่ ไม่แตะงานอื่น)

ตรวจงานสรุป:

```sh
launchctl list | grep com.harnkan.summary
grep summary_done ~/data/harnkan/logs/harnkan.log | tail -n 3
```

ต้องเห็น `com.harnkan.summary` ในรายการ (คอลัมน์แรกเป็น `-` ระหว่างรอรอบถัดไป · คอลัมน์สองเป็น `0` = รอบล่าสุดจบปกติ) · `summary_done` ล่าสุดต้องห่างจากตอนนี้ไม่เกิน 10 นาที

ลองรันงานด้วยมือ:

```sh
launchctl kickstart "gui/$(id -u)/com.harnkan.summary"
tail -n 5 ~/data/harnkan/logs/harnkan.log
```

## 4. cloudflared tunnel

> **บน M4 มี `~/.cloudflared/config.yml` ของบริการอื่นอยู่แล้ว** → ทุกคำสั่ง `cloudflared` ของ harnkan ต้องมี `--config ~/.cloudflared/harnkan-config.yml` และอ้าง tunnel ด้วย **UUID** ไม่ใช่ชื่อ
> ไม่งั้น `route dns` ไปผูก DNS กับ tunnel ของบริการอื่น (เกิดจริงตอน deploy B17 · แก้ด้วย `route dns --overwrite-dns <UUID> …`)
> **ห้าม** `cloudflared service install` (ทับ service ของบริการอื่น) · ใช้ launchd `com.harnkan.tunnel` แทน

ตั้งชื่อโดเมนไว้ในตัวแปร (zsh มี `HOST` เป็นตัวแปรพิเศษอยู่แล้ว จึงใช้ `HK_HOST`):

```sh
HK_HOST=harnkan.example.com
cloudflared tunnel --config ~/.cloudflared/harnkan-config.yml login
cloudflared tunnel --config ~/.cloudflared/harnkan-config.yml create harnkan
cloudflared tunnel --config ~/.cloudflared/harnkan-config.yml list
```

จด UUID ของ tunnel ชื่อ `harnkan` จากคำสั่ง list แล้ว:

```sh
HK_UUID=00000000-0000-0000-0000-000000000000
sed -e "s#<TUNNEL_UUID>#$HK_UUID#g" -e "s#__HOME__#$HOME#g" -e "s#harnkan.example.com#$HK_HOST#g" ~/services/harnkan/deploy/cloudflared-harnkan.example.yml > ~/.cloudflared/harnkan-config.yml
cloudflared tunnel --config ~/.cloudflared/harnkan-config.yml ingress validate
cloudflared tunnel --config ~/.cloudflared/harnkan-config.yml route dns --overwrite-dns "$HK_UUID" "$HK_HOST"
```

ingress ใช้ `http://127.0.0.1:8787` (ไม่ใช่ `localhost`) · เปิดเฉพาะ `/webhook /healthz /qr/ /app/ /api/ /domain/` ที่เหลือ 404

ติดตั้ง launchd ให้ tunnel รันตลอด:

```sh
CF_BIN=$(command -v cloudflared)
sed -e "s#__HOME__#$HOME#g" -e "s#__CLOUDFLARED__#$CF_BIN#g" -e "s#__TUNNEL_UUID__#$HK_UUID#g" ~/services/harnkan/deploy/com.harnkan.tunnel.plist > ~/Library/LaunchAgents/com.harnkan.tunnel.plist
plutil -lint ~/Library/LaunchAgents/com.harnkan.tunnel.plist
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.harnkan.tunnel.plist
tail -n 20 ~/data/harnkan/logs/tunnel.log
```

ตรวจจากภายนอก (ผลที่ถูก: healthz = JSON · `/` = 404 · GET `/webhook` = 404 · POST `/webhook` ไม่มีลายเซ็น = 401):

```sh
curl -sS "https://$HK_HOST/healthz"
curl -sS -o /dev/null -w "%{http_code}\n" "https://$HK_HOST/"
curl -sS -o /dev/null -w "%{http_code}\n" "https://$HK_HOST/webhook"
curl -sS -o /dev/null -w "%{http_code}\n" -X POST -d "{}" "https://$HK_HOST/webhook"
```

ถ้า healthz ไม่ใช่ JSON ของ harnkan (เช่นได้หน้าของบริการอื่น) = DNS ผูกผิด tunnel → รัน `route dns --overwrite-dns` ด้านบนอีกครั้ง

## 5. อัปเดตเวอร์ชัน

```sh
bash ~/services/harnkan/deploy/update.sh
```

สคริปต์จด commit ก่อนอัปเดตไว้ที่ `~/data/harnkan/last-good-commit` → **สำรอง DB ก่อน git pull** (`npm run job:backup` ไม่ migrate · สำรองล้ม = หยุด ยังไม่แตะโค้ดและ schema) → git pull → **exec update.sh รุ่นที่เพิ่ง pull** (ขั้นที่เพิ่มในรุ่นใหม่จึงทำงานตั้งแต่รอบนี้) → npm ci → migrate → restart bot → เช็ค healthz

ไฟล์สำรองตั้งชื่อเป็นเวลาไทย เช่น `harnkan-20260930-015035+07.db.gz` (ไฟล์ก่อน B18 ไม่มี `+07` และเป็นเวลา UTC) · เรียงหาล่าสุดด้วย `ls -1t` (ตามเวลาไฟล์) ได้ทั้งสองแบบ

migration ทุกตัวเป็นแบบเพิ่มอย่างเดียว (ADD COLUMN) · ถ้า migrate แล้วมีปัญหา กู้ DB จากไฟล์สำรองล่าสุดตามข้อ 8

## 6. ตรวจว่าระบบยังมีชีวิต

```sh
curl -fsS http://127.0.0.1:8787/healthz
```

- `stale: true` = ไม่มีรายการใหม่เกิน 3 วัน หรือไม่ได้สรุปยอดตั้งแต่ 2 คืนขึ้นไป (ดู `reasons`)
- `mode: "fake"` บน M4 = ลืมตั้ง `FAKE_LINE=0 FAKE_AI=0`
- ตั้ง uptime monitor ให้เรียก `https://<โดเมน>/healthz` แล้วแจ้งเตือนเมื่อ `stale` เป็น true

## 7. ปิดระบบชั่วคราว (ไม่ลบโค้ด ไม่ลบข้อมูล)

```sh
for l in bot summary backup retention tunnel; do launchctl bootout "gui/$(id -u)/com.harnkan.$l"; done
launchctl list | grep harnkan
```

ถ้าเจอ error ว่าไม่พบ service แปลว่าปิดอยู่แล้ว · ปิดแค่ harnkan ไม่แตะ tunnel/cloudflared ของบริการอื่น

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
for j in bot summary backup retention; do launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.harnkan.$j.plist; done
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

## แก้ปัญหาที่เจอบ่อย

### หลัง deploy mini app ในมือถือยังเป็นหน้าเก่า

ตั้งแต่ B18 server ใส่ `?v=<เวอร์ชัน>` ให้ไฟล์ JS/CSS ทุกตัว และแอปเทียบเวอร์ชันกับ `/app/config.json` แล้ว reload เอง 1 ครั้ง · ถ้ายังเก่า:

```sh
curl -sS "https://$HK_HOST/app/config.json"
curl -sS "https://$HK_HOST/app/" | grep -o 'harnkan-version" content="[0-9a-f]*'
```

สองค่าต้องตรงกัน · ถ้าไม่ตรง = Cloudflare แคช index ไว้ → Cloudflare dashboard → Caching → Purge `/app/*` · ในมือถือ ปิดหน้าแอปแล้วเปิดจาก LINE ใหม่

### LINE บน Mac เปิดแอปใน Chrome แล้วขึ้น "เข้าสู่ระบบไม่สำเร็จ"

LINE desktop เปิดลิงก์ LIFF ในเบราว์เซอร์ข้างนอก · ID token ของ LIFF หมดอายุราว 1 ชม. แต่สถานะล็อกอินอยู่ได้นาน · ตั้งแต่ B18 แอปตรวจอายุ token เองแล้ว logout + login ใหม่ 1 ครั้ง ("เซสชันหมดอายุ กำลังเข้าสู่ระบบใหม่…") · ถ้ายังไม่ได้ดู log:

```sh
grep auth_fail ~/data/harnkan/logs/harnkan.log | tail -n 5
```

`reason` บอกสาเหตุ (ไม่มี token ใน log): `expired` = token หมดอายุ (ปิดแท็บแล้วเปิดใหม่จาก LINE) · `bad_aud` = LIFF อยู่คนละ channel กับ `LIFF_CHANNEL_ID` ใน .env · `invalid` = token เสีย · `unreachable` = ต่อ LINE ไม่ได้ · `missing` = ไม่ได้ส่ง token

