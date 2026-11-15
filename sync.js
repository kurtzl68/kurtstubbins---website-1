/* AppSync - shared sync client for FutureLog and BoxScout.
 * Local copy is always the working copy. Changes upload to /api/{app}/ a few seconds after
 * the last edit. Photos (data: URLs) are split out and stored once, by hash.
 * Plain ASCII on purpose.
 */
(function () {
  'use strict';

  var PFX = '@@photo:';
  var cfg = null;
  var API = '/api/';
  var timers = {};
  var gen = {};
  var pushing = {};
  var resolving = {};
  var uploaded = {};
  var hashCache = new WeakMap();
  var curStatus = '';
  var idbp = null;

  var TEXT = {
    saved: 'SAVED',
    saving: 'SAVING',
    loading: 'LOADING',
    offline: 'OFFLINE - SAVED ON THIS DEVICE',
    signin: 'SIGN IN NEEDED - TAP',
    conflict: 'CONFLICT - TAP',
    error: 'SYNC ERROR - TAP TO RETRY',
    local: 'LOCAL COPY - NOT SYNCED'
  };

  /* ---------- tiny helpers ---------- */
  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* ignore */ }
  }
  function stKey(id) { return 'appsync:' + cfg.app + ':st:' + id; }
  function getSt(id) { return lsGet(stKey(id), { v: null, dirty: false }); }
  function setSt(id, o) {
    var s = getSt(id);
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) s[k] = o[k]; }
    lsSet(stKey(id), s);
    return s;
  }
  function listKey() { return 'appsync:' + cfg.app + ':list'; }
  function opsKey() { return 'appsync:' + cfg.app + ':ops'; }

  function setStatus(s) {
    curStatus = s;
    if (cfg && cfg.label) {
      cfg.label.textContent = TEXT[s] || '';
      cfg.label.setAttribute('data-state', s);
    }
    if (cfg && cfg.onStatus) { try { cfg.onStatus(s); } catch (e) { /* ignore */ } }
  }

  /* ---------- IndexedDB (local docs + photo cache) ---------- */
  function openDb() {
    if (idbp) return idbp;
    idbp = new Promise(function (resolve, reject) {
      var rq = indexedDB.open('appsync', 1);
      rq.onupgradeneeded = function (e) {
        var d = e.target.result;
        d.createObjectStore('docs');
        d.createObjectStore('photos');
      };
      rq.onsuccess = function (e) { resolve(e.target.result); };
      rq.onerror = function (e) { reject(e.target.error); };
    });
    return idbp;
  }
  function idb(store, mode, fn) {
    return openDb().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(store, mode);
        var rq = fn(tx.objectStore(store));
        tx.oncomplete = function () { resolve(rq ? rq.result : undefined); };
        tx.onerror = function (e) { reject(e.target.error); };
        tx.onabort = function (e) { reject(e.target.error); };
      });
    });
  }
  var local = {
    get: function (k) { return idb('docs', 'readonly', function (s) { return s.get(k); }).then(function (v) { return v == null ? null : v; }); },
    set: function (k, v) { return idb('docs', 'readwrite', function (s) { return s.put(v, k); }); },
    del: function (k) { return idb('docs', 'readwrite', function (s) { return s.delete(k); }); }
  };
  function photoGet(h) { return idb('photos', 'readonly', function (s) { return s.get(h); }); }
  function photoSet(h, v) { return idb('photos', 'readwrite', function (s) { return s.put(v, h); }); }

  /* ---------- network ---------- */
  function err(kind, extra) { var e = new Error(kind); e.kind = kind; e.extra = extra; return e; }

  async function call(method, path, o) {
    o = o || {};
    var r;
    try {
      r = await fetch(API + cfg.app + '/' + path, {
        method: method,
        headers: o.headers || {},
        body: o.body,
        credentials: 'same-origin',
        redirect: 'manual',
        cache: 'no-store'
      });
    } catch (e) {
      throw err('net');
    }
    if (r.type === 'opaqueredirect' || r.status === 401 || r.status === 403) throw err('auth');
    return r;
  }

  async function sha(s) {
    var buf = new TextEncoder().encode(s);
    var d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    var out = '';
    for (var i = 0; i < 16; i++) out += (d[i] < 16 ? '0' : '') + d[i].toString(16);
    return out;
  }

  async function pool(items, n, fn) {
    var i = 0;
    async function worker() {
      while (i < items.length) { var it = items[i++]; await fn(it); }
    }
    var w = [];
    for (var k = 0; k < Math.min(n, items.length); k++) w.push(worker());
    await Promise.all(w);
  }

  /* ---------- photo split / join ---------- */
  async function val(parent, key, blobs) {
    var v = parent[key];
    if (typeof v === 'string') {
      if (v.length > 2000 && v.indexOf('data:') === 0) {
        var c = hashCache.get(parent);
        if (c && c[key] && c[key].s === v) { blobs[c[key].h] = v; return PFX + c[key].h; }
        var h = await sha(v);
        if (!c) { c = {}; hashCache.set(parent, c); }
        c[key] = { s: v, h: h };
        blobs[h] = v;
        return PFX + h;
      }
      return v;
    }
    if (v && typeof v === 'object') return extract(v, blobs);
    return v;
  }
  async function extract(node, blobs) {
    if (Array.isArray(node)) {
      var a = [];
      for (var i = 0; i < node.length; i++) a.push(await val(node, i, blobs));
      return a;
    }
    var o = {};
    for (var k in node) {
      if (Object.prototype.hasOwnProperty.call(node, k)) o[k] = await val(node, k, blobs);
    }
    return o;
  }

  function collectRefs(node, out) {
    if (Array.isArray(node)) {
      for (var i = 0; i < node.length; i++) {
        var v = node[i];
        if (typeof v === 'string' && v.indexOf(PFX) === 0) out.push([node, i, v.slice(PFX.length)]);
        else if (v && typeof v === 'object') collectRefs(v, out);
      }
    } else if (node && typeof node === 'object') {
      for (var k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        var w = node[k];
        if (typeof w === 'string' && w.indexOf(PFX) === 0) out.push([node, k, w.slice(PFX.length)]);
        else if (w && typeof w === 'object') collectRefs(w, out);
      }
    }
  }

  async function hydrate(doc) {
    var refs = [];
    collectRefs(doc, refs);
    var hashes = {};
    refs.forEach(function (r) { hashes[r[2]] = true; });
    var list = Object.keys(hashes);
    var data = {};
    var done = 0;
    await pool(list, 4, async function (h) {
      var v = null;
      try { v = await photoGet(h); } catch (e) { v = null; }
      if (!v) {
        var r = await call('GET', 'photo/' + h);
        if (!r.ok) throw err('http', r.status);
        v = await r.text();
        try { await photoSet(h, v); } catch (e2) { /* cache is optional */ }
      }
      data[h] = v;
      done++;
      if (cfg.onProgress) cfg.onProgress(done, list.length);
    });
    refs.forEach(function (r) { r[0][r[1]] = data[r[2]]; });
  }

  /* ---------- push ---------- */
  function schedule(id, ms) {
    clearTimeout(timers[id]);
    timers[id] = setTimeout(function () { flush(id, false); }, ms);
  }

  function touch(id) {
    gen[id] = (gen[id] || 0) + 1;
    setSt(id, { dirty: true });
    if (curStatus !== 'offline' && curStatus !== 'signin') setStatus('saving');
    schedule(id, 4000);
  }

  async function push(id, force) {
    if (pushing[id]) { pushing[id].again = true; return 'busy'; }
    pushing[id] = { again: false };
    var result = 'ok';
    var g = gen[id] || 0;
    try {
      setStatus('saving');
      var doc = await cfg.getDoc(id);
      if (!doc) { pushing[id] = null; return 'nodoc'; }
      var st = getSt(id);
      var blobs = {};
      var slim = await extract(doc, blobs);
      var up = uploaded[cfg.app] || (uploaded[cfg.app] = {});
      var hashes = Object.keys(blobs).filter(function (h) { return !up[h]; });
      if (hashes.length) {
        var m = await call('POST', 'photos/missing', { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ hashes: hashes }) });
        if (!m.ok) throw err('http', m.status);
        var miss = (await m.json()).missing || [];
        hashes.forEach(function (h) { if (miss.indexOf(h) < 0) up[h] = true; });
        await pool(miss, 3, async function (h) {
          var r = await call('PUT', 'photo/' + h, { headers: { 'content-type': 'text/plain' }, body: blobs[h] });
          if (!r.ok) throw err('http', r.status);
          up[h] = true;
        });
      }
      var hdr = {
        'content-type': 'application/json',
        'X-Name': encodeURIComponent(cfg.getName(id) || id),
        'If-Match': String(st.v || 0)
      };
      if (force) hdr['X-Force'] = '1';
      var r2 = await call('PUT', 'p/' + id, { headers: hdr, body: JSON.stringify(slim) });
      if (r2.status === 409) {
        result = 'conflict';
      } else if (!r2.ok) {
        throw err('http', r2.status);
      } else {
        var j = await r2.json();
        setSt(id, { v: j.version, dirty: (gen[id] || 0) !== g });
        setStatus('saved');
      }
    } catch (e) {
      result = 'error';
      handleErr(e, id);
    }
    var again = pushing[id] && pushing[id].again;
    pushing[id] = null;
    if (result === 'ok' && (again || (gen[id] || 0) !== g)) schedule(id, 1500);
    return result;
  }

  function handleErr(e, id) {
    if (e && e.kind === 'auth') { setStatus('signin'); return; }
    if (e && e.kind === 'net') {
      setStatus(getSt(id).dirty ? 'offline' : 'saved');
      if (getSt(id).dirty) schedule(id, 30000);
      return;
    }
    setStatus('error');
    schedule(id, 60000);
  }

  async function flush(id, force) {
    var r = await push(id, force);
    if (r === 'conflict') await resolveConflict(id);
    return r;
  }

  /* ---------- conflict ---------- */
  function downloadJson(name, obj) {
    var blob = new Blob([JSON.stringify(obj)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1500);
  }

  async function resolveConflict(id) {
    if (resolving[id]) return;
    resolving[id] = true;
    try {
      setStatus('conflict');
      var name = cfg.getName(id) || id;
      var never = getSt(id).v == null;
      var msg = never
        ? 'This device has "' + name + '" data that was never synced, and the server already has a different copy.\n\n'
        : '"' + name + '" was changed on another device, and this device also has unsynced changes.\n\n';
      msg += 'OK = keep THIS device\'s version (the server copy is saved as a snapshot first).\n' +
        'Cancel = use the SERVER version (this device\'s version is downloaded as a backup file first).';
      if (window.confirm(msg)) {
        await push(id, true);
      } else {
        var mine = await cfg.getDoc(id);
        if (mine) downloadJson((name || id).replace(/[^A-Za-z0-9_-]+/g, '_') + '_this-device-backup.json', mine);
        await pull(id, true);
      }
    } catch (e) {
      handleErr(e, id);
    }
    resolving[id] = false;
  }

  /* ---------- pull ---------- */
  async function pull(id, overrideLocal) {
    setStatus('loading');
    var r = await call('GET', 'p/' + id);
    if (r.status === 404) { setStatus('saved'); return 'none'; }
    if (!r.ok) throw err('http', r.status);
    var ver = parseInt(r.headers.get('x-version') || '0', 10);
    var name = decodeURIComponent(r.headers.get('x-name') || '');
    var doc = await r.json();
    await hydrate(doc);
    setSt(id, { v: ver, dirty: false });
    await cfg.onRemote(id, doc, name, ver);
    setStatus('saved');
    return 'applied';
  }

  /* ---------- sync cycle ---------- */
  async function sync(id) {
    if (!id || pushing[id] || resolving[id]) return;
    try {
      var st = getSt(id);
      var r = await call('GET', 'p/' + id + '/version');
      if (r.status === 404) {
        if (cfg.hasData(id)) { setSt(id, { v: 0, dirty: true }); await flush(id, false); }
        else setStatus('saved');
        return;
      }
      if (!r.ok) throw err('http', r.status);
      var m = await r.json();
      if (m.trashed && cfg.onTrashed) { cfg.onTrashed(id); return; }
      if (m.version === st.v) {
        if (st.dirty) await flush(id, false); else setStatus('saved');
        return;
      }
      if (!st.dirty) { await pull(id, false); return; }
      await resolveConflict(id);
    } catch (e) {
      handleErr(e, id);
    }
  }

  function dirtyIds() {
    var out = [];
    var pre = 'appsync:' + cfg.app + ':st:';
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (k && k.indexOf(pre) === 0) {
        try { if (JSON.parse(localStorage.getItem(k)).dirty) out.push(k.slice(pre.length)); } catch (e) { /* ignore */ }
      }
    }
    return out;
  }

  async function flushDirty() {
    var ids = dirtyIds();
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] !== cfg.current()) await flush(ids[i], false);
    }
    await flushOps();
  }

  /* ---------- project list (BoxScout) ---------- */
  function cachedList() { return lsGet(listKey(), []); }
  function saveList(l) { lsSet(listKey(), l); }

  function applyOps(list) {
    var ops = lsGet(opsKey(), []);
    ops.forEach(function (o) {
      list.forEach(function (p) {
        if (p.id !== o.id) return;
        if (o.op === 'rename') p.name = o.name;
        if (o.op === 'trash') p.trashed = o.at;
        if (o.op === 'restore') p.trashed = '';
      });
    });
    return list;
  }

  async function flushOps() {
    var ops = lsGet(opsKey(), []);
    if (!ops.length) return;
    var rest = [];
    for (var i = 0; i < ops.length; i++) {
      var o = ops[i];
      try {
        var r = await call('POST', 'p/' + o.id + '/' + o.op, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: o.name }) });
        if (!r.ok && r.status !== 404) rest.push(o);
      } catch (e) { rest.push(o); }
    }
    lsSet(opsKey(), rest);
  }

  async function list() {
    var cached = cachedList();
    try {
      await flushOps();
      var r = await call('GET', 'projects');
      if (!r.ok) throw err('http', r.status);
      var server = (await r.json()).projects || [];
      var ids = {};
      server.forEach(function (p) { ids[p.id] = true; });
      cached.forEach(function (p) {
        var s = getSt(p.id);
        if (!ids[p.id] && (s.v == null || s.v === 0)) server.push(p);
      });
      server = applyOps(server);
      saveList(server);
      return server;
    } catch (e) {
      handleErr(e, cfg.current && cfg.current());
      return applyOps(cached);
    }
  }

  function addLocal(id, name) {
    var l = cachedList().filter(function (p) { return p.id !== id; });
    l.push({ id: id, name: name, version: 0, updated: new Date().toISOString(), trashed: '' });
    saveList(l);
  }

  function enqueue(op, id, name) {
    var l = cachedList();
    var s = getSt(id);
    var localOnly = s.v == null || s.v === 0;
    l.forEach(function (p) {
      if (p.id !== id) return;
      if (op === 'rename') p.name = name;
      if (op === 'trash') p.trashed = new Date().toISOString();
      if (op === 'restore') p.trashed = '';
    });
    saveList(l);
    if (localOnly) return Promise.resolve();
    var ops = lsGet(opsKey(), []);
    ops.push({ op: op, id: id, name: name, at: new Date().toISOString() });
    lsSet(opsKey(), ops);
    return flushOps();
  }

  /* ---------- start ---------- */
  function init(c) {
    cfg = c;
    if (location.protocol === 'file:') { setStatus('local'); cfg.disabled = true; return; }
    if (cfg.label) {
      cfg.label.addEventListener('click', function () {
        var id = cfg.current();
        if (curStatus === 'signin') { location.href = location.pathname + '?relogin=' + Date.now(); return; }
        if (curStatus === 'conflict' || curStatus === 'error' || curStatus === 'offline') { flush(id, false).then(function () { return sync(id); }); }
      });
    }
    window.addEventListener('online', function () { flushDirty().then(function () { sync(cfg.current()); }); });
    window.addEventListener('offline', function () { if (getSt(cfg.current()).dirty) setStatus('offline'); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') { flushDirty().then(function () { sync(cfg.current()); }); }
      else { var id = cfg.current(); if (id && getSt(id).dirty) flush(id, false); }
    });
    setInterval(function () {
      if (document.visibilityState !== 'visible') return;
      var id = cfg.current();
      if (id && !getSt(id).dirty) sync(id);
    }, 60000);
    if ('serviceWorker' in navigator) { navigator.serviceWorker.register('/sw.js').catch(function () { /* ignore */ }); }
  }

  function start(id) {
    if (!cfg || cfg.disabled) return Promise.resolve();
    var st = getSt(id);
    if (st.v == null && !st.dirty && cfg.hasData(id)) setSt(id, { v: null, dirty: true });
    return sync(id).then(function () { return flushDirty(); });
  }

  window.AppSync = {
    init: init,
    start: start,
    touch: function (id) { if (cfg && !cfg.disabled) touch(id); },
    sync: function (id) { return cfg && !cfg.disabled ? sync(id) : Promise.resolve(); },
    flushNow: function (id) { return cfg && !cfg.disabled && getSt(id).dirty ? flush(id, false) : Promise.resolve(); },
    list: function () { return cfg.disabled ? Promise.resolve(applyOps(cachedList())) : list(); },
    cachedList: function () { return applyOps(cachedList()); },
    addLocal: addLocal,
    rename: function (id, name) { return enqueue('rename', id, name); },
    trash: function (id) { return enqueue('trash', id); },
    restore: function (id) { return enqueue('restore', id); },
    forget: function (id) { try { localStorage.removeItem(stKey(id)); } catch (e) { /* ignore */ } },
    state: getSt,
    local: local,
    status: function () { return curStatus; }
  };
})();
