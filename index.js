// DKC OAuth Portal — Cloudflare Worker (backend + หน้าเว็บในไฟล์เดียว)
// หน้าเว็บทั้งหมดอยู่ใน app.html (import เป็น text ตอน build)
import page from './app.html';

const enc = new TextEncoder();

// ---------- Session (signed cookie, HMAC-SHA256) ----------
async function importKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function bytesToB64Url(bytes) {
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sign(payload, secret) {
  const key = await importKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return bytesToB64Url(new Uint8Array(sig));
}

async function createSession(obj, secret) {
  const payload = bytesToB64Url(enc.encode(JSON.stringify(obj)));
  return `${payload}.${await sign(payload, secret)}`;
}

async function readSession(value, secret) {
  if (!value) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  if (signature !== (await sign(payload, secret))) return null;
  try {
    let b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
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
  const header = request.headers.get('Cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch (e) { return null; }
    }
  }
  return null;
}

function setCookie(name, value, o = {}) {
  let c = `${name}=${encodeURIComponent(value)}`;
  if (o.maxAge !== undefined) c += `; Max-Age=${o.maxAge}`;
  if (o.httpOnly) c += '; HttpOnly';
  if (o.secure) c += '; Secure';
  if (o.sameSite) c += `; SameSite=${o.sameSite}`;
  if (o.path) c += `; Path=${o.path}`;
  return c;
}

// ---------- Helpers ----------
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function requireAuth(request, env) {
  return readSession(getCookie(request, 'dkc_session'), env.SESSION_SECRET);
}

// ส่งต่อ JSON ไป API ภายนอก แล้วคืนผลกลับ (กันกรณีปลายทางไม่ตอบเป็น JSON)
async function forward(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  try {
    return json(JSON.parse(text), res.status);
  } catch (e) {
    console.error('Upstream non-JSON response:', res.status);
    return json({ error: 'Invalid response from upstream' }, 502);
  }
}

const isApproved = (s) => /^approve/i.test(String(s || ''));

// ---------- Main ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    if (method === 'OPTIONS') return new Response(null, { headers: CORS });

    try {
      // หน้าเว็บ
      if ((method === 'GET' || method === 'HEAD') &&
          ['/', '/index.html', '/dashboard.html', '/app.html'].includes(path)) {
        return new Response(page, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }

      // GET /auth/login
      if (path === '/auth/login' && method === 'GET') {
        const state = crypto.randomUUID().replace(/-/g, '');
        const authorizeUrl = new URL(`${env.OAUTH_BASE_URI}/oauth/authorize`);
        authorizeUrl.searchParams.set('client_id', env.OAUTH_CLIENT_ID);
        authorizeUrl.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('state', state);
        return new Response(null, {
          status: 302,
          headers: {
            Location: authorizeUrl.toString(),
            'Set-Cookie': setCookie('oauth_state', state, {
              httpOnly: true, secure: url.protocol === 'https:', sameSite: 'Lax', maxAge: 600, path: '/',
            }),
          },
        });
      }

      // GET /auth/callback
      if (path === '/auth/callback' && method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const savedState = getCookie(request, 'oauth_state');
        if (!code || !state || state !== savedState) {
          return new Response('Invalid state parameter', { status: 400 });
        }

        const tokenRes = await fetch(`${env.OAUTH_BASE_URI}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
            redirect_uri: env.OAUTH_REDIRECT_URI,
            code,
          }),
        });
        if (!tokenRes.ok) throw new Error('Failed to obtain access token');
        const tokenData = await tokenRes.json();

        const userRes = await fetch(`${env.OAUTH_BASE_URI}/api/user`, {
          headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
        });
        if (!userRes.ok) throw new Error('Failed to fetch user profile');
        const userData = await userRes.json();

        const sessionValue = await createSession(
          { user: userData, access_token: tokenData.access_token },
          env.SESSION_SECRET
        );

        const headers = new Headers();
        headers.set('Location', `${env.APP_URL}/`);
        headers.append('Set-Cookie', setCookie('oauth_state', '', { maxAge: 0, path: '/' }));
        headers.append('Set-Cookie', setCookie('dkc_session', sessionValue, {
          httpOnly: true, secure: url.protocol === 'https:', sameSite: 'Lax', maxAge: 8 * 60 * 60, path: '/',
        }));
        return new Response(null, { status: 302, headers });
      }

      // GET /auth/me
      if (path === '/auth/me' && method === 'GET') {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: 'Unauthorized' }, 401);
        return json(session.user);
      }

      // GET /auth/logout
      if (path === '/auth/logout' && method === 'GET') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: `${env.OAUTH_BASE_URI}/logout?redirect_url=${encodeURIComponent(env.APP_URL + '/')}`,
            'Set-Cookie': setCookie('dkc_session', '', { maxAge: 0, path: '/' }),
          },
        });
      }

      // POST /api/send-message
      if (path === '/api/send-message' && method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        return forward(`${env.OAUTH_BASE_URI}/api/send-message`, {
          ...body,
          app_name: env.MSG_APP_NAME,
          client_id: env.OAUTH_CLIENT_ID,
          client_secret: env.OAUTH_CLIENT_SECRET,
        });
      }

      // POST /api/cas/request
      if (path === '/api/cas/request' && method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        return forward(env.CAS_REQUEST_URL || `${env.OAUTH_BASE_URI}/api/cas/request`, {
          client_id: env.OAUTH_CLIENT_ID,
          client_secret: env.OAUTH_CLIENT_SECRET,
          ExternalRefID: body.ExternalRefID,
          ApproveType: body.ApproveType,
          MsgSubject: body.MsgSubject,
          MsgForHead: body.MsgForHead,
          Requester_ADUser: session.user.username,
          CallbackURL: `${env.APP_URL}/api/cas/callback`,
        });
      }

      // POST /api/cas/status
      if (path === '/api/cas/status' && method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return json({ error: 'Unauthorized' }, 401);
        const body = await request.json();
        return forward(env.CAS_REQ_STATUS_URL || `${env.OAUTH_BASE_URI}/api/cas/reqstat`, {
          client_id: env.OAUTH_CLIENT_ID,
          ExternalRefID: body.ExternalRefID,
        });
      }

      // GET /api/cas/callback (เรียกจากระบบ CAS ภายนอก ไม่ต้อง login)
      if (path === '/api/cas/callback' && method === 'GET') {
        const refId = url.searchParams.get('ExternalRefID');
        let actualStatus = url.searchParams.get('status');

        try {
          const check = await fetch(env.CAS_REQ_STATUS_URL || `${env.OAUTH_BASE_URI}/api/cas/reqstat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ client_id: env.OAUTH_CLIENT_ID, ExternalRefID: refId }),
          });
          if (check.ok) {
            const data = await check.json();
            // โครงสร้างผลลัพธ์อาจเป็น data.Status หรือ data.data.Status
            const s = data.Status || (data.data && data.data.Status);
            if (s) actualStatus = s;
          }
        } catch (e) {
          console.error('Error verifying CAS status:', e);
        }

        const ok = isApproved(actualStatus);
        const color = ok ? '#22c55e' : '#ef4444';
        const text = ok ? 'อนุมัติเรียบร้อยแล้ว' : 'ปฏิเสธการอนุมัติ';

        const html = `<!DOCTYPE html>
<html lang="th">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ผลการดำเนินการ</title>
  <style>
    body { font-family: 'Sarabun', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f3f4f6; }
    .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); text-align: center; max-width: 400px; width: 100%; }
    h1 { color: ${color}; margin-bottom: 1rem; }
    p { color: #4b5563; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${text}</h1>
    <p>รหัสอ้างอิง: ${escapeHtml(refId)}</p>
    <p>ท่านสามารถปิดหน้านี้ได้ทันที</p>
  </div>
</body>
</html>`;
        return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }

      return new Response('Not Found', { status: 404 });
    } catch (error) {
      console.error('API Error:', error);
      return json({ error: 'Internal Server Error' }, 500);
    }
  },
};
