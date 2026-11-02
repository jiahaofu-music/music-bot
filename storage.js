/* 音乐bot · storage.js — per-account state store for MusicRec.setStore() (owned by 音乐bot算法).
 * Plain browser JS, no build step; also require()-able in Node for tests. Global: window.YYBStorage.
 *
 *   YYBStorage.guest()                     -> null   (MusicRec.setStore(null) = localStorage 'yinyuebot.v1', untouched)
 *   await YYBStorage.account(supabase, uid) -> sync store {getItem,setItem,removeItem, onSyncStatus, flush, status, pending, hasUnsynced, ...}
 *   YYBStorage.flush()                     -> Promise<boolean>: push every account store now (sign-out / pagehide)
 *   YYBStorage.isEmpty(state)              -> true when no seeds / feedback / history / replay / artist bans
 *   YYBStorage.merge(base, local, remote)  -> 3-way merge of two yinyuebot.v1 states (exposed for tests)
 *
 * Remote: Supabase table public.user_state(user_id, state jsonb, updated_at) — see supabase/schema.sql.
 * The 'yinyuebot.v1' JSON is stored as-is in `state`; its structure is never changed here.
 * Local cache per account (shared by all tabs of this browser):
 *   'yinyuebot.u.<uid>.v1'   current state JSON (may contain unsynced edits)
 *   'yinyuebot.u.<uid>.base' last state known to be on the server (merge base)
 *   'yinyuebot.u.<uid>.meta' {dirty, at, knownAt}  knownAt = server updated_at of `base`
 * Concurrency (two tabs / two devices): every push first checks the server's updated_at; if it moved, the server copy is
 * 3-way merged with ours (base = last synced state) and written with a conditional update (eq updated_at); a lost race loops.
 */
(function (root) {
'use strict';
const KEY = 'yinyuebot.v1';
const mem = new Map(), memLS = { getItem: k => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: k => mem.delete(k) };
const LS = () => { try { if (typeof localStorage !== 'undefined' && localStorage) return localStorage; } catch (e) {} return memLS; };
const lsGet = k => { try { return LS().getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { LS().setItem(k, v); } catch (e) {} };
const lsDel = k => { try { LS().removeItem(k); } catch (e) {} };
const parse = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch (e) { return null; } };
const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
const tms = t => { const n = Date.parse(t); return isNaN(n) ? 0 : n; };
const active = new Set();

function isEmpty(state) {
  const s = parse(state); if (!s || typeof s !== 'object' || Array.isArray(s)) return true;
  const seeds = s.seeds || {}, nonEmpty = a => Array.isArray(a) && a.some(x => x != null && String(typeof x === 'object' ? (x.name || x.title || '') : x).trim());
  if (['genres', 'artists', 'songs'].some(k => nonEmpty(seeds[k]))) return false;
  if (s.feedback && typeof s.feedback === 'object' && Object.values(s.feedback).some(f => f && (f.v || f.r))) return false;
  const h = s.history;
  if (h && typeof h === 'object' && (Array.isArray(h) ? h.some(x => x && Array.isArray(x.tracks) && x.tracks.length)
    : Object.values(h).some(d => d && Array.isArray(d.sets) && d.sets.some(x => x && Array.isArray(x.tracks) && x.tracks.length)))) return false;
  if (Array.isArray(s.replay) && s.replay.length) return false;
  if (nonEmpty(s.artistBans) || nonEmpty(s.artistBanIds)) return false;
  return true;
}

// ---------------- 3-way merge ----------------
// base = last state both sides agreed on (server copy we loaded / last pushed). A key/item that is in base but missing on one side
// was deleted there (undislike, unban, clear rating, reset) and stays deleted unless the other side changed it after base.
const ikey = x => (x && typeof x === 'object') ? JSON.stringify(x) : String(x).trim().toLowerCase();
function mergeList(b, l, r) {
  b = Array.isArray(b) ? b : []; l = Array.isArray(l) ? l : []; r = Array.isArray(r) ? r : [];
  const B = new Set(b.map(ikey)), L = new Set(l.map(ikey)), R = new Set(r.map(ikey)), out = [], seen = new Set();
  for (const x of [...l, ...r]) { const k = ikey(x); if (seen.has(k)) continue;
    if (B.has(k) && (!L.has(k) || !R.has(k))) continue;   // removed on one side since base
    seen.add(k); out.push(x); }
  return out;
}
function mergeFeedback(b, l, r) {
  b = obj(b); l = obj(l); r = obj(r); const out = {}, at = f => +((f && f.at) || 0);
  for (const id of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const L = l[id], R = r[id], B = b[id];
    if (L && R) out[id] = at(R) > at(L) ? R : L;                       // newest rating wins (tie -> ours)
    else if (L) { if (!B || at(L) > at(B)) out[id] = L; }              // only ours: new, or changed after the other side cleared it
    else if (R) { if (!B || at(R) > at(B)) out[id] = R; }
  }
  return out;
}
function mergeHistory(b, l, r) {
  b = obj(b); l = obj(l); r = obj(r); const out = {};
  for (const d of new Set([...Object.keys(l), ...Object.keys(r)])) {
    const sets = x => (x && Array.isArray(x.sets)) ? x.sets : [], byAt = a => a.map(s => (s && s.at) || JSON.stringify(s));
    const bs = sets(b[d]), ls = sets(l[d]), rs = sets(r[d]), B = new Set(byAt(bs)), L = new Set(byAt(ls)), R = new Set(byAt(rs)), seen = new Set(), m = [];
    for (const s of [...ls, ...rs]) { const k = (s && s.at) || JSON.stringify(s); if (seen.has(k) || (B.has(k) && (!L.has(k) || !R.has(k)))) continue; seen.add(k); m.push(s); }
    m.sort((x, y) => ((x && x.at) || 0) - ((y && y.at) || 0));
    if (m.length) out[d] = Object.assign({}, r[d] || {}, l[d] || {}, { sets: m });
  }
  return out;
}
/** merge(base, local, remote, localIsNewer=true): feedback per trackId by newest `at`; seeds / artistBans / artistBanIds / history sets
 *  as 3-way unions (deletions since base respected); every other field from the newer side. */
function merge(base, local, remote, localIsNewer = true) {
  const b = obj(parse(base)), l = obj(parse(local)), r = obj(parse(remote));
  const out = Object.assign({}, localIsNewer ? r : l, localIsNewer ? l : r);
  out.feedback = mergeFeedback(b.feedback, l.feedback, r.feedback);
  out.history = mergeHistory(b.history, l.history, r.history);
  const bs = obj(b.seeds), lsd = obj(l.seeds), rs = obj(r.seeds);
  out.seeds = Object.assign({}, localIsNewer ? rs : lsd, localIsNewer ? lsd : rs);
  ['genres', 'artists', 'songs'].forEach(k => { out.seeds[k] = mergeList(bs[k], lsd[k], rs[k]); });
  ['artistBans', 'artistBanIds'].forEach(k => { if (l[k] || r[k]) out[k] = mergeList(b[k], l[k], r[k]); });
  return out;
}

// errors that retrying cannot fix: RLS denied, auth expired/invalid, wrong user
function classify(e) {
  const code = String((e && (e.code || e.error_code)) || ''), st = +(e && (e.status || e.statusCode)) || 0, msg = String((e && (e.message || e.msg || e.error_description)) || e || '');
  if (code === '42501' || /row-level security/i.test(msg)) return { code: code || '42501', fatal: true };
  if (code === 'USER_MISMATCH' || code === 'NO_SESSION') return { code, fatal: true };
  if (/^PGRST30[0-3]$/.test(code) || st === 401 || /jwt|token is expired|invalid (?:token|claim)|not authenticated/i.test(msg)) return { code: code || '401', fatal: true };
  return { code: code || (st ? String(st) : 'NETWORK'), fatal: false };
}

async function account(supabase, userId, opts = {}) {
  if (!supabase || typeof supabase.from !== 'function') throw new Error('YYBStorage.account: need a supabase-js v2 client');
  if (!userId) throw new Error('YYBStorage.account: need userId');
  const uid = String(userId), pre = 'yinyuebot.u.' + uid, cKey = pre + '.v1', bKey = pre + '.base', mKey = pre + '.meta';
  const debounceMs = opts.debounceMs ?? 800, backoff = opts.backoff || [1000, 2000, 5000, 10000, 30000];
  const win = opts.window !== undefined ? opts.window : (typeof window !== 'undefined' ? window : null);
  const doc = opts.document !== undefined ? opts.document : (typeof document !== 'undefined' ? document : null);
  const meta = () => obj(parse(lsGet(mKey))), setMeta = m => lsSet(mKey, JSON.stringify(Object.assign(meta(), m)));
  const T = () => supabase.from('user_state');
  const fetchRow = async () => { const { data, error } = await T().select('state, updated_at').eq('user_id', uid).maybeSingle(); if (error) throw error; return data || null; };

  let json = null, base = null, knownAt = null, source = 'empty';
  try {
    const row = await fetchRow(), m = meta(), cached = lsGet(cKey);
    if (row) { json = JSON.stringify(row.state ?? {}); base = json; knownAt = row.updated_at; source = 'remote'; }
    if (m.dirty && cached != null) {
      // unsynced edits from an earlier session/tab: keep them; if the server moved meanwhile, merge now (base = what we last synced)
      const cbase = lsGet(bKey);
      if (!row) { json = cached; base = cbase; source = 'cache-unsynced'; }
      else if (tms(row.updated_at) === tms(m.knownAt)) { json = cached; source = 'cache-unsynced'; }
      else { json = JSON.stringify(merge(cbase, cached, row.state, (+m.at || 0) > tms(row.updated_at))); source = 'cache-unsynced'; }
    }
  } catch (e) {
    const cached = lsGet(cKey), m = meta(); json = cached; base = lsGet(bKey); knownAt = m.knownAt || null; source = cached != null ? 'cache' : 'empty'; // offline
  }
  if (json != null) lsSet(cKey, json);
  if (source !== 'cache' && base != null) { lsSet(bKey, base); setMeta({ knownAt }); }

  const listeners = new Set(); let status = 'idle', timer = null, retryTimer = null, attempt = 0, seq = 0, pushedSeq = 0, running = null, disposed = false;
  const emit = st => { if (st !== 'remote') status = st; listeners.forEach(cb => { try { cb(st, store); } catch (e) {} }); };
  const clearTimers = () => { clearTimeout(timer); clearTimeout(retryTimer); timer = retryTimer = null; };
  const synced = (stateJson, at) => { base = stateJson; knownAt = at; lsSet(bKey, stateJson); setMeta({ knownAt: at }); };
  const adopt = (v, at) => { const changed = v !== json; json = v; lsSet(cKey, v); if (at !== undefined) synced(v, at); if (changed) emit('remote'); return changed; };

  async function checkUser() {
    if (!supabase.auth || typeof supabase.auth.getSession !== 'function') return;
    const r = await supabase.auth.getSession(), sess = r && r.data && r.data.session;
    if (!sess) throw { code: 'NO_SESSION', message: 'not signed in' };
    if (sess.user && sess.user.id && String(sess.user.id) !== uid) throw { code: 'USER_MISMATCH', message: 'signed-in user differs from this store' };
  }
  async function pushOnce() {
    const mySeq = seq; if (status !== 'saving') emit('saving');
    try {
      await checkUser();
      for (let round = 0; round < 4; round++) {
        let row = await fetchRow(), toSave = json;
        if (row && tms(row.updated_at) !== tms(knownAt)) {            // someone else saved since our base -> merge their copy in
          const merged = JSON.stringify(merge(base, json, row.state, (+meta().at || Date.now()) >= tms(row.updated_at)));
          if (merged !== json) { json = merged; lsSet(cKey, merged); emit('remote'); }
          toSave = merged;
        }
        const now = new Date().toISOString(), body = { state: parse(toSave) || {}, updated_at: now };
        let res; const t = T();
        if (typeof t.update !== 'function') {                         // minimal clients (QA fakes) with only upsert: unconditional write, no race check
          res = await t.upsert(Object.assign({ user_id: uid }, body), { onConflict: 'user_id' });
          if (res && res.error) throw res.error;
          res = { data: [{ updated_at: now }], error: null };
        } else if (row) res = await T().update(body).eq('user_id', uid).eq('updated_at', row.updated_at).select('updated_at');   // conditional write
        else res = await T().insert(Object.assign({ user_id: uid }, body)).select('updated_at');
        if (res.error) { if (!row && res.error.code === '23505') continue; throw res.error; }  // insert raced with another tab -> merge round
        const got = Array.isArray(res.data) ? res.data[0] : res.data;
        if (row && !got) continue;                                     // updated_at moved between read and write -> another round
        synced(toSave, (got && got.updated_at) || now);
        pushedSeq = Math.max(pushedSeq, mySeq); attempt = 0; store.lastError = null;
        if (pushedSeq >= seq && json === toSave) { if (lsGet(cKey) === toSave) setMeta({ dirty: false, at: tms(now) }); emit('saved'); }   // another tab's newer cache keeps dirty
        else { if (json !== toSave && pushedSeq >= seq) seq++; schedule(); }   // newer local write (or merge) arrived meanwhile
        return true;
      }
      throw { code: 'CONFLICT', message: 'kept losing the write race' };
    } catch (e) {
      const c = classify(e);
      store.lastError = { code: c.code, message: String((e && e.message) || e), status: e && e.status, fatal: c.fatal, raw: e };
      emit('error');
      if (!disposed && !c.fatal) { clearTimeout(retryTimer); retryTimer = setTimeout(() => { retryTimer = null; push(); }, backoff[Math.min(attempt, backoff.length - 1)]); attempt++; }
      return false;
    }
  }
  function push() { // serialised: one push in flight at a time
    clearTimeout(timer); timer = null;
    running = (running || Promise.resolve()).then(() => (pushedSeq < seq ? pushOnce() : true));
    const r = running; r.finally(() => { if (running === r) running = null; }); return r;
  }
  function schedule() { if (disposed) return; clearTimeout(timer); timer = setTimeout(push, debounceMs); if (status !== 'saving') emit('saving'); }
  const write = v => { json = v; seq++; lsSet(cKey, v == null ? '{}' : v); setMeta({ dirty: true, at: Date.now() }); schedule(); };

  // other tab of this browser wrote the shared cache
  const onStorage = e => {
    if (disposed || !e) return;
    if (e.key === mKey) { const m = obj(parse(e.newValue)); if (pushedSeq >= seq && m.knownAt && tms(m.knownAt) !== tms(knownAt) && lsGet(cKey) === json) { base = lsGet(bKey); knownAt = m.knownAt; } return; }  // other tab saved
    if (e.key !== cKey || e.newValue == null || e.newValue === json) return;
    if (pushedSeq >= seq) { json = e.newValue; const m = meta(); if (m.knownAt && !m.dirty) { base = lsGet(bKey); knownAt = m.knownAt; } emit('remote'); }
    else { const merged = JSON.stringify(merge(base, json, e.newValue, true)); if (merged !== json) { json = merged; lsSet(cKey, merged); } emit('remote'); }
  };
  // back to this tab: pick up changes from other devices
  const refresh = async () => {
    if (disposed || pushedSeq < seq) return false;
    try { const row = await fetchRow(); if (!row || tms(row.updated_at) === tms(knownAt) || pushedSeq < seq) return false;
      return adopt(JSON.stringify(row.state ?? {}), row.updated_at); } catch (e) { return false; }
  };
  const onVis = () => { if (doc && doc.visibilityState === 'visible') refresh(); };
  if (win && win.addEventListener) win.addEventListener('storage', onStorage);
  if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVis);

  const store = {
    userId: uid, source, cacheKey: cKey,
    getItem(k) { return k === KEY ? json : lsGet(k); },
    setItem(k, v) { if (k === KEY) write(String(v)); else lsSet(k, v); },
    removeItem(k) { if (k === KEY) write(null); else lsDel(k); },
    /** cb(status, store): 'saving' | 'saved' | 'error' | 'remote' (state replaced/merged from another tab/device -> re-render). Returns unsubscribe(). */
    onSyncStatus(cb) { listeners.add(cb); return () => listeners.delete(cb); },
    get status() { return status; },
    /** true while local edits are not on the server yet (also after a fatal error) */
    get pending() { return pushedSeq < seq; },
    get hasUnsynced() { return pushedSeq < seq || !!meta().dirty; },
    get knownAt() { return knownAt; },
    /** Push now (skips the debounce). Resolves true when the server has the latest state, false on error. */
    flush() { clearTimeout(retryTimer); retryTimer = null; return pushedSeq < seq ? push() : (running || Promise.resolve(true)); },
    /** Re-read the server row (done automatically when the tab becomes visible). Resolves true if the state changed. */
    refresh,
    /** Stop timers/listeners and drop from YYBStorage.flush() (call after sign-out, once flush() resolved). */
    dispose() { disposed = true; clearTimers(); active.delete(store);
      if (win && win.removeEventListener) win.removeEventListener('storage', onStorage);
      if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVis); },
    lastError: null,
  };
  // unsynced edits found at load time -> status 'saving' right away and push them
  if (source === 'cache-unsynced' || (source === 'cache' && meta().dirty)) {
    seq = 1; status = 'saving'; timer = setTimeout(push, source === 'cache' ? debounceMs : 0);
    setTimeout(() => { if (status === 'saving') listeners.forEach(cb => { try { cb('saving', store); } catch (e) {} }); }, 0);
  }
  active.add(store);
  return store;
}

const YYBStorage = {
  KEY,
  guest() { return null; },
  account,
  flush() { return Promise.all([...active].map(s => s.flush())).then(r => r.every(Boolean)); },
  isEmpty,
  merge,
};
root.YYBStorage = YYBStorage;
if (typeof module !== 'undefined' && module.exports) module.exports = YYBStorage;
})(typeof window !== 'undefined' ? window : globalThis);
