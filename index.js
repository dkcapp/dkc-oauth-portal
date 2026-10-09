// DKC OAuth Portal — Cloudflare Worker (backend + หน้าเว็บในไฟล์เดียว)
// หน้าเว็บทั้งหมดอยู่ใน app.html (import เป็น text ตอน build)
import page from "./app.html";

const enc = new TextEncoder();

// field id ของฟอร์ม JotForm บริษัท (231301336713444)
const JF = { first: "110", last: "111", type: "17", course: "93" };

// ---------- Session (signed cookie, HMAC-SHA256) ----------
async function importKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
}

function bytesToB64Url(bytes) {
  let bin = "";
  bytes.forEach((b) => {
    bin += String.fromCharCode(b);
  });
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(payload, secret) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  return bytesToB64Url(new Uint8Array(sig));
}

async function createSession(obj, secret) {
  const payload = bytesToB64Url(enc.encode(JSON.stringify(obj)));
  return `${payload}.${await sign(payload, secret)}`;
}

async function readSession(value, secret) {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (signature !== (await sign(payload, secret))) return null;
  try {
    let b64 = payload.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4) b64 += "=";
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return null;
  }
}

// ---------- Cookie ----------
function getCookie(request, name) {
  const header = request.headers.get("Cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch (e) {
        return null;
      }
    }
  }
  return null;
}

function setCookie(name, value, o = {}) {
  let c = `${name}=${encodeURIComponent(value)}`;
  if (o.maxAge !== undefined) c += `; Max-Age=${o.maxAge}`;
  if (o.httpOnly) c += "; HttpOnly";
  if (o.secure) c += "; Secure";
  if (o.sameSite) c += `; SameSite=${o.sameSite}`;
  if (o.path) c += `; Path=${o.path}`;
  return c;
}

// ---------- Helpers ----------
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function escapeHtml(v) {
  return String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
}

function requireAuth(request, env) {
  return readSession(getCookie(request, "dkc_session"), env.SESSION_SECRET);
}

// เทียบสตริงแบบ constant-time (ใช้กับ secret key)
function safeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  const len = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < len; i++)
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  return diff === 0;
}

// อนุญาต redirect หลังล็อกอินเฉพาะหน้าแรก (/ หรือ /?query) กัน open redirect
function validNext(n) {
  return (
    typeof n === "string" &&
    n.length <= 1500 &&
    /^\/(\?[A-Za-z0-9\-._~%=&+*,:;@!$'()/?]*)?$/.test(n)
  );
}

const clip = (v, n) =>
  String(v ?? "")
    .trim()
    .slice(0, n);

// ส่งต่อ JSON ไป API ภายนอก แล้วคืนผลกลับเป็น Response (กันกรณีปลายทางไม่ตอบเป็น JSON)
async function forward(url, payload) {
  const r = await callJson(url, payload);
  if (r.data === null)
    return json({ error: "Invalid response from upstream" }, 502);
  return json(r.data, r.status);
}

// เรียก API ภายนอกแบบ JSON คืน { status, data } (data = null ถ้าไม่ใช่ JSON)
async function callJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try {
    return { status: res.status, data: JSON.parse(text) };
  } catch (e) {
    console.error("Upstream non-JSON response:", res.status);
    return { status: 502, data: null };
  }
}

const isOkResp = (r) =>
  !!r && (r.success === true || r.status === "success") && !!r.data;

// อนุมัติ / ปฏิเสธ / รอดำเนินการ
function statusKind(s) {
  const u = String(s || "").toUpperCase();
  if (u.startsWith("APPROVE")) return "approved";
  if (u.startsWith("REJECT")) return "rejected";
  return "pending";
}

const statusUrl = (env) =>
  env.CAS_REQ_STATUS_URL || `${env.OAUTH_BASE_URI}/api/cas/reqstat`;

// ถาม CAS ว่าสถานะจริงคืออะไร (คืน null ถ้าถามไม่สำเร็จ)
async function fetchCasStatus(env, refId) {
  try {
    const r = await callJson(statusUrl(env), {
      client_id: env.OAUTH_CLIENT_ID,
      ExternalRefID: refId,
    });
    if (r.status !== 200 || !r.data) return null;
    const d = r.data.data || r.data;
    return d && d.Status ? d : null;
  } catch (e) {
    console.error("Error verifying CAS status:", e);
    return null;
  }
}

async function saveStatus(env, refId, d) {
  await env.DB.prepare(
    `UPDATE approval_requests
        SET status = ?, approve_step = ?, approver_ad = COALESCE(?, approver_ad), updated_at = datetime('now')
      WHERE external_ref_id = ?`,
  )
    .bind(
      String(d.Status || "PENDING").toUpperCase(),
      d.ApproveStep != null ? String(d.ApproveStep) : null,
      d.Approver_ADUser || null,
      refId,
    )
    .run();
}

const ansText = (a) => {
  const v = a && a.answer;
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ").trim();
  if (typeof v === "object") return Object.values(v).join(" ").trim();
  return String(v).trim();
};

// ---------- Main ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { headers: CORS });

    try {
      // หน้าเว็บ
      if (
        (method === "GET" || method === "HEAD") &&
        ["/", "/index.html", "/dashboard.html", "/app.html"].includes(path)
      ) {
        return new Response(page, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      // GET /auth/login?next=/?section=approval&sid=...
      if (path === "/auth/login" && method === "GET") {
        const state = crypto.randomUUID().replace(/-/g, "");
        const authorizeUrl = new URL(`${env.OAUTH_BASE_URI}/oauth/authorize`);
        authorizeUrl.searchParams.set("client_id", env.OAUTH_CLIENT_ID);
        authorizeUrl.searchParams.set("redirect_uri", env.OAUTH_REDIRECT_URI);
        authorizeUrl.searchParams.set("response_type", "code");
        authorizeUrl.searchParams.set("state", state);

        const cookieOpts = {
          httpOnly: true,
          secure: url.protocol === "https:",
          sameSite: "Lax",
          maxAge: 600,
          path: "/",
        };
        const headers = new Headers();
        headers.set("Location", authorizeUrl.toString());
        headers.append(
          "Set-Cookie",
          setCookie("oauth_state", state, cookieOpts),
        );
        const next = url.searchParams.get("next");
        if (validNext(next))
          headers.append(
            "Set-Cookie",
            setCookie("oauth_next", next, cookieOpts),
          );
        return new Response(null, { status: 302, headers });
      }

      // GET /auth/callback
      if (path === "/auth/callback" && method === "GET") {
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const savedState = getCookie(request, "oauth_state");
        if (!code || !state || state !== savedState) {
          return new Response("Invalid state parameter", { status: 400 });
        }

        const tokenRes = await fetch(`${env.OAUTH_BASE_URI}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "authorization_code",
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
            redirect_uri: env.OAUTH_REDIRECT_URI,
            code,
          }),
        });
        if (!tokenRes.ok) throw new Error("Failed to obtain access token");
        const tokenData = await tokenRes.json();

        const userRes = await fetch(`${env.OAUTH_BASE_URI}/api/user`, {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/json",
          },
        });
        if (!userRes.ok) throw new Error("Failed to fetch user profile");
        const userData = await userRes.json();

        const sessionValue = await createSession(
          { user: userData, access_token: tokenData.access_token },
          env.SESSION_SECRET,
        );

        const savedNext = getCookie(request, "oauth_next");
        const next = validNext(savedNext) ? savedNext : "/";

        const headers = new Headers();
        headers.set("Location", `${env.APP_URL}${next}`);
        headers.append(
          "Set-Cookie",
          setCookie("oauth_state", "", { maxAge: 0, path: "/" }),
        );
        headers.append(
          "Set-Cookie",
          setCookie("oauth_next", "", { maxAge: 0, path: "/" }),
        );
        headers.append(
          "Set-Cookie",
          setCookie("dkc_session", sessionValue, {
            httpOnly: true,
            secure: url.protocol === "https:",
            sameSite: "Lax",
            maxAge: 8 * 60 * 60,
            path: "/",
          }),
        );
        return new Response(null, { status: 302, headers });
      }

      // GET /auth/me
      if (path === "/auth/me" && method === "GET") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        return json(session.user);
      }

      // GET /auth/logout
      if (path === "/auth/logout" && method === "GET") {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${env.OAUTH_BASE_URI}/logout?redirect_url=${encodeURIComponent(env.APP_URL + "/")}`,
            "Set-Cookie": setCookie("dkc_session", "", {
              maxAge: 0,
              path: "/",
            }),
          },
        });
      }

      // POST /api/send-message
      if (path === "/api/send-message" && method === "POST") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const body = await request.json();
        return forward(`${env.OAUTH_BASE_URI}/api/send-message`, {
          ...body,
          app_name: env.MSG_APP_NAME,
          client_id: env.OAUTH_CLIENT_ID,
          client_secret: env.OAUTH_CLIENT_SECRET,
        });
      }

      // GET /api/prefill?sid=...  ดึงข้อมูลผู้สมัครจาก JotForm ตาม Submission ID (ต้อง login)
      if (path === "/api/prefill" && method === "GET") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const sid = (url.searchParams.get("sid") || "").trim();
        if (!/^\d{8,25}$/.test(sid)) return json({ error: "Invalid sid" }, 400);
        if (!env.JOTFORM_API_KEY)
          return json({ error: "Prefill not configured" }, 503);

        const base = env.JOTFORM_API_BASE || "https://api.jotform.com";
        const res = await fetch(`${base}/submission/${sid}`, {
          headers: { APIKEY: env.JOTFORM_API_KEY },
        });
        if (!res.ok) return json({ error: "Submission not found" }, 404);
        const sub = (await res.json()).content;
        if (!sub || String(sub.form_id) !== String(env.JOTFORM_FORM_ID)) {
          return json({ error: "Submission not found" }, 404);
        }
        const a = sub.answers || {};
        return json({
          sid,
          applicant_name:
            `${ansText(a[JF.first])} ${ansText(a[JF.last])}`.trim(),
          course: ansText(a[JF.course]),
          member_type: ansText(a[JF.type]),
        });
      }

      // POST /api/cas/request
      if (path === "/api/cas/request" && method === "POST") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const body = await request.json();

        const ref = clip(body.ExternalRefID, 100);
        const approveType = Number(body.ApproveType) === 2 ? 2 : 1;
        const subject = clip(body.MsgSubject, 200);
        const message = clip(body.MsgForHead, 2000);
        if (!ref || !subject || !message)
          return json(
            { error: "ข้อมูลไม่ครบ (รหัสอ้างอิง/หัวข้อ/ข้อความ)" },
            400,
          );

        const me = session.user.username;

        // กันส่งซ้ำ: รหัสนี้มีแล้ว → ของเราแสดงของเดิม / ของคนอื่นปฏิเสธ
        const existing = await env.DB.prepare(
          "SELECT requester_ad, cas_data FROM approval_requests WHERE external_ref_id = ?",
        )
          .bind(ref)
          .first();
        if (existing) {
          if (existing.requester_ad !== me)
            return json({ error: "รหัสอ้างอิงนี้ถูกใช้แล้ว" }, 409);
          let data = {};
          try {
            data = JSON.parse(existing.cas_data || "{}");
          } catch (e) {
            /* ใช้ค่าว่าง */
          }
          return json({ success: true, duplicate: true, data });
        }

        const r = await callJson(
          env.CAS_REQUEST_URL || `${env.OAUTH_BASE_URI}/api/cas/request`,
          {
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
            ExternalRefID: ref,
            ApproveType: approveType,
            MsgSubject: subject,
            MsgForHead: message,
            Requester_ADUser: me,
            CallbackURL: `${env.APP_URL}/api/cas/callback`,
          },
        );
        if (r.data === null)
          return json({ error: "Invalid response from upstream" }, 502);

        // บันทึกลง D1 เฉพาะเมื่อ CAS ตอบรับสำเร็จ
        if (isOkResp(r.data)) {
          const d = r.data.data;
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO approval_requests
                 (external_ref_id, requester_ad, requester_name, applicant_name, course, member_type, jotform_sid,
                  approve_type, subject, message, request_key, approver_ad, approver_name, cas_data, status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'PENDING')`,
            )
              .bind(
                ref,
                me,
                clip(session.user.display_name || session.user.name, 200) ||
                  null,
                clip(body.applicant_name, 200) || null,
                clip(body.course, 300) || null,
                clip(body.member_type, 200) || null,
                clip(body.jotform_sid, 40) || null,
                approveType,
                subject,
                message,
                clip(d.RequestKey, 100) || null,
                clip(d.ADApprover, 100) || null,
                clip(d.HeadFullName, 200) || null,
                JSON.stringify(d),
              )
              .run();
          } catch (e) {
            console.error("D1 insert failed (CAS request already sent):", e);
          }
        }
        return json(r.data, r.status);
      }

      // POST /api/cas/status  (ดูได้เฉพาะคำขอของตัวเอง)
      if (path === "/api/cas/status" && method === "POST") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const body = await request.json();
        const ref = clip(body.ExternalRefID, 100);
        if (!ref) return json({ error: "กรุณาระบุรหัสอ้างอิง" }, 400);

        const row = await env.DB.prepare(
          "SELECT requester_ad FROM approval_requests WHERE external_ref_id = ?",
        )
          .bind(ref)
          .first();
        if (!row || row.requester_ad !== session.user.username) {
          return json({ error: "ไม่พบคำขอนี้ในประวัติของคุณ" }, 404);
        }

        const r = await callJson(statusUrl(env), {
          client_id: env.OAUTH_CLIENT_ID,
          ExternalRefID: ref,
        });
        if (r.data === null)
          return json({ error: "Invalid response from upstream" }, 502);
        if (isOkResp(r.data) && r.data.data.Status) {
          try {
            await saveStatus(env, ref, r.data.data);
          } catch (e) {
            console.error("D1 update failed:", e);
          }
        }
        return json(r.data, r.status);
      }

      // GET /api/cas/history  ประวัติคำขอของผู้ล็อกอิน
      if (path === "/api/cas/history" && method === "GET") {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: "Unauthorized" }, 401);
        const { results } = await env.DB.prepare(
          `SELECT external_ref_id, subject, applicant_name, course, approve_type, status, approve_step,
                  approver_name, created_at, updated_at
             FROM approval_requests
            WHERE requester_ad = ?
            ORDER BY created_at DESC
            LIMIT 100`,
        )
          .bind(session.user.username)
          .all();
        return json({ items: results || [] });
      }

      // GET /api/admin/requests  (สำหรับเว็บใบประกาศ เรียกแบบ server-to-server ด้วย secret)
      if (path === "/api/admin/requests" && method === "GET") {
        const key = env.ADMIN_API_KEY;
        if (!key || key.length < 16)
          return json({ error: "Not configured" }, 503);
        if (
          !safeEqual(
            request.headers.get("Authorization") || "",
            `Bearer ${key}`,
          )
        ) {
          return json({ error: "Unauthorized" }, 401);
        }

        const pageNo = Math.max(
          1,
          parseInt(url.searchParams.get("page") || "1", 10) || 1,
        );
        const perPage = Math.min(
          100,
          Math.max(
            1,
            parseInt(url.searchParams.get("per_page") || "20", 10) || 20,
          ),
        );
        const kind = url.searchParams.get("status") || "";
        const q = clip(url.searchParams.get("q"), 100);

        const where = [];
        const params = [];
        if (kind === "approved") where.push("UPPER(status) LIKE 'APPROVE%'");
        else if (kind === "rejected")
          where.push("UPPER(status) LIKE 'REJECT%'");
        else if (kind === "pending")
          where.push(
            "UPPER(status) NOT LIKE 'APPROVE%' AND UPPER(status) NOT LIKE 'REJECT%'",
          );
        if (q) {
          where.push(`(external_ref_id LIKE ? OR requester_ad LIKE ? OR requester_name LIKE ?
                       OR applicant_name LIKE ? OR course LIKE ? OR subject LIKE ?)`);
          for (let i = 0; i < 6; i++) params.push(`%${q}%`);
        }
        const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

        const [list, count, sum] = await env.DB.batch([
          env.DB.prepare(
            `SELECT external_ref_id, requester_ad, requester_name, applicant_name, course, member_type,
                    approve_type, subject, approver_ad, approver_name, status, approve_step, created_at, updated_at
               FROM approval_requests ${whereSql}
              ORDER BY created_at DESC LIMIT ? OFFSET ?`,
          ).bind(...params, perPage, (pageNo - 1) * perPage),
          env.DB.prepare(
            `SELECT COUNT(*) AS n FROM approval_requests ${whereSql}`,
          ).bind(...params),
          env.DB.prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN UPPER(status) LIKE 'APPROVE%' THEN 1 ELSE 0 END), 0) AS approved,
                    COALESCE(SUM(CASE WHEN UPPER(status) LIKE 'REJECT%' THEN 1 ELSE 0 END), 0) AS rejected
               FROM approval_requests`,
          ),
        ]);

        const s = sum.results[0] || { total: 0, approved: 0, rejected: 0 };
        return json({
          items: list.results || [],
          total: count.results[0] ? count.results[0].n : 0,
          page: pageNo,
          per_page: perPage,
          summary: {
            total: s.total,
            approved: s.approved,
            rejected: s.rejected,
            pending: s.total - s.approved - s.rejected,
          },
        });
      }

      // GET /api/cas/callback (เรียกจากระบบ CAS ภายนอก ไม่ต้อง login)
      if (path === "/api/cas/callback" && method === "GET") {
        const refId = url.searchParams.get("ExternalRefID");

        // ใช้สถานะจริงจาก CAS เท่านั้น ไม่เชื่อค่า status ใน query string (ปลอมได้)
        const d = refId ? await fetchCasStatus(env, refId) : null;
        if (d) {
          try {
            await saveStatus(env, refId, d);
          } catch (e) {
            console.error("D1 update failed:", e);
          }
        }

        const kind = d ? statusKind(d.Status) : "unknown";
        const view = {
          approved: ["#22c55e", "อนุมัติเรียบร้อยแล้ว"],
          rejected: ["#ef4444", "ปฏิเสธการอนุมัติ"],
          pending: ["#f59e0b", "บันทึกผลแล้ว รอการอนุมัติขั้นถัดไป"],
          unknown: ["#6b7280", "ไม่สามารถยืนยันสถานะได้ในขณะนี้"],
        }[kind];

        const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ผลการดำเนินการ</title>
  <style>
    body { font-family: 'Sarabun', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f3f4f6; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
    h1 { color: ${view[0]}; margin-bottom: 1rem; font-size: 1.5rem; }
    p { color: #4b5563; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${view[1]}</h1>
    <p>รหัสอ้างอิง: ${escapeHtml(refId)}</p>
    <p>ท่านสามารถปิดหน้านี้ได้ทันที</p>
  </div>
</body>
</html>`;
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
          },
        });
      }

      return new Response("Not Found", { status: 404 });
    } catch (error) {
      console.error("API Error:", error);
      return json({ error: "Internal Server Error" }, 500);
    }
  },
};
