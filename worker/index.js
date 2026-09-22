import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
import manifestJSON from '__STATIC_CONTENT_MANIFEST';
const assetManifest = JSON.parse(manifestJSON);
// Cloudflare Worker สำหรับจัดการ OAuth, การส่งข้อความ และอนุมัติ CAS

const enc = new TextEncoder();

// ฟังก์ชันสร้างคีย์สำหรับเข้ารหัส
async function importKey(secret) {
  return await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

// ฟังก์ชันสร้างลายเซ็นดิจิทัล
async function sign(payload, secret) {
  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  // ใช้ base64url เพื่อความปลอดภัยใน cookie
  return btoa(String.fromCharCode(...new Uint8Array(signature)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ฟังก์ชันแปลง string (รองรับ UTF-8) เป็น base64url
function utf8ToBase64Url(str) {
  const bytes = enc.encode(str);
  let binary = '';
  bytes.forEach((b) => { binary += String.fromCharCode(b); });
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ฟังก์ชันสร้าง Session Cookie Value
async function createSession(payloadObj, secret) {
  const payloadStr = utf8ToBase64Url(JSON.stringify(payloadObj));
  const signature = await sign(payloadStr, secret);
  return `${payloadStr}.${signature}`;
}

// ฟังก์ชันอ่านและตรวจสอบ Session
async function readSession(cookieValue, secret) {
  if (!cookieValue) return null;
  const parts = cookieValue.split('.');
  if (parts.length !== 2) return null;
  
  const [payloadStr, signature] = parts;
  const expectedSignature = await sign(payloadStr, secret);
  
  if (signature !== expectedSignature) return null; // ลายเซ็นไม่ตรง
  
  try {
    let base64 = payloadStr.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) base64 += '=';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const decoder = new TextDecoder();
    return JSON.parse(decoder.decode(bytes));
  } catch (e) {
    return null;
  }
}

// ฟังก์ชันอ่าน Cookie
function getCookie(request, name) {
  const cookieString = request.headers.get('Cookie');
  if (!cookieString) return null;
  
  const cookies = cookieString.split(';');
  for (let cookie of cookies) {
    const [cookieName, cookieValue] = cookie.trim().split('=');
    if (cookieName === name) {
      return decodeURIComponent(cookieValue);
    }
  }
  return null;
}

// ฟังก์ชันกำหนดรูปแบบ Set-Cookie
function setCookie(name, value, options = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  if (options.maxAge) cookie += `; Max-Age=${options.maxAge}`;
  if (options.httpOnly) cookie += '; HttpOnly';
  if (options.secure) cookie += '; Secure';
  if (options.sameSite) cookie += `; SameSite=${options.sameSite}`;
  if (options.path) cookie += `; Path=${options.path}`;
  return cookie;
}

// Middleware สำหรับตรวจสอบสิทธิ์
async function requireAuth(request, env) {
  const sessionCookie = getCookie(request, 'dkc_session');
  if (!sessionCookie) {
    return null;
  }
  return await readSession(sessionCookie, env.SESSION_SECRET);
}

// จัดการ CORS
function handleCORS(request) {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    },
  });
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // จัดการ OPTIONS request สำหรับ CORS
    if (request.method === 'OPTIONS') {
      return handleCORS(request);
    }

    try {
      // 1. GET /auth/login
      if (path === '/auth/login' && request.method === 'GET') {
        const state = crypto.randomUUID().replace(/-/g, ''); // 32 chars hex
        
        const authorizeUrl = new URL(`${env.OAUTH_BASE_URI}/oauth/authorize`);
        authorizeUrl.searchParams.set('client_id', env.OAUTH_CLIENT_ID);
        authorizeUrl.searchParams.set('redirect_uri', env.OAUTH_REDIRECT_URI);
        authorizeUrl.searchParams.set('response_type', 'code');
        authorizeUrl.searchParams.set('state', state);

        const response = new Response(null, {
          status: 302,
          headers: {
            'Location': authorizeUrl.toString(),
            'Set-Cookie': setCookie('oauth_state', state, {
              httpOnly: true,
              secure: url.protocol === 'https:',
              sameSite: 'Lax',
              maxAge: 600,
              path: '/'
            })
          }
        });
        return response;
      }

      // 2. GET /auth/callback
      if (path === '/auth/callback' && request.method === 'GET') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const savedState = getCookie(request, 'oauth_state');

        if (!state || state !== savedState) {
          return new Response('Invalid state parameter', { status: 400 });
        }

        // แลกเปลี่ยน code เป็น access token
        const tokenResponse = await fetch(`${env.OAUTH_BASE_URI}/oauth/token`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
            redirect_uri: env.OAUTH_REDIRECT_URI,
            code: code
          })
        });

        if (!tokenResponse.ok) {
          throw new Error('Failed to obtain access token');
        }

        const tokenData = await tokenResponse.json();
        
        // ดึงข้อมูลผู้ใช้งาน
        const userResponse = await fetch(`${env.OAUTH_BASE_URI}/api/user`, {
          headers: {
            'Authorization': `Bearer ${tokenData.access_token}`,
            'Accept': 'application/json'
          }
        });

        if (!userResponse.ok) {
          throw new Error('Failed to fetch user profile');
        }

        const userData = await userResponse.json();
        
        // บันทึก session
        const sessionPayload = {
          user: userData,
          access_token: tokenData.access_token
        };
        
        const sessionCookieValue = await createSession(sessionPayload, env.SESSION_SECRET);

        const headers = new Headers();
        headers.set('Location', `${env.APP_URL}/dashboard.html`);
        headers.append('Set-Cookie', setCookie('oauth_state', '', { maxAge: 0, path: '/' }));
        headers.append('Set-Cookie', setCookie('dkc_session', sessionCookieValue, {
          httpOnly: true,
          secure: url.protocol === 'https:',
          sameSite: 'Lax',
          maxAge: 8 * 60 * 60,
          path: '/'
        }));
        const response = new Response(null, { status: 302, headers });
        return response;
      }

      // 3. GET /auth/me
      if (path === '/auth/me' && request.method === 'GET') {
        const session = await requireAuth(request, env);
        if (!session) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...corsHeaders() }
          });
        }
        return new Response(JSON.stringify(session.user), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 4. GET /auth/logout
      if (path === '/auth/logout' && request.method === 'GET') {
        const logoutUrl = `${env.OAUTH_BASE_URI}/logout?redirect_url=${encodeURIComponent(env.APP_URL + '/index.html')}`;
        const response = new Response(null, {
          status: 302,
          headers: {
            'Location': logoutUrl,
            'Set-Cookie': setCookie('dkc_session', '', { maxAge: 0, path: '/' })
          }
        });
        return response;
      }

      // 5. POST /api/send-message
      if (path === '/api/send-message' && request.method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return new Response('Unauthorized', { status: 401 });

        const body = await request.json();

        const requestPayload = {
          ...body,
          app_name: env.MSG_APP_NAME,
          client_id: env.OAUTH_CLIENT_ID,
          client_secret: env.OAUTH_CLIENT_SECRET
        };
        console.log('send-message request payload:', JSON.stringify(requestPayload));
        
        // ส่งต่อให้ API หลัก
        const externalResponse = await fetch(`${env.OAUTH_BASE_URI}/api/send-message`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestPayload)
        });

        const data = await externalResponse.json();
        console.log('send-message response:', externalResponse.status, JSON.stringify(data));
        return new Response(JSON.stringify(data), {
          status: externalResponse.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 6. POST /api/cas/request
      if (path === '/api/cas/request' && request.method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return new Response('Unauthorized', { status: 401 });

        const body = await request.json();
        const username = session.user.username; // หรือฟิลด์ที่เก็บ username จาก OAuth

        const casUrl = env.CAS_REQUEST_URL || `${env.OAUTH_BASE_URI}/api/cas/request`;
        
        const externalResponse = await fetch(casUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.OAUTH_CLIENT_ID,
            client_secret: env.OAUTH_CLIENT_SECRET,
            ExternalRefID: body.ExternalRefID,
            ApproveType: body.ApproveType,
            MsgSubject: body.MsgSubject,
            MsgForHead: body.MsgForHead,
            Requester_ADUser: username,
            CallbackURL: `${env.APP_URL}/api/cas/callback`
          })
        });

        const data = await externalResponse.json();
        return new Response(JSON.stringify(data), {
          status: externalResponse.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 7. POST /api/cas/status
      if (path === '/api/cas/status' && request.method === 'POST') {
        const session = await requireAuth(request, env);
        if (!session) return new Response('Unauthorized', { status: 401 });

        const body = await request.json();
        const casStatusUrl = env.CAS_REQ_STATUS_URL || `${env.OAUTH_BASE_URI}/api/cas/reqstat`;
        
        const externalResponse = await fetch(casStatusUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.OAUTH_CLIENT_ID,
            ExternalRefID: body.ExternalRefID
          })
        });

        const data = await externalResponse.json();
        return new Response(JSON.stringify(data), {
          status: externalResponse.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders() }
        });
      }

      // 8. GET /api/cas/callback
      if (path === '/api/cas/callback' && request.method === 'GET') {
        const status = url.searchParams.get('status');
        const refId = url.searchParams.get('ExternalRefID');
        
        // ดึงสถานะปัจจุบันเพื่อความมั่นใจ
        const casStatusUrl = env.CAS_REQ_STATUS_URL || `${env.OAUTH_BASE_URI}/api/cas/reqstat`;
        let actualStatus = status;
        
        try {
          const checkResponse = await fetch(casStatusUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              client_id: env.OAUTH_CLIENT_ID,
              ExternalRefID: refId
            })
          });
          if (checkResponse.ok) {
            const checkData = await checkResponse.json();
            if (checkData.Status) actualStatus = checkData.Status;
          }
        } catch(e) {
          console.error("Error verifying CAS status:", e);
        }

        const isApproved = actualStatus?.toLowerCase() === 'approved';
        const color = isApproved ? '#22c55e' : '#ef4444';
        const text = isApproved ? 'อนุมัติเรียบร้อยแล้ว' : 'ปฏิเสธการอนุมัติ';

        const html = `
          <!DOCTYPE html>
          <html lang="th">
          <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>ผลการดำเนินการ</title>
            <style>
              body { font-family: 'Sarabun', sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; background-color: #f3f4f6; }
              .card { background: white; padding: 2rem; border-radius: 8px; box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1); text-align: center; max-width: 400px; width: 100%; }
              h1 { color: ${color}; margin-bottom: 1rem; }
              p { color: #4b5563; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>${text}</h1>
              <p>รหัสอ้างอิง: ${refId}</p>
              <p>ท่านสามารถปิดหน้านี้ได้ทันที</p>
            </div>
          </body>
          </html>
        `;

        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }

      // 9. Static file serving (Fallback)
      try {
        return await getAssetFromKV(
          {
            request,
            waitUntil: (promise) => ctx.waitUntil(promise),
          },
          {
            ASSET_NAMESPACE: env.__STATIC_CONTENT,
            ASSET_MANIFEST: assetManifest,
          }
        );
      } catch (e) {
        console.error("Static Asset Error:", e);
        // If file not found, fall through to 404
        return new Response('Not Found', { status: 404 });
      }

    } catch (error) {
      console.error('API Error:', error);
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), { 
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders() }
      });
    }
  }
};
