#!/bin/bash
# อัปเดตบน M4: สำรอง DB → git pull → รันสคริปต์ตัวใหม่ (exec ครั้งเดียว) → npm ci → migrate → restart bot → เช็ค healthz
# ใช้: bash ~/services/harnkan/deploy/update.sh
#
# ทำไมต้อง exec: git pull เขียน update.sh ใหม่ แต่ bash ที่รันอยู่ยังใช้เนื้อหาเดิม ขั้นที่เพิ่มในรุ่นใหม่จะไม่ถูกรัน (เกิดจริงตอน deploy B17)
# ทำไมอยู่ใน main(): bash อ่านทั้งฟังก์ชันก่อนรัน ไฟล์ถูกเขียนทับระหว่างทางก็ไม่อ่านเนื้อหาปน
set -euo pipefail

main() {
  local APP="$HOME/services/harnkan"
  local DATA="$HOME/data/harnkan"
  cd "$APP"

  if [ -z "${HARNKAN_UPDATE_REEXEC:-}" ]; then
    local PREV
    PREV=$(git rev-parse HEAD)
    echo "ก่อนอัปเดต: $PREV"
    echo "$PREV" > "$DATA/last-good-commit"
    echo "สำรอง DB ก่อน git pull (ล้ม = หยุด ยังไม่แตะโค้ดและ schema)"
    npm run -s job:backup
    git pull --ff-only
    echo "รัน update.sh รุ่นที่เพิ่ง pull"
    HARNKAN_UPDATE_REEXEC=1 exec bash "$APP/deploy/update.sh"
  fi

  npm ci --omit=dev
  npm run -s migrate

  launchctl kickstart -k "gui/$(id -u)/com.harnkan.bot"
  sleep 3
  curl -fsS http://127.0.0.1:8787/healthz
  echo
  echo "อัปเดตเป็น $(git rev-parse HEAD) แล้ว · ถ้ามีปัญหาดู rollback ใน docs/DEPLOY.md"
}

main "$@"
exit
