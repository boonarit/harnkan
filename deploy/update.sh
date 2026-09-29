#!/bin/bash
# อัปเดตบน M4: git pull → npm ci → migrate → restart bot → เช็ค healthz
# ใช้: bash ~/services/harnkan/deploy/update.sh
set -euo pipefail

APP="$HOME/services/harnkan"
cd "$APP"

PREV=$(git rev-parse HEAD)
echo "ก่อนอัปเดต: $PREV"
echo "$PREV" > "$HOME/data/harnkan/last-good-commit"

git pull --ff-only
npm ci --omit=dev
npm run -s migrate

launchctl kickstart -k "gui/$(id -u)/com.harnkan.bot"
sleep 3
curl -fsS http://127.0.0.1:8787/healthz
echo
echo "อัปเดตเป็น $(git rev-parse HEAD) แล้ว · ถ้ามีปัญหาดู rollback ใน docs/DEPLOY.md"
