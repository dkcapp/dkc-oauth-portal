-- DKC Portal: ประวัติคำขออนุมัติ (Cloudflare D1 / SQLite)
-- รันครั้งเดียว: npx wrangler d1 execute dkc-portal-db --remote --file=./schema.sql

CREATE TABLE IF NOT EXISTS approval_requests (
  external_ref_id TEXT PRIMARY KEY,          -- Submission ID ของ JotForm (หรือรหัสที่ผู้ใช้กรอก)
  requester_ad    TEXT NOT NULL,             -- AD username ของผู้ล็อกอินที่ส่งคำขอ
  requester_name  TEXT,
  applicant_name  TEXT,                      -- ชื่อผู้สมัครจากฟอร์ม
  course          TEXT,                      -- หลักสูตรที่สมัคร
  member_type     TEXT,                      -- ประเภทสมาชิกองค์กร
  jotform_sid     TEXT,
  approve_type    INTEGER NOT NULL DEFAULT 1, -- 1 = หัวหน้ากอง, 2 = หัวหน้ากอง + หัวหน้าสำนัก
  subject         TEXT NOT NULL,
  message         TEXT,
  request_key     TEXT,
  approver_ad     TEXT,
  approver_name   TEXT,
  cas_data        TEXT,                      -- JSON ที่ CAS ตอบกลับตอนสร้างคำขอ
  status          TEXT NOT NULL DEFAULT 'PENDING',
  approve_step    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),  -- UTC
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))   -- UTC
);

CREATE INDEX IF NOT EXISTS idx_ar_requester ON approval_requests (requester_ad, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_created   ON approval_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ar_status    ON approval_requests (status);