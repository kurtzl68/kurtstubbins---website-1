// Sync API for FutureLog and BoxScout (Cloudflare Pages Function).
// Storage: one R2 bucket bound as APPDATA.
// Auth: Cloudflare Access JWT is verified here, so the pages.dev address cannot bypass the login.
// Env vars: ACCESS_TEAM_DOMAIN (e.g. yourteam.cloudflareaccess.com), ACCESS_AUD (Access app AUD tag).
// ALLOW_NO_AUTH=1 disables the check (Preview environment only, test bucket only).

const APPS = ['futurelog', 'boxscout'];
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const HASH_RE = /^[a-f0-9]{32}$/;
const TRASH_DAYS = 30;
const KEEP_HISTORY = 20;

let certCache = { at: 0, keys: null };

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json', 'cache-control': 'no-store' }, extra || {}),
  });
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function getCerts(team) {
  const now = Date.now();
  if (certCache.keys && now - certCache.at < 3600000) return certCache.keys;
  const r = await fetch('https://' + team + '/cdn-cgi/access/certs');
  if (!r.ok) throw new Error('certs');
  const j = await r.json();
  certCache = { at: now, keys: j.keys || [] };
  return certCache.keys;
}

async function authorized(request, env) {
  if (env.ALLOW_NO_AUTH === '1') return true;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null; // not configured
  const tok = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!tok) return false;
  const parts = tok.split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    const payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
    if (header.alg !== 'RS256') return false;
    const keys = await getCerts(env.ACCESS_TEAM_DOMAIN);
    const jwk = keys.find(function (k) { return k.kid === header.kid; });
    if (!jwk) return false;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) return false;
    const now = Math.floor(Date.now() / 1000);
    if (!payload.exp || payload.exp < now) return false;
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (aud.indexOf(env.ACCESS_AUD) < 0) return false;
    if (payload.iss !== 'https://' + env.ACCESS_TEAM_DOMAIN) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function projKey(app, id) { return app + '/projects/' + id + '.json'; }
function histPrefix(app, id) { return app + '/history/' + id + '/'; }

function metaOf(head) {
  const m = head.customMetadata || {};
  return {
    name: m.name ? decodeURIComponent(m.name) : '',
    version: parseInt(m.version || '0', 10),
    updated: m.updated || '',
    trashed: m.trashed || '',
  };
}

async function snapshot(bucket, app, id, label) {
  const old = await bucket.get(projKey(app, id));
  if (!old) return;
  await bucket.put(histPrefix(app, id) + label + '.json', old.body);
  const l = await bucket.list({ prefix: histPrefix(app, id) });
  const names = l.objects.map(function (o) { return o.key; }).sort();
  while (names.length > KEEP_HISTORY) await bucket.delete(names.shift());
}

async function purgeOldTrash(bucket, app, items) {
  const cutoff = Date.now() - TRASH_DAYS * 86400000;
  const keep = [];
  for (const it of items) {
    if (it.trashed && Date.parse(it.trashed) < cutoff) {
      await bucket.delete(projKey(app, it.id));
      const l = await bucket.list({ prefix: histPrefix(app, it.id) });
      for (const o of l.objects) await bucket.delete(o.key);
    } else keep.push(it);
  }
  return keep;
}

export async function onRequest(context) {
  const request = context.request;
  const env = context.env;
  const bucket = env.APPDATA;
  if (!bucket) return json({ error: 'storage not bound' }, 503);

  const auth = await authorized(request, env);
  if (auth === null) return json({ error: 'auth not configured' }, 503);
  if (auth === false) return json({ error: 'unauthorized' }, 401);

  const url = new URL(request.url);
  const seg = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  if (seg[0] === 'ping') return json({ ok: true });
  const app = seg[0];
  if (APPS.indexOf(app) < 0) return json({ error: 'not found' }, 404);

  // GET /api/{app}/projects
  if (seg[1] === 'projects' && method === 'GET') {
    const out = [];
    let cursor;
    do {
      const l = await bucket.list({ prefix: app + '/projects/', include: ['customMetadata'], cursor: cursor });
      for (const o of l.objects) {
        const id = o.key.slice((app + '/projects/').length).replace(/\.json$/, '');
        out.push(Object.assign({ id: id }, metaOf(o)));
      }
      cursor = l.truncated ? l.cursor : undefined;
    } while (cursor);
    const kept = await purgeOldTrash(bucket, app, out);
    return json({ projects: kept });
  }

  // photos
  if (seg[1] === 'photos' && seg[2] === 'missing' && method === 'POST') {
    const body = await request.json();
    const hashes = (body.hashes || []).filter(function (h) { return HASH_RE.test(h); });
    const missing = [];
    for (const h of hashes) {
      const hd = await bucket.head(app + '/photos/' + h);
      if (!hd) missing.push(h);
    }
    return json({ missing: missing });
  }
  if (seg[1] === 'photo' && HASH_RE.test(seg[2] || '')) {
    const key = app + '/photos/' + seg[2];
    if (method === 'PUT') {
      await bucket.put(key, request.body, { httpMetadata: { contentType: 'text/plain' } });
      return json({ ok: true });
    }
    if (method === 'GET') {
      const o = await bucket.get(key);
      if (!o) return json({ error: 'not found' }, 404);
      return new Response(o.body, { headers: { 'content-type': 'text/plain', 'cache-control': 'private, max-age=31536000, immutable' } });
    }
  }

  // project routes: /api/{app}/p/{id}[/action]
  if (seg[1] === 'p' && ID_RE.test(seg[2] || '')) {
    const id = seg[2];
    const key = projKey(app, id);
    const action = seg[3];

    if (!action && method === 'GET') {
      const o = await bucket.get(key);
      if (!o) return json({ error: 'not found' }, 404);
      const m = metaOf(o);
      return new Response(o.body, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          'x-version': String(m.version),
          'x-name': encodeURIComponent(m.name),
          'x-trashed': m.trashed,
        },
      });
    }

    if (action === 'version' && method === 'GET') {
      const h = await bucket.head(key);
      if (!h) return json({ error: 'not found' }, 404);
      return json(metaOf(h));
    }

    if (!action && method === 'PUT') {
      const head = await bucket.head(key);
      const cur = head ? metaOf(head).version : 0;
      const force = request.headers.get('X-Force') === '1';
      const ifm = parseInt(request.headers.get('If-Match') || '-1', 10);
      if (!force && ifm !== cur) return json({ error: 'conflict', version: cur }, 409);
      const name = decodeURIComponent(request.headers.get('X-Name') || '') || (head ? metaOf(head).name : id);
      if (head) {
        const today = new Date().toISOString().slice(0, 10);
        const hasToday = await bucket.head(histPrefix(app, id) + today + '.json');
        if (force) await snapshot(bucket, app, id, new Date().toISOString().replace(/[:.]/g, '-') + '-overwritten');
        else if (!hasToday) await snapshot(bucket, app, id, today);
      }
      const next = cur + 1;
      const prevTrashed = head ? metaOf(head).trashed : '';
      await bucket.put(key, request.body, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { name: encodeURIComponent(name), version: String(next), updated: new Date().toISOString(), trashed: prevTrashed },
      });
      return json({ version: next });
    }

    if (action === 'rename' && method === 'POST') {
      const o = await bucket.get(key);
      if (!o) return json({ error: 'not found' }, 404);
      const b = await request.json();
      const m = metaOf(o);
      const buf = await o.arrayBuffer();
      await bucket.put(key, buf, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { name: encodeURIComponent(String(b.name || '').slice(0, 80)), version: String(m.version), updated: m.updated, trashed: m.trashed },
      });
      return json({ ok: true });
    }

    if ((action === 'trash' || action === 'restore') && method === 'POST') {
      const o = await bucket.get(key);
      if (!o) return json({ error: 'not found' }, 404);
      const m = metaOf(o);
      const buf = await o.arrayBuffer();
      await bucket.put(key, buf, {
        httpMetadata: { contentType: 'application/json' },
        customMetadata: { name: encodeURIComponent(m.name), version: String(m.version), updated: m.updated, trashed: action === 'trash' ? new Date().toISOString() : '' },
      });
      return json({ ok: true });
    }
  }

  return json({ error: 'not found' }, 404);
}
