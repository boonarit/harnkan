# ADR 002 · SQLite (node:sqlite) แทน Postgres

**สถานะ:** ใช้อยู่ · 2026-09

## บริบท
ผู้ใช้ 1 คู่ (หรือไม่กี่คู่) · รันบน Mac mini (M4) เครื่องเดียว · ต้องการ dependency น้อยที่สุดและดูแลง่าย

## ตัดสินใจ
- ใช้ `node:sqlite` ที่มากับ Node 22 (ไม่ต้องติดตั้ง driver) · WAL + foreign keys + busy_timeout
- migrations เป็นลำดับเลขใน `user_version` · เพิ่มท้ายเท่านั้น
- สำรองด้วย `VACUUM INTO` + gzip ทุกคืน

## ผลที่ตามมา
- ไม่มี server DB ให้ดูแล · สำรอง = คัดลอกไฟล์เดียว
- เขียนพร้อมกันได้ทีละ process (bot + job ใช้ busy_timeout) — พอสำหรับขนาดนี้
- ถ้าวันหนึ่งมีผู้ใช้หลายพันคู่ ค่อยย้าย (Repo เป็นชั้นเดียวที่แตะ SQL)
- `node:sqlite` ยังเป็น experimental ใน Node 22 → ต้องใช้ flag `--experimental-sqlite`
