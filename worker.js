/* ============================================================================
   worker.js — Task Board push backend (Cloudflare Worker)

   What it does
     POST /subscribe    { user, subscription }   -> stores a push subscription
     POST /unsubscribe  { user, endpoint }        -> removes one
     POST /send         { to:[user], title, body, taskId, url }  -> push now
     CRON (scheduled)   -> scans Firebase for overdue tasks and alerts the
                           starter + assigned people, once per due date.

   It uses only the Workers Web Crypto API — no npm packages — so it follows
   the same self-contained pattern as your other workers.

   ---------------------------------------------------------------------------
   ONE-TIME SETUP
   1) Generate VAPID keys (any machine with Node + the web-push package):
        npx web-push generate-vapid-keys
      Copy the Public Key into task-board.html  -> CONFIG.PUSH.VAPID_PUBLIC_KEY
      Keep the Private Key for step 4.

   2) Create a KV namespace and bind it as SUBS:
        npx wrangler kv namespace create SUBS

   3) wrangler.toml (example):
        name = "taskboard-push"
        main = "worker.js"
        compatibility_date = "2024-09-01"
        kv_namespaces = [{ binding = "SUBS", id = "<your-kv-id>" }]
        [triggers]
        crons = ["0,30 * * * *"]   # every 30 minutes
        [vars]
        VAPID_SUBJECT = "mailto:you@stevessanitation.com"
        FIREBASE_URL  = "https://your-db-default-rtdb.firebaseio.com"
        DB_PATH       = "steves_taskboard"
        ALLOW_ORIGIN  = "https://melgard05.github.io"

   4) Store the private + public keys as secrets:
        npx wrangler secret put VAPID_PRIVATE_KEY
        npx wrangler secret put VAPID_PUBLIC_KEY

   5) Deploy:  npx wrangler deploy
      Put the resulting URL into task-board.html -> CONFIG.PUSH.WORKER_URL
   ============================================================================ */

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const json = (obj, status = 200) =>
      new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json" } });

    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/subscribe") {
        const { user, subscription } = await request.json();
        if (!user || !subscription || !subscription.endpoint) return json({ error: "bad request" }, 400);
        const key = `sub:${user}:${await hashStr(subscription.endpoint)}`;
        await env.SUBS.put(key, JSON.stringify(subscription));
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/unsubscribe") {
        const { user, endpoint } = await request.json();
        if (!user || !endpoint) return json({ error: "bad request" }, 400);
        await env.SUBS.delete(`sub:${user}:${await hashStr(endpoint)}`);
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/send") {
        const { to, title, body, taskId, url: link } = await request.json();
        if (!Array.isArray(to) || !to.length) return json({ error: "no recipients" }, 400);
        const sent = await sendToUsers(env, to, { title, body, taskId, url: link });
        return json({ ok: true, sent });
      }

      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  },

  // Cron: alert on overdue tasks (once per task per due date).
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      if (!env.FIREBASE_URL || !env.DB_PATH) return;
      const today = new Date(); today.setUTCHours(0, 0, 0, 0);
      const todayISO = today.toISOString().slice(0, 10);
      let tasks;
      try {
        const r = await fetch(`${env.FIREBASE_URL.replace(/\/$/, "")}/${env.DB_PATH}/tasks.json`, { cf: { cacheTtl: 0 } });
        tasks = await r.json();
      } catch (_) { return; }
      if (!tasks) return;

      for (const id of Object.keys(tasks)) {
        const t = tasks[id];
        if (!t || t.status === "done" || !t.dueDate || t.dueDate >= todayISO) continue;
        const flagKey = `notified:${id}:${t.dueDate}`;
        if (await env.SUBS.get(flagKey)) continue;

        const recipients = [];
        if (t.initiator) recipients.push(t.initiator);
        (t.assignees || []).forEach(a => { if (a && !a.external && a.name) recipients.push(a.name); });
        const unique = [...new Set(recipients)];
        if (unique.length) {
          await sendToUsers(env, unique, {
            title: "Task overdue",
            body: (t.title || "A task") + " was due " + t.dueDate,
            taskId: id
          });
        }
        await env.SUBS.put(flagKey, "1", { expirationTtl: 60 * 60 * 24 * 30 });
      }
    })());
  }
};

/* ---------- fan-out to a user's devices ---------- */
async function sendToUsers(env, users, payload) {
  let sent = 0;
  for (const user of users) {
    const list = await env.SUBS.list({ prefix: `sub:${user}:` });
    for (const k of list.keys) {
      const raw = await env.SUBS.get(k.name);
      if (!raw) continue;
      let sub; try { sub = JSON.parse(raw); } catch (_) { continue; }
      const status = await sendPush(env, sub, payload);
      if (status === 404 || status === 410) await env.SUBS.delete(k.name);  // dead subscription
      else if (status >= 200 && status < 300) sent++;
    }
  }
  return sent;
}

/* ---------- Web Push (RFC 8291 aes128gcm + RFC 8292 VAPID) ---------- */
async function sendPush(env, subscription, payloadObj) {
  const payload = new TextEncoder().encode(JSON.stringify(payloadObj || {}));
  const body = await encryptPayload(payload, subscription.keys.p256dh, subscription.keys.auth);
  const endpoint = subscription.endpoint;
  const jwt = await vapidJWT(new URL(endpoint).origin, env);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "TTL": "86400",
      "Authorization": `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`
    },
    body
  });
  return res.status;
}

async function vapidJWT(audience, env) {
  const pub = b64urlToBytes(env.VAPID_PUBLIC_KEY);    // 65-byte uncompressed point
  const priv = b64urlToBytes(env.VAPID_PRIVATE_KEY);  // 32-byte scalar
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(priv)
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const enc = new TextEncoder();
  const header = bytesToB64url(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT" })));
  const claims = bytesToB64url(enc.encode(JSON.stringify({
    aud: audience, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUBJECT || "mailto:admin@example.com"
  })));
  const signingInput = enc.encode(header + "." + claims);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, signingInput); // r||s
  return header + "." + claims + "." + bytesToB64url(new Uint8Array(sig));
}

async function encryptPayload(plaintext, clientP256dhB64, authB64) {
  const clientPub = b64urlToBytes(clientP256dhB64);   // 65 bytes
  const auth = b64urlToBytes(authB64);                 // 16 bytes

  const server = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const serverPub = new Uint8Array(await crypto.subtle.exportKey("raw", server.publicKey)); // 65 bytes
  const clientKey = await crypto.subtle.importKey("raw", clientPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: clientKey }, server.privateKey, 256));

  const enc = new TextEncoder();
  const keyInfo = concat(enc.encode("WebPush: info\0"), clientPub, serverPub);
  const ikm = await hkdf(auth, ecdh, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const record = concat(plaintext, new Uint8Array([2]));   // 0x02 = last-record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, aesKey, record));

  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + serverPub.length);
  header.set(salt, 0);
  header[16] = (rs >>> 24) & 255; header[17] = (rs >>> 16) & 255; header[18] = (rs >>> 8) & 255; header[19] = rs & 255;
  header[20] = serverPub.length;
  header.set(serverPub, 21);
  return concat(header, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, { name: "HKDF" }, false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/* ---------- small helpers ---------- */
function concat(...arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  s += "=".repeat((4 - s.length % 4) % 4);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64url(bytes) {
  const u = new Uint8Array(bytes); let bin = "";
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function hashStr(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return bytesToB64url(new Uint8Array(buf)).slice(0, 24);
}
