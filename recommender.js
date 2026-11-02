/* 音乐bot · recommender.js — daily recommendation engine (owned by 音乐bot算法).
 * Plain browser JS, no build step, no API keys. Also loadable in Node (module.exports) for tests.
 * Global: window.MusicRec (alias window.MusicRecommender).
 * Data: shares localStorage key 'yinyuebot.v1' with app.js (same shape) + its own request cache 'yinyuebot.reccache.v1'.
 * Sources: iTunes Search/Lookup (active storefront, default country=us; fetch -> JSONP fallback), Deezer related/genre (JSONP in browser),
 * MusicBrainz tags as last-resort fallback. Never Spotify.
 */
(function (root) {
'use strict';
const KEY = 'yinyuebot.v1', RC_KEY = 'yinyuebot.reccache.v1', DAY = 86400000;
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

// ---------------- storage ----------------
// baseStore: real localStorage (request cache, guest state). stateStore: optional per-account store for KEY only (setStore).
let baseStore = (() => { try { if (typeof localStorage !== 'undefined') return localStorage; } catch (e) {} const m = new Map();
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; })();
const defaults = () => ({ version: 1, seeds: { genres: [], artists: [], songs: [] }, feedback: {}, history: {},
  settings: { storefront: 'us', searchStore: 'us', count: 10, discovery: 0.6, lang: 'zh' }, migrations: { sfUs: 1 } });
// one-time migration: the user's Apple Music account is US -> stored storefront 'cn' becomes 'us' once (setStorefront('cn') afterwards sticks)
function migrate(raw, s) {
  const done = raw && raw.migrations && raw.migrations.sfUs;
  if (!done && s.settings && String(s.settings.storefront || '').toLowerCase() === 'cn') s.settings.storefront = 'us';
  s.migrations = Object.assign({}, (raw && raw.migrations) || {}, { sfUs: 1 });
  return s;
}
function normalizeState(s) {
  const raw = s || {}, d = defaults(); s = Object.assign(d, s || {});
  s.seeds = Object.assign(defaults().seeds, s.seeds || {}); s.settings = Object.assign(defaults().settings, s.settings || {});
  s.feedback = (s.feedback && typeof s.feedback === 'object' && !Array.isArray(s.feedback)) ? s.feedback : {};
  s.history = cleanHistory(s.history);
  ['genres', 'artists', 'songs'].forEach(k => { if (!Array.isArray(s.seeds[k])) s.seeds[k] = []; });
  if (s.replay && !Array.isArray(s.replay)) delete s.replay;
  if (!Array.isArray(s.artistBans)) s.artistBans = [];
  if (!Array.isArray(s.artistBanIds)) s.artistBanIds = [];
  return migrate(raw, s);
}
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// history must be {'YYYY-MM-DD': {sets:[{at, tracks:[]}]}}; accepts the old UI array form [{date, at, tracks}] and drops anything else.
function cleanHistory(h) {
  const out = {};
  const push = (date, set) => { if (!DATE_RE.test(String(date)) || !set || !Array.isArray(set.tracks)) return;
    (out[date] = out[date] || { sets: [] }).sets.push({ at: +set.at || 0, ...(set.profile ? { profile: set.profile } : {}), tracks: set.tracks.filter(t => t && (t.trackId || t.id) && (t.title || t.name || t.trackName) && (t.appleMusicUrl || t.url || t.trackViewUrl)).map(normTrackRecord) });
    const sets = out[date].sets; if (!sets[sets.length - 1].tracks.length) sets.pop(); if (!sets.length) delete out[date]; };
  if (Array.isArray(h)) h.forEach(e => { if (!e) return; if (Array.isArray(e.sets)) e.sets.forEach(x => push(e.date, x)); else push(e.date, e); });
  else if (h && typeof h === 'object') Object.entries(h).forEach(([d, v]) => { if (v && Array.isArray(v.sets)) v.sets.forEach(x => push(d, x)); });
  return out;
}
// fill both field families (MusicRec + legacy app.js) on a stored track
function normTrackRecord(t) {
  const o = Object.assign({}, t); delete o.feedback;
  o.trackId = o.trackId ?? o.id; o.id = o.id ?? o.trackId;
  o.title = o.title ?? o.name ?? o.trackName; o.name = o.name ?? o.title;
  o.artist = o.artist ?? o.artistName; o.album = o.album ?? o.collectionName;
  o.appleMusicUrl = o.appleMusicUrl ?? o.url ?? o.trackViewUrl; o.url = o.url ?? o.appleMusicUrl;
  o.appUrl = o.appUrl ?? (o.appleMusicUrl ? String(o.appleMusicUrl).replace(/^https:/, 'music:') : undefined);
  o.artwork = o.artwork ?? o.artworkUrl ?? o.art; o.art = o.art ?? o.artwork;
  o.previewUrl = o.previewUrl ?? o.preview ?? ''; o.preview = o.preview ?? o.previewUrl;
  Object.keys(o).forEach(k => o[k] === undefined && delete o[k]); return o;
}
let stateStore = null, storeGen = 0;
const curStore = () => stateStore || baseStore;   // re-read on every call: nothing caches profile state across a store switch
function loadState(st) { try { return normalizeState(JSON.parse((st || curStore()).getItem(KEY))); } catch (e) { return defaults(); } }
function saveState(s, st) { (st || curStore()).setItem(KEY, JSON.stringify(s)); }

// ---------------- utils ----------------
const norm = s => String(s || '').toLowerCase().normalize('NFKC').replace(/\(.*?\)|\[.*?\]|（.*?）/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const qs = o => Object.entries(o).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
function todayStr(d = new Date()) { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; }
function hash(str) { let h = 2166136261; for (const c of String(str)) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let x = a; x = Math.imul(x ^ (x >>> 15), x | 1); x ^= x + Math.imul(x ^ (x >>> 7), x | 61); return ((x ^ (x >>> 14)) >>> 0) / 4294967296; }; }
function weightedPick(items, wf, r) { const tot = items.reduce((s, i) => s + Math.max(0, wf(i)), 0); if (!tot) return null; let x = r() * tot; for (const i of items) { x -= Math.max(0, wf(i)); if (x <= 0) return i; } return items[items.length - 1]; }
// split "A & B, C feat. D" into artist names
// credit string -> artist names, first-billed first ("21 Savage, Offset & Metro Boomin" -> ['21 Savage','Offset','Metro Boomin'])
const KEEP_WHOLE = ['Tyler, The Creator', 'Earth, Wind & Fire', 'Simon & Garfunkel', 'Hall & Oates', 'Daryl Hall & John Oates', 'Crosby, Stills, Nash & Young', 'Crosby, Stills & Nash', 'Mumford & Sons', 'Florence + the Machine', 'Florence and the Machine', 'Marina & The Diamonds', 'Marina and the Diamonds', 'Chase & Status', 'Above & Beyond', 'Chloe x Halle', 'AC/DC', 'Belle & Sebastian', 'Iron & Wine', 'Hootie & the Blowfish', 'Brooks & Dunn', 'Dan + Shay', 'Sam & Dave', 'Peter, Bjorn and John', 'Years & Years', 'Sly & the Family Stone', 'Kool & the Gang', 'Prince & the Revolution', 'Of Monsters and Men', 'Bob Marley & The Wailers', 'Tom Petty and the Heartbreakers', 'Tom Petty & the Heartbreakers', 'Echo & the Bunnymen', 'Huey Lewis & the News', 'Angus & Julia Stone', 'Big & Rich', 'Macklemore & Ryan Lewis', 'She & Him', 'Peter, Paul and Mary', 'Emerson, Lake & Palmer', 'Blood, Sweat & Tears', 'Captain & Tennille', 'Ike & Tina Turner', 'Matt and Kim', 'Christine and the Queens', 'Edward Sharpe & the Magnetic Zeros', 'Grace Potter & the Nocturnals', 'Nathaniel Rateliff & the Night Sweats', 'Bruce Springsteen & the E Street Band', 'Bob Seger & the Silver Bullet Band', 'Joan Jett & the Blackhearts', 'Katrina & the Waves', 'Martha & the Vandellas', 'Smokey Robinson & the Miracles', 'Gladys Knight & the Pips', 'Diana Ross & the Supremes', 'Derek & the Dominos', 'Siouxsie & the Banshees', 'Elvis Costello & the Attractions', 'Kenny Rogers & the First Edition', 'Tegan and Sara', 'Sonny & Cher', 'Ashford & Simpson', 'Peaches & Herb', 'Brandon & Leah', 'Coheed and Cambria', 'Hardy & Hardy', 'Lily & Madeleine', 'The Naked and Famous', 'Jack & Jack', 'Love and Rockets', 'Mike + The Mechanics', 'Me First and the Gimme Gimmes', 'Hootie and the Blowfish', 'Earth Wind & Fire', 'Simon and Garfunkel', 'DJ Jazzy Jeff & The Fresh Prince', 'Eric B. & Rakim'];
const KEEP_SORTED = KEEP_WHOLE.slice().sort((a, b) => b.length - a.length);   // longest first (Daryl Hall & John Oates before Hall & Oates)
const splitArtists = s => { let x = String(s || ''); const keep = [];
  KEEP_SORTED.forEach(n => { const lx = x.toLowerCase(), ln = n.toLowerCase(); let i = -1;
    for (let p = lx.indexOf(ln); p >= 0; p = lx.indexOf(ln, p + 1)) if (!/[\p{L}\p{N}]/u.test(lx[p - 1] || '') && !/[\p{L}\p{N}]/u.test(lx[p + ln.length] || '')) { i = p; break; }   // whole words only
    if (i >= 0) { keep.push(x.substr(i, n.length)); x = x.slice(0, i) + '\u0000' + (keep.length - 1) + '\u0000' + x.slice(i + n.length); } });
  return x.split(/\s*(?:,|，|&|＆|、|[(\[（]?\bfeaturing\b|[(\[（]?\bfeat\b\.?|[(\[（]?\bft\b\.?|;|\s\/\s|\bwith\b|(?<=\s)[x×](?=\s+[^\s&,，、;＆(（])|\s\+\s)\s*/i)
    .map(y => y.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]).replace(/^[\s(（\[]+|[\s)）\]]+$/g, '').trim()).filter((y, i, arr) => y && arr.findIndex(z => z.toLowerCase() === y.toLowerCase()) === i); };   // dedupe
const toAppUrl = u => String(u || '').replace(/^https:/, 'music:');
function cleanUrl(u) { return String(u || '').replace(/([?&])uo=\d+&?/, '$1').replace(/[?&]$/, ''); }

// ---------------- request cache (localStorage, TTL, size-capped) ----------------
let RC = (() => { try { return JSON.parse(baseStore.getItem(RC_KEY)) || {}; } catch (e) { return {}; } })();
let rcDirty = null;
function rcGet(k, days) { const e = RC[k]; return e && (Date.now() - e.at) < days * DAY ? e : null; }
function rcSet(k, v) {
  RC[k] = { at: Date.now(), v };
  if (!rcDirty) rcDirty = setTimeout(() => { rcDirty = null; const ks = Object.keys(RC);
    if (ks.length > 600) ks.sort((a, b) => RC[a].at - RC[b].at).slice(0, ks.length - 500).forEach(x => delete RC[x]);
    try { baseStore.setItem(RC_KEY, JSON.stringify(RC)); } catch (e) { RC = {}; try { baseStore.removeItem(RC_KEY); } catch (_) {} } }, 50);
  return v;
}
async function cached(k, days, fn) { const e = rcGet(k, days); if (e) return e.v; const v = await fn(); return rcSet(k, v); }

// ---------------- network ----------------
let jsonpN = 0;
function jsonp(url, cbParam = 'callback', timeout = 12000) {
  if (!isBrowser) return Promise.reject(new Error('jsonp unavailable outside browser'));
  return new Promise((res, rej) => {
    const cb = '__mrec' + (++jsonpN) + '_' + Date.now(), s = document.createElement('script');
    const done = () => { delete window[cb]; s.remove(); clearTimeout(tm); };
    const tm = setTimeout(() => { done(); rej(new Error('jsonp timeout')); }, timeout);
    window[cb] = d => { done(); res(d); }; s.onerror = () => { done(); rej(new Error('jsonp error')); };
    s.src = url + (url.includes('?') ? '&' : '?') + cbParam + '=' + cb; document.head.appendChild(s);
  });
}
async function fetchJSON(url, opts) { const r = await fetch(url, opts); if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; } return r.json(); }
// iTunes: ~20 req/min advisory. Serialize, space calls, back off on 403/429. CORS is allowed (ACAO *), JSONP as fallback.
let itQ = Promise.resolve(), itLast = 0, itUseJsonp = false; const IT_GAP = 400;
const stats = { itunes: 0, deezer: 0, mb: 0, errors: 0 };
function itunes(path, params) {
  const url = `https://itunes.apple.com/${path}?${qs(params)}`;
  const run = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wait = Math.max(0, itLast + IT_GAP - Date.now()); if (wait) await sleep(wait); itLast = Date.now(); stats.itunes++;
      // JSONP for the rest of the session after one CORS failure, and always for the tw/hk CJK fallback (avoids console CORS noise)
      if (isBrowser && (itUseJsonp || /^(tw|hk)$/.test(params.country || ''))) { try { return await jsonp(url); } catch (e2) { stats.errors++; throw e2; } }
      try { return await fetchJSON(url); }
      catch (e) {
        if (e.status === 403 || e.status === 429 || e.status >= 500) { await sleep(2500 * (attempt + 1)); continue; }
        // no HTTP status = CORS/network failure: switch to JSONP for the rest of the session
        if (isBrowser) { if (!e.status) itUseJsonp = true; try { return await jsonp(url); } catch (e2) { stats.errors++; throw e2; } }
        stats.errors++; throw e;
      }
    }
    stats.errors++; throw new Error('itunes rate limited');
  };
  const p = itQ.then(run, run); itQ = p.catch(() => {}); return p;
}
// Deezer: no Access-Control-Allow-Origin header -> JSONP in browser (output=jsonp&callback=), plain fetch in Node.
let dzQ = Promise.resolve(), dzLast = 0;
function deezer(path, params = {}) {
  const run = async () => {
    const wait = Math.max(0, dzLast + 120 - Date.now()); if (wait) await sleep(wait); dzLast = Date.now(); stats.deezer++;
    const d = isBrowser ? await jsonp(`https://api.deezer.com/${path}?${qs({ ...params, output: 'jsonp' })}`)
                        : await fetchJSON(`https://api.deezer.com/${path}?${qs(params)}`);
    if (d && d.error) throw new Error('deezer ' + (d.error.message || d.error.type)); return d;
  };
  const p = dzQ.then(run, run); dzQ = p.catch(() => {}); return p;
}
// MusicBrainz: CORS ok, 1 req/s, often 503 when busy.
let mbLast = 0;
let mbDown = false;  // browser: after one failed MusicBrainz call (503s come without CORS headers -> console errors) skip MB for the session
async function mb(path, params) {
  if (isBrowser && mbDown) throw new Error('musicbrainz skipped (failed earlier this session)');
  try { return await mbRaw(path, params); } catch (e) { if (isBrowser) mbDown = true; throw e; }
}
async function mbRaw(path, params) {
  const wait = Math.max(0, mbLast + 1100 - Date.now()); if (wait) await sleep(wait); mbLast = Date.now(); stats.mb++;
  const h = isBrowser ? {} : { 'User-Agent': 'yinyuebot/0.1 (static site)' };
  return fetchJSON(`https://musicbrainz.org/ws/2/${path}?${qs({ ...params, fmt: 'json' })}`, { headers: h });
}

// ---------------- genre aliases (seed text -> cn primaryGenreName + search query) ----------------
const GENRE_ALIAS = [
  [/华语|国语|mandopop|c-?pop|中文流行/i, ['国语流行', '华语流行', 'Mandopop'], 'mandopop'],
  [/粤语|cantopop/i, ['粤语流行', 'Cantopop'], 'cantopop'],
  [/k-?pop|韩/i, ['K-Pop', '韩国流行'], 'k-pop'],
  [/j-?pop|日本|日系/i, ['J-Pop', '日本流行'], 'j-pop'],
  [/city ?pop/i, ['J-Pop', '日本流行', '流行'], 'city pop'],
  [/indie|独立/i, ['独立流行', '独立摇滚', '另类音乐', 'Alternative', 'Indie Pop', 'Indie Rock', '流行', '国际流行'], null],
  [/alternative|另类/i, ['另类音乐', 'Alternative'], 'alternative'],
  [/rock|摇滚/i, ['摇滚', 'Rock', '另类音乐'], 'rock'],
  [/hip-?hop|rap|嘻哈|说唱/i, ['嘻哈/说唱', 'Hip-Hop/Rap', '说唱', '中文嘻哈', 'Hip-Hop'], 'rap hits'],
  [/r&b|rnb|soul|灵魂/i, ['R&B/灵魂乐', 'R&B/Soul'], 'r&b'],
  [/electro|edm|dance|电子|舞曲/i, ['电子音乐', 'Electronic', '舞曲', 'Dance'], 'electronic'],
  [/lo-?fi/i, ['电子音乐', 'Electronic', '嘻哈/说唱'], 'lofi'],
  [/jazz|爵士/i, ['爵士乐', 'Jazz'], 'jazz'],
  [/classical|古典/i, ['古典音乐', 'Classical'], 'classical'],
  [/folk|民谣/i, ['民谣', 'Folk', '创作歌手', 'Singer/Songwriter'], 'folk'],
  [/soundtrack|原声|ost/i, ['原声带', 'Soundtrack'], 'soundtrack'],
  [/latin|拉丁|urbano/i, ['拉丁都市音乐', '拉丁音乐', 'Latin'], 'latin'],
  [/\bpop\b|流行/i, ['流行', '国际流行', 'Pop'], 'pop'],
];
function genreTargets(g) { const out = new Set([norm(g)]); GENRE_ALIAS.forEach(([re, gs]) => { if (re.test(g)) gs.forEach(x => out.add(norm(x))); }); return [...out]; }
function genreQuery(g) { for (const [re, , q] of GENRE_ALIAS) if (q && re.test(g)) return (/[^\x00-\x7f]/.test(g) || /hip|rap/i.test(g)) ? q : g; return g; }

// ---------------- data access ----------------
const hasCJK = s => /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uac00-\ud7af]/.test(String(s || ''));
// storefronts to search: active storefront (default us) first; CJK queries also try tw/hk (traditional-Chinese catalog).
// The extra searchStore (us) is only needed for cn, whose song search returns nothing.
const searchStores = (S, q, sf) => { sf = sf || S.settings.storefront || 'us';
  return [...new Set([sf, ...(hasCJK(q) ? ['tw', 'hk'] : []), ...(sf === 'cn' ? [S.settings.searchStore || 'us'] : [])])]; };
const COMPILATION = /\bhits\b|collection|greatest|best of|various artists|compilation|\btop \d+|playlist|now that'?s|合辑|合輯|精选|精選|金曲|热歌|榜单/i;
const isCompilation = t => COMPILATION.test(t.collectionName || '') || /^various artists$/i.test(t.artistName || '') || /various|群星|多位艺人|多位藝人/i.test(t.collectionArtistName || '') || /\banthology\b|motivation|workout|\bgym\b/i.test(t.collectionName || '');
// Search songs across storefronts (merged), verify every hit in `sf`, filter bad versions, rank exact title matches first.
async function searchSongCandidates(q, S, sf, limit) {
  const [qt, qa] = q.split(/\s+[-–—]\s+/), tokens = q.replace(/\s*[-–—]\s*/g, ' ').split(/\s+/).map(norm).filter(Boolean), qn = norm(q);
  const term = q.replace(/\s*[-–—]\s*/g, ' '), merged = new Map(), native = {};
  for (const country of searchStores(S, q, sf)) {
    try { ((await itunes('search', { term, entity: 'song', country, limit: 25 })).results || []).forEach(x => { if (x.kind === 'song' && !merged.has(x.trackId)) { merged.set(x.trackId, x);
      if (country === sf && x.trackViewUrl && x.isStreamable !== false) native[x.trackId] = slim(x); } }); } catch (e) {}
    if (!hasCJK(q) && merged.size >= limit) break;
  }
  const meta = a => Object.assign(a, { storefront: sf });
  // which part of the query is the artist? "Title - Artist" form; else a leading/trailing word group that names an artist seen in
  // the raw hits; else the last/first 1-3 words (CJK: the segment after/before the space) resolved to a real iTunes artist.
  const raw = () => [...merged.values()], rawNames = x => splitArtists(x.artistName).map(norm), bare = x => norm(String(x || '').replace(/\s*[(\[（].*$/, ''));
  const addHits = (arr, country) => arr.forEach(x => { if (x.kind === 'song' && !merged.has(x.trackId)) { merged.set(x.trackId, x);
    if (country === sf && x.trackViewUrl && x.isStreamable !== false) native[x.trackId] = slim(x); } });
  let queryArtist = qa ? qa.trim() : '', queryTitle = qa ? (qt || '').trim() : '', artistIds = new Set();
  if (queryArtist) { const a = await resolveArtist(queryArtist, S).catch(() => null); if (a) artistIds.add(a.id); }
  else if (!raw().some(x => bare(x.trackName) === qn)) {   // the whole query is itself a title -> no artist
    const words = term.trim().split(/\s+/), cands = [], W = words.length;
    for (let n = W - 1; n >= 1; n--) cands.push([words.slice(W - n).join(' '), words.slice(0, W - n)]);  // trailing artist, longest first
    for (let n = W - 1; n >= 1; n--) cands.push([words.slice(0, n).join(' '), words.slice(n)]);           // leading artist
    const nameHit = k => raw().some(x => rawNames(x).some(n => n === k));
    let hit = cands.find(([aw]) => norm(aw).length > 1 && nameHit(norm(aw)));
    if (!hit && W >= 2) {
      // real-artist check on the last/first 1-3 words; strict: exact name, 简/繁 variant, or a >=2-word latin name that iTunes maps to a CJK artist (Jay Chou -> 周杰倫)
      const short = [...cands.slice(Math.max(0, W - 1 - 3), W - 1), ...cands.slice(W - 1).filter(c => c[0].split(/\s+/).length <= 3)];
      // pass 0: only matches confirmed by a song in the artist's catalogue (so "Jay Chou Sunny Day" beats a band called "Sunny Day");
      // pass 1: an exact trailing multi-word / CJK name with no such song (-> artistMissing). A leading artist always needs a song.
      for (const pass of [0, 1]) { if (hit) break;
      for (const c of short) { const aw = c[0], ak = norm(aw), title = c[1].join(' '), leading = cands.indexOf(c) >= W - 1;
        if (pass && leading) continue;
        if (ak.length < 2 || !norm(title)) continue;
        const a = await resolveArtist(aw, S).catch(() => null); if (!a) continue;
        const an = norm(a.name), latin2 = !hasCJK(aw) && aw.split(/\s+/).length >= 2;
        const exact = an === ak || (hasCJK(aw) && an.length === ak.length && [...an].filter((ch, i) => ch === ak[i]).length / an.length >= 0.5);
        const romanised = !exact && latin2 && hasCJK(a.name);   // iTunes' best guess, must be confirmed by a song
        if (!exact && !romanised) continue;
        // confirm with the artist's own catalogue: songs whose title (any storefront) is the rest of the query
        const stores = [sf, ...(hasCJK(title) && sf !== 'cn' ? ['tw', 'hk'] : [])]; let found = 0;
        for (const country of stores) { try { const r = ((await itunes('lookup', { id: a.id, entity: 'song', country, limit: 200 })).results || [])
          .filter(x => x.kind === 'song' && bare(x.trackName) === norm(title)); found += r.length; addHits(r, country); } catch (e) {} }
        // a single latin word or a romanised guess must be confirmed by a real song (avoids "Sunny Day" -> artist "Day"); exact multi-word / CJK names may be missing (-> artistMissing)
        if (!found && (!pass || romanised || (!hasCJK(aw) && !latin2))) continue;
        hit = c; artistIds.add(a.id); break; } }
    }
    if (!hit && hasCJK(q) && W === 2) {
      // "晴天 土黑娃": CJK title + unknown name after the space -> accept when the leading segment alone is a real song title
      try { const r = ((await itunes('search', { term: words[0], entity: 'song', country: sf === 'cn' ? 'cn' : 'tw', limit: 25 })).results || []).filter(x => bare(x.trackName) === norm(words[0]));
        if (r.length && norm(words[1]).length >= 2) { addHits(r, sf === 'cn' ? 'cn' : 'tw'); hit = [words[1], [words[0]]]; } } catch (e) {}
    }
    if (hit) { queryArtist = hit[0]; queryTitle = hit[1].join(' '); } }
  if (!merged.size) { const e = meta([]); if (queryArtist) Object.assign(e, { queryArtist, queryTitle, artistMissing: true }); return e; }
  // hits from the active storefront are already valid there; only tw/hk (or us-for-cn) hits need a lookup in sf
  const other = [...merged.keys()].filter(id => !native[id]);
  const ver = Object.assign({}, native, other.length ? await verifyTracks(other, sf) : {});
  const qak = norm(queryArtist);
  const artistMatch = t => { if (!qak) return undefined; if (artistIds.has(t.artistId)) return true; const src = merged.get(t.trackId);
    return [t.artistName, src && src.artistName].some(n => splitArtists(n).map(norm).some(a => a === qak)); };   // exact (normalized) name or artistId only
  const qtk = norm(queryTitle || qt || '');
  // title as found in ANY storefront counts (hk/tw "晴天" = us "Sunny Day", same trackId)
  const titleExact = t => { const src = merged.get(t.trackId); return [t.trackName, src && src.trackName].some(x => titleExact1(x)); };
  const titleExact1 = x => { const n = norm(x); return qak ? n === qtk || n.replace(/\(.*$/, '') === qtk : (qt && qa) ? n === norm(qt) : tokens.includes(n) || qn.startsWith(n) && n.length >= 2; };
  const list = [...merged.keys()].filter(id => ver[id]).map(id => ver[id]);
  // hint when this artist has no song with this title here (artist absent, or only other songs by them)
  const anyMatch = qak && list.some(t => artistMatch(t) && (!qtk || titleExact(t) || norm(t.trackName).includes(qtk)));
  const out = list.map((t, i) => { const am = artistMatch(t), te = titleExact(t);
    // title-only matches (artist named in the query but not this artist) are down-weighted, more so when the artist is absent entirely
    const sc = (te ? (qak && !am ? 4 : 10) : qtk && norm(t.trackName).includes(qtk) ? 3 : 0) + (am ? 6 : 0) - (qak && !am ? 2 : 0)
      - (badReason(t) ? 8 : 0) - (isCompilation(t) ? 4 : 0) - i * 0.05;
    return { t, sc, am }; }).sort((a, b) => b.sc - a.sc).slice(0, limit).map(x => (x.am === undefined ? x.t : Object.assign({}, x.t, { artistMatch: x.am })));
  meta(out); if (qak) { out.queryArtist = queryArtist; out.queryTitle = queryTitle; if (!anyMatch) out.artistMissing = true; }
  return out;
}
// artist name -> {id, name, genre} (iTunes artistId is global across storefronts)
async function resolveArtist(name, S) {
  const k = norm(name); if (!k) return null;
  return cached('a2:' + k, 60, async () => {
    for (const country of searchStores(S, name)) {
      try {
        const res = (await itunes('search', { term: name, entity: 'musicArtist', country, limit: 5 })).results || [];
        const loose = a => { const n = norm(a.artistName), lo = Math.min(n.length, k.length), hi = Math.max(n.length, k.length); return n === k || (lo > 2 && lo / hi >= 0.6 && (n.includes(k) || k.includes(n))); };
        // simplified/traditional variant (周杰伦 ↔ 周杰倫): same length, mostly same characters — preferred over looser substring hits (周杰伦战队)
        const variant = a => { const n = norm(a.artistName); if (!hasCJK(name) || n.length !== k.length) return false; let same = 0; for (let i = 0; i < n.length; i++) if (n[i] === k[i]) same++; return same / n.length >= 0.5; };
        const m = res.find(a => norm(a.artistName) === k) || res.find(variant) || res.find(loose) || (res[0] && /[^\x00-\x7f]/.test(res[0].artistName) && !/[^\x00-\x7f]/.test(name) ? res[0] : null); // e.g. "Jay Chou" -> 周杰倫
        if (m) return { id: m.artistId, name: m.artistName, genre: m.primaryGenreName };
      } catch (e) { /* try next */ }
    }
    return null;
  });
}
// "Title - Artist" -> {id, title, artistId, artist} (searched in the active storefront; tw/hk hits verified there)
async function resolveSong(q, S) {
  const k = norm(q);
  return cached('s3:' + (S.settings.storefront || 'us') + ':' + k, 30, async () => {
    const c = await searchSongCandidates(q, S, S.settings.storefront || 'us', 5); if (c.artistMissing) return null;
    const m = c[0];
    return m ? { id: m.trackId, title: m.trackName, artistId: m.artistId, artist: m.artistName, genre: m.primaryGenreName } : null;
  });
}
async function relatedArtists(name) {
  const k = norm(name);
  return cached('r2:' + k, 14, async () => {
    try {
      const s = await deezer('search/artist', { q: name, limit: 8 });
      // several Deezer artists can share a name (e.g. two "Gunna"s); take the exact match with the most fans
      const exact = (s.data || []).filter(x => norm(x.name) === k).sort((x, y) => (y.nb_fan || 0) - (x.nb_fan || 0));
      const a = exact[0] || (s.data || [])[0];
      if (a) { const r = await deezer(`artist/${a.id}/related`, { limit: 15 }); const v = (r.data || []).map(x => x.name); if (v.length) return v; }
    } catch (e) { stats.errors++; }
    // fallback: MusicBrainz top tag of the artist -> other artists with that tag
    try {
      const d = await mb('artist', { query: `artist:"${name}"`, limit: 1 });
      const tags = ((d.artists || [])[0] || {}).tags || []; tags.sort((a, b) => b.count - a.count);
      if (tags[0]) return (await mbTagArtists(tags[0].name)).filter(n => norm(n) !== k).slice(0, 12);
    } catch (e) { stats.errors++; }
    return [];
  });
}
async function mbTagArtists(tag) { const d = await mb('artist', { query: `tag:"${tag}"`, limit: 25 }); return (d.artists || []).map(a => a.name); }
// genre -> artist names (Deezer playlists -> iTunes search -> MusicBrainz tag)
const LOFI = /lo-?fi|chill ?hop|chillout|study|sleep|relax|focus|beats to|ambient|jazzhop|jazz hop|instrumental|piano|cafe|coffee|vibes|meditation|spa\b|白噪音|轻音乐/i;
async function genreArtists(g, S) {
  const k = norm(g), q = genreQuery(g), wantsLofi = LOFI.test(g);
  return cached('g4:' + k + ':' + norm(q), 7, async () => {
    const count = {};
    try {
      const p = await deezer('search/playlist', { q, limit: 15 });
      const lists = (p.data || []).filter(pl => wantsLofi || !LOFI.test(pl.title || ''))
        .sort((a, b) => (/deezer/i.test((b.user || {}).name || '') ? 1 : 0) - (/deezer/i.test((a.user || {}).name || '') ? 1 : 0));  // stable: keeps Deezer relevance order
      for (const pl of lists.slice(0, 2)) {
        const tr = await deezer(`playlist/${pl.id}/tracks`, { limit: 80 });
        (tr.data || []).forEach(x => { const n = x.artist && x.artist.name; if (!n || (!wantsLofi && (LOFI.test(n) || LOFI.test((x.album || {}).title || '')))) return;
          // weight by Deezer popularity rank so obscure filler/lo-fi artists don't dominate
          count[n] = (count[n] || 0) + Math.min(1.5, Math.max(0.1, (x.rank || 200000) / 600000)); });
      }
    } catch (e) { stats.errors++; }
    if (Object.keys(count).length < 8) {
      try { ((await itunes('search', { term: q, entity: 'song', country: S.settings.searchStore || 'us', limit: 50 })).results || [])
        .forEach(x => { if (x.artistName) count[x.artistName] = (count[x.artistName] || 0) + 0.7; }); } catch (e) {}
    }
    if (Object.keys(count).length < 5) { try { (await mbTagArtists(q)).forEach((n, i) => count[n] = (count[n] || 0) + (25 - i) / 25); } catch (e) { stats.errors++; } }
    return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 30).map(x => x[0]);
  });
}
// artistIds -> songs in storefront sf (lookup is per-storefront; anything returned with an sf trackViewUrl is playable there)
async function topSongs(ids, sf) {
  const out = {}, need = [];
  ids.forEach(id => { const e = rcGet(`t3:${sf}:${id}`, 3); if (e) out[id] = e.v; else need.push(id); });
  for (let i = 0; i < need.length; i += 10) {
    const batch = need.slice(i, i + 10); const got = {}; batch.forEach(id => got[id] = []);
    try {
      const d = await itunes('lookup', { id: batch.join(','), entity: 'song', country: sf, limit: 25 });
      let cur = null;
      for (const r of d.results || []) {
        if (r.wrapperType === 'artist') { cur = r.artistId; continue; }
        if (r.wrapperType !== 'track' || r.kind !== 'song' || !r.trackViewUrl || r.isStreamable === false) continue;
        const owner = batch.includes(r.artistId) ? r.artistId : cur; if (owner == null || !got[owner]) continue;
        got[owner].push(slim(r));
      }
      batch.forEach(id => { out[id] = got[id]; rcSet(`t3:${sf}:${id}`, got[id]); });
    } catch (e) { stats.errors++; }
  }
  return out;
}
const slim = r => ({ trackId: r.trackId, trackName: r.trackName, artistId: r.artistId, artistName: r.artistName, collectionName: r.collectionName,
  collectionArtistName: r.collectionArtistName || '', primaryGenreName: r.primaryGenreName, releaseDate: r.releaseDate, trackTimeMillis: r.trackTimeMillis || 0, trackViewUrl: r.trackViewUrl, previewUrl: r.previewUrl || '',
  artworkUrl100: r.artworkUrl100 || '' });
// verify a list of trackIds in storefront; returns map id -> slim track (missing = not available there)
async function verifyTracks(ids, sf = 'us') {
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    try { const d = await itunes('lookup', { id: ids.slice(i, i + 50).join(','), country: sf, entity: 'song' });
      (d.results || []).forEach(r => { if (r.kind === 'song' && r.trackViewUrl && r.isStreamable !== false) out[r.trackId] = slim(r); }); } catch (e) { stats.errors++; }
  }
  return out;
}

// ---------------- taste model ----------------
// Returns {artists: normName -> {name, w, kind, why}, genres: normGenre -> w, bannedArtists:Set(norm), bannedIds:Set(artistId), excludeIds:Set(trackId)}
function tasteModel(S, replay) {
  const A = {}, G = {}, neg = {}, negIds = {}, exclude = new Set();
  const rank = { liked: 5, seed: 4, song: 3, replay: 2, related: 1, genre: 0 };
  const addA = (name, w, kind, why) => { const k = norm(name); if (!k) return; const e = A[k] || (A[k] = { name, w: 0, kind, why: why || name });
    e.w += w; if (w > 0 && (rank[kind] ?? 0) > (rank[e.kind] ?? 0)) { e.kind = kind; e.why = why || name; } };
  const addG = (g, w) => { const k = norm(g); if (k) G[k] = (G[k] || 0) + w; };
  // Current signals = Replay + feedback from the last RECENT_DAYS. Seeds they don't support decay (old, stale taste).
  const now = Date.now(), sig = currentSignals(S, replay), hasCurrent = sig.artists.size > 0;
  const pinned = new Set(((S.seedsMeta && S.seedsMeta.pinned) || []).map(norm));
  (S.seeds.artists || []).forEach(a => { const k = norm(a), supported = pinned.has(k) || sig.artists.has(k);
    addA(a, !hasCurrent || supported ? 3 : 3 * SEED_DECAY, 'seed'); });
  (S.seeds.genres || []).forEach(g => { const tg = genreTargets(g), supported = !sig.genres.size || tg.some(x => sig.genres.has(x));
    tg.forEach((x, i) => addG(x, (i === 0 ? 2 : 1.2) * (supported ? 1 : SEED_DECAY))); });
  // Replay: rank is ONLY a positive boost (rank 1 ≈ +3.5 … low rank → small positive, never < 0). Low rank ≠ dislike.
  (replay || []).forEach(t => { const w = replayBoost(t.rank);
    (t.artists && t.artists.length ? t.artists : splitArtists(t.artistName)).forEach((a, i) => addA(a, i ? w * 0.5 : w, 'replay'));
    if (t.cnGenre || t.genre) addG(t.cnGenre || t.genre, 0.25 * w); if (t.trackId) exclude.add(String(t.trackId)); });
  // protected = top-10 Replay artists (by summed positive rank boost) + every artist billed on a top-10 Replay track
  const rAgg = {}; (replay || []).forEach(t => (t.artists && t.artists.length ? t.artists : splitArtists(t.artistName)).forEach((a, i) => { const k = norm(a); if (k) rAgg[k] = (rAgg[k] || 0) + replayBoost(t.rank) * (i ? 0.5 : 1); }));
  const protectedA = new Set(Object.keys(rAgg).sort((a, b) => rAgg[b] - rAgg[a]).slice(0, 10));
  (replay || []).filter(t => +t.rank >= 1 && +t.rank <= 10).forEach(t => (t.artists && t.artists.length ? t.artists : splitArtists(t.artistName)).forEach(a => protectedA.add(norm(a))));
  Object.entries(S.feedback || {}).forEach(([id, f]) => {
    if (!f || typeof f !== 'object') return;
    exclude.add(String(id)); const tr = f.track || {};
    const age = f.at ? Math.max(0, (now - f.at) / DAY) : 365, recency = Math.pow(0.5, age / 180); // likes fade (half-life 180 d); dislikes don't
    let d = f.v === 1 ? 2.5 : f.v === -1 ? -4 : 0; if (f.r) d += (f.r - 3) * 1.0; if (d > 0) d *= Math.max(0.3, recency);
    const names = splitArtists(tr.artist || tr.artistName);
    const collab = names.length > 1;
    names.forEach((a, i) => { const k = norm(a);
      if (d >= 0) { addA(a, i ? d * 0.5 : d, 'liked', a); neg[k] = (neg[k] || 0) - 2; return; }
      // dislike of a SONG: counts fully only against the primary (first-billed) artist; featured artists get a small penalty
      // and no ban count; a collab dislike never bans (only half-penalises) a top-10 Replay artist
      if (i > 0) { addA(a, d * 0.25, 'liked', a); return; }
      if (collab && protectedA.has(k)) { addA(a, d * 0.5, 'liked', a); return; }
      addA(a, d, 'liked', a); neg[k] = (neg[k] || 0) + (f.v === -1 ? 2 : 0) + (f.r && f.r <= 2 ? 1 : 0); });
    if (tr.artistId && d < 0) negIds[tr.artistId] = norm(names[0] || '');
    if (tr.genre) addG(tr.genre, d * 0.35);
  });
  const bannedArtists = new Set(Object.keys(neg).filter(k => neg[k] >= 2));
  (S.artistBans || []).forEach(a => { const k = norm(a); if (k) { bannedArtists.add(k); if (A[k]) A[k].w = Math.min(A[k].w, -4); } }); // explicit artist-level dislike always bans
  const bannedIds = new Set(Object.keys(negIds).filter(k => bannedArtists.has(negIds[k])).map(Number));
  (S.artistBanIds || []).forEach(id => { if (+id) bannedIds.add(+id); });                      // explicit ban by iTunes artistId
  // same song on another album/version counts as already rated/heard
  const excludeTitles = new Set();
  Object.values(S.feedback || {}).forEach(f => { const tr = f.track || {}; if (tr.title || tr.name) excludeTitles.add(titleKey(tr.title || tr.name, tr.artist || tr.artistName)); });
  (replay || []).forEach(t => { if (t.title) excludeTitles.add(titleKey(t.title, (t.artists && t.artists[0]) || t.artistName)); });
  return { artists: A, genres: G, bannedArtists, bannedIds, excludeIds: exclude, excludeTitles, protectedArtists: protectedA };
}
const SEED_DECAY = 0.25, RECENT_DAYS = 120;
// Positive-only Replay boost: rank 1 → 3.5, rank 100 → 0.35, beyond → 0.2; missing rank → 0.6. Never negative, never centered.
function replayBoost(rank) { const rk = +rank; if (!rk || rk < 1) return 0.6; return Math.max(0.2, 0.35 + 3.15 * Math.max(0, 1 - (rk - 1) / 99)); }
function currentSignals(S, replay) {
  const artists = new Set(), genres = new Set(), now = Date.now();
  (replay || []).forEach(t => { (t.artists && t.artists.length ? t.artists : splitArtists(t.artistName)).forEach(a => artists.add(norm(a)));
    const g = t.cnGenre || t.genre; if (g) genreTargets(g).forEach(x => genres.add(x)); });
  Object.values(S.feedback || {}).forEach(f => { if (!f || typeof f !== 'object' || !(f.v === 1 || f.r >= 4)) return; if (f.at && now - f.at > RECENT_DAYS * DAY) return;
    const tr = f.track || {}; splitArtists(tr.artist || tr.artistName).forEach(a => artists.add(norm(a))); if (tr.genre) genreTargets(tr.genre).forEach(x => genres.add(x)); });
  return { artists, genres };
}
function profileHash(S, replay) { return hash(JSON.stringify([S.seeds.genres, S.seeds.artists, S.seeds.songs, (replay || []).map(t => t.trackId)])).toString(36); }
const genreAffinity = (g, G) => { const k = norm(g); if (!k) return 0; let w = G[k] || 0; if (!w) for (const [x, v] of Object.entries(G)) if (x.length > 1 && (k.includes(x) || x.includes(k))) w = Math.max(w, v * 0.6); return w; };
// Unwanted versions: live/concert/tour albums, remixes/DJ mixes, instrumentals, karaoke, sped-up etc., and tracks > 7 min.
const BAD_VERSION = /\blive\b|live at|live from|unplugged|现场|演唱会|巡演|concert|\btour\b|remix|\bmixed by\b|\(mixed\)|dj mix|\binst\.?(?=\W|$)|instrumental|karaoke|伴奏|纯音乐|sped up|slowed|nightcore|\bacoustic ver|\bdemo\b|\([^)]*\bmix\)|\[[^\]]*\bmix\]|\b(?:japanese|korean|english|chinese|spanish|thai) ver(?:sion)?\b|[(\[（]acoustic(?: ver(?:sion)?\.?)?[)\]）]|[(\[（](?!原版|完整版|正式版)[^)\]）]{0,8}版[)\]）]|[(\[](?:[^)\]]*\s)?(?!(?:remaster(?:ed)?|album|single|original|explicit|clean|radio|main|taylor'?s|\d{4})\s)[\w'.&-]+\s+ver(?:sion)?\.?\s*[)\]]/i;
// ^ language/member versions ("Korean Ver.", "(HUH YUNJIN ver.)") are alt cuts; "Remastered (2011) Version", "Album/Single/Radio Version", "Taylor's Version" stay allowed
const MAX_MS = 7 * 60 * 1000;
const badReason = t => BAD_VERSION.test(t.trackName + ' || ' + (t.collectionName || '')) ? 'version' : (t.trackTimeMillis && t.trackTimeMillis > MAX_MS ? 'long' : '');
const isMix = t => !!badReason(t), isLive = () => false;
// version TYPE of an unwanted cut (for the "user likes this kind of version" exemption); '' = normal studio version
const VERSION_KINDS = [['live', /\blive\b|live at|live from|unplugged|现场|現場|演唱会|演唱會|巡演|concert|\btour\b/i], ['extended', /extended (?:ver(?:sion)?|edit|cut)/i], ['remix', /remix|dj版|dj 版|\bmix\)|\bmix\]|\bmixed by\b|\(mixed\)|dj mix/i],
  ['piano', /piano|钢琴|鋼琴/i], ['acoustic', /\bacoustic\b|不插电/i], ['instrumental', /\binst\.?(?=\W|$)|instrumental|纯音乐|純音樂/i], ['karaoke', /karaoke|伴奏|卡拉ok/i],
  ['speed', /sped up|slowed|nightcore/i], ['demo', /\bdemo\b/i], ['altver', /\bver(?:sion)?\b|版/i]];
// mild types: still a penalty, but not "last resort" (an Extended Version is the same recording, just longer)
const MILD_KINDS = new Set(['extended']);
function versionKind(title, album) { const x = String(title || '') + ' || ' + String(album || ''); if (!BAD_VERSION.test(x) && !/piano ver|piano version|\(piano\)|钢琴版|鋼琴版/i.test(x)) return '';
  for (const [k, re] of VERSION_KINDS) if (re.test(x)) return k; return 'other'; }
// version types the user chose themselves (seed songs, liked/≥4★ tracks, top-25 Replay tracks) -> {kind: Set(normArtist) | '*' when ≥2 artists}
function versionPrefs(S, replay, seedTracks) {
  // per version type: first-billed artist -> number of tracks; a type opens globally only with tracks from >= 2 different first-billed artists
  const by = {}; const add = (title, album, artist) => { const k = versionKind(title, album); if (!k) return; const p = norm(splitArtists(artist || '')[0] || '') || '?';
    (by[k] = by[k] || {}); by[k][p] = (by[k][p] || 0) + 1; };
  const seen = new Set();
  (seedTracks || []).forEach(x => { seen.add(norm(x.title)); add(x.title, '', x.artist); });
  (S.seeds.songs || []).forEach(q => { const [t, a] = String(q).split(/\s+[-–—]\s+/); if (!seen.has(norm(t))) add(t, '', a); });
  Object.values(S.feedback || {}).forEach(f => { if (f && (f.v === 1 || f.r >= 4) && f.track) add(f.track.title || f.track.name, f.track.album, f.track.artist || f.track.artistName); });
  (replay || []).filter(t => +t.rank >= 1 && +t.rank <= 25).forEach(t => add(t.title, t.album, (t.artists && t.artists[0]) || t.artistName));
  const out = {}; Object.entries(by).forEach(([k, m]) => { const prim = Object.keys(m).filter(x => x !== '?'); out[k] = prim.length >= 2 ? '*' : new Set(prim); }); return out;
}
// penalise an unwanted version unless the user chose that version type (for this artist, or globally)
function versionPenalised(t, VP) { const k = versionKind(t.trackName, t.collectionName); if (!k) return false; const v = VP && VP[k];
  if (MILD_KINDS.has(k)) { if (v === '*' || (v && v.has(norm(splitArtists(t.artistName)[0] || '')))) return false; return 'mild'; }
  if (v === '*') return false; if (v && v.has(norm(splitArtists(t.artistName)[0] || ''))) return false; return true; }
const titleKey = (title, artist) => norm(title) + '|' + norm(splitArtists(artist)[0] || artist);

// ---------------- core ----------------
/**
 * recommend(state, {date, count, replay, setNo, exclude:[trackId]}) -> Promise<Track[]>
 * Pure w.r.t. state (does not save). Deterministic for (date, setNo, profile) given the same API data (API data is cached).
 */
async function recommend(state, opts = {}) {
  const S = normalizeState(JSON.parse(JSON.stringify(state || {})));
  const date = opts.date || todayStr(), setNo = opts.setNo || 0, sf = (S.settings.storefront || 'us').toLowerCase();
  const n = Math.max(1, Math.min(30, +(opts.count || S.settings.count || 10)));
  const disc = Math.max(0, Math.min(1, opts.discovery ?? S.settings.discovery ?? 0.6));
  const replay = opts.replay || S.replay || [];
  const extraEx = (opts.exclude || []).map(String).sort();
  const r = rng(hash(date + '|' + setNo + '|' + profileHash(S, replay) + (extraEx.length ? '|x' + hash(extraEx.join(',')) : '')));
  const M = tasteModel(S, replay), A = M.artists; extraEx.forEach(id => M.excludeIds.add(id));
  const D = opts.descriptors === false ? null : (opts.descriptors || await loadDescriptors());
  const banned = k => M.bannedArtists.has(k);
  const add = (name, w, kind, why) => { const k = norm(name); if (!k || banned(k)) return; const e = A[k] || (A[k] = { name, w: 0, kind, why }); if (e.w < 0) return; e.w += w; };

  // seed songs -> their artists (+ exclude the seed songs themselves)
  const seedTracks = [];
  for (const s of S.seeds.songs || []) { const tr = await resolveSong(s, S); if (tr) { seedTracks.push(tr); M.excludeIds.add(String(tr.id)); add(tr.artist, 2.5, 'song', tr.title); if (A[norm(tr.artist)] && A[norm(tr.artist)].kind === 'genre') A[norm(tr.artist)].kind = 'song'; } }
  // genre seeds -> genre artists (discovery pool)
  for (const g of S.seeds.genres || []) { (await genreArtists(g, S)).slice(0, 18).forEach((a, i) => add(a, 1.3 * (1 - i / 24), 'genre', g)); }
  // related artists of up to 6 positive anchors, weighted pick (daily rotation)
  const anchors = Object.values(A).filter(e => e.w > 0 && !['genre', 'related'].includes(e.kind));
  const chosen = [], pool = [...anchors];
  while (chosen.length < 6 && pool.length) { const p = weightedPick(pool, e => e.w, r); if (!p) break; chosen.push(p); pool.splice(pool.indexOf(p), 1); }
  for (const p of chosen) (await relatedArtists(p.name)).slice(0, 12).forEach((a, i) => add(a, Math.min(p.w, 4) * 0.5 * (1 - i / 16), 'related', p.name));
  Object.keys(A).forEach(k => { if (banned(k) || A[k].w <= 0) delete A[k]; });

  // pick candidate artists: familiar vs discovery mix
  const FAM = ['seed', 'liked', 'song', 'replay'];
  const fam = Object.values(A).filter(e => FAM.includes(e.kind)), dis = Object.values(A).filter(e => !FAM.includes(e.kind));
  const tot = Math.ceil(n * 1.8), nDis = Math.round(tot * disc), nFam = tot - nDis;
  const pickN = (arr, k) => { const a = [...arr], o = []; while (o.length < k && a.length) { const p = weightedPick(a, e => e.w, r); if (!p) break; o.push(p); a.splice(a.indexOf(p), 1); } return o; };
  // pinned anchors (seedsMeta.pinned, e.g. Coldplay) are always candidates
  const pinnedK = new Set(((S.seedsMeta && S.seedsMeta.pinned) || []).map(norm));
  const pinnedE = fam.filter(e => pinnedK.has(norm(e.name)));
  let picks = [...pinnedE, ...pickN(fam.filter(e => !pinnedE.includes(e)), Math.max(0, nFam - pinnedE.length)), ...pickN(dis, nDis)];
  if (picks.length < tot) picks = picks.concat(pickN(Object.values(A).filter(e => !picks.includes(e)), tot - picks.length));
  for (const p of picks) { const a = await resolveArtist(p.name, S); if (a && !M.bannedIds.has(a.id) && !banned(norm(a.name))) { p.id = a.id; p.display = a.name; p.genre = a.genre; } }
  const ids = [...new Set(picks.filter(p => p.id).map(p => p.id))];
  const songs = await topSongs(ids, sf);
  const VP = versionPrefs(S, replay, seedTracks);

  // exclusions: rated/feedback, replay, seed songs, shown in the 14 days before `date`
  const recent = new Set(), d0 = Date.parse(date);
  Object.entries(S.history || {}).forEach(([d, h]) => { const age = (d0 - Date.parse(d)) / DAY;
    if (age > 0 && age <= 14) (h.sets || []).forEach(s => (s.tracks || []).forEach(x => recent.add(String(x.trackId || x.id))));
    else if (age === 0) (h.sets || []).slice(0, setNo).forEach(s => (s.tracks || []).forEach(x => recent.add(String(x.trackId || x.id)))); });
  const dislikedName = name => splitArtists(name).some(a => banned(norm(a))) || banned(norm(name));

  // score every candidate track
  const cands = [];
  for (const p of picks) {
    if (!p.id || !songs[p.id]) continue;
    const list = songs[p.id];
    list.forEach((t, i) => {
      const id = String(t.trackId);
      if (M.excludeIds.has(id) || recent.has(id) || M.excludeTitles.has(titleKey(t.trackName, t.artistName)) || M.bannedIds.has(t.artistId) || dislikedName(t.artistName)) return;
      if (!/^https:\/\/music\.apple\.com\//.test(t.trackViewUrl) || !t.trackViewUrl.includes('/' + sf + '/')) return;
      const fam = FAM.includes(p.kind);
      // genre-discovered artists must actually be that genre in iTunes, and not lo-fi/instrumental filler
      if (p.kind === 'genre') {
        const tg = genreTargets(p.why), gk = norm(t.primaryGenreName);
        if (tg.length > 1 && !tg.some(x => x === gk || (x.length > 1 && gk.includes(x)))) return;
        if (!LOFI.test(p.why) && (LOFI.test(t.trackName + ' ' + t.collectionName + ' ' + t.artistName) || (p.genre && /electronic|电子/i.test(p.genre) && !/electro|电子/i.test(p.why)))) return;
      }
      const comp = isCompilation(t), notOwn = p.id && t.artistId !== p.id;
      const vp = versionPenalised(t, VP), verBad = vp === true, verMild = vp === 'mild', long = t.trackTimeMillis && t.trackTimeMillis > MAX_MS && !(VP.live && versionKind(t.trackName, t.collectionName) === 'live' && !verBad);
      let s = Math.log1p(p.w) * 1.4                          // artist affinity
        + genreAffinity(t.primaryGenreName, M.genres) * 0.6   // genre affinity (+/-)
        + 1.2 / (1 + i * 0.3)                                 // iTunes order ~ popularity
        + (verBad || long ? -4 : 0) + (verMild ? -1.5 : 0) + (comp ? -4 : 0) + (notOwn ? -0.6 : 0)  // unwanted versions down-weighted unless the user picked that type
        + (t.releaseDate && Date.parse(t.releaseDate) > d0 - 2 * 365 * DAY ? 0.3 : 0) // slight freshness boost
        + r() * 1.2;                                          // daily seeded jitter
      const dsc = descStatic(D, t, p); s += dsc.bonus;
      cands.push({ t, p, s, fam, bad: verBad || long || comp, dsc });
    });
  }
  cands.sort((a, b) => b.s - a.s);
  // descriptor probes (keyless): MusicBrainz artist tags + Deezer bpm for a shortlist only, cached; positive-only extra boost
  if (D && opts.probes !== false && PROBES) {
    const short = cands.filter(c => !c.bad).slice(0, 16), arts = [...new Set(short.map(c => c.t.artistName))].slice(0, 8);
    const tags = {}; for (const a of arts) tags[a] = await mbTags(a).catch(() => []);
    await Promise.all(short.map(async c => { const bpm = await deezerBpm(c.t).catch(() => 0); const x = descProbe(D, c, tags[c.t.artistName] || [], bpm); c.s += x; c.dsc.probe = x; }));
    cands.sort((a, b) => b.s - a.s);
  }

  // diversity-aware greedy selection: max 1 per artist first pass, max 2 overall; honor discovery ratio
  const wantDis = Math.round(n * disc), out = [], perArtist = {}, seenTitle = new Set(), usedId = new Set();
  const key = c => String(c.p.id || norm(splitArtists(c.t.artistName)[0] || c.t.artistName));
  const take = (c) => { out.push(c); usedId.add(c.t.trackId); perArtist[key(c)] = (perArtist[key(c)] || 0) + 1; seenTitle.add(norm(c.t.trackName) + '|' + key(c)); };
  const ok = (c, cap) => !usedId.has(c.t.trackId) && (perArtist[key(c)] || 0) < cap && !seenTitle.has(norm(c.t.trackName) + '|' + key(c));
  const good = cands.filter(c => !c.bad);
  // genre diversity: no single genre takes more than ~60% of the set while alternatives exist
  const gCap = Math.max(2, Math.round(n * 0.6)), gOf = c => canonGenre(c.t.primaryGenreName) || '?';
  const gCount = () => out.reduce((m, c) => (m[gOf(c)] = (m[gOf(c)] || 0) + 1, m), {});
  const gOk = c => (gCount()[gOf(c)] || 0) < gCap;
  // one slot for a pinned anchor (best-scoring pinned track)
  const pin = good.find(c => pinnedK.has(norm(c.p.name)) && ok(c, 1)); if (pin && n >= 5) take(pin);
  for (const cap of [1, 2]) {
    const nd = () => out.filter(c => !c.fam).length, nf = () => out.filter(c => c.fam).length;
    for (const c of good) { if (out.length >= n) break; if (!ok(c, cap) || !gOk(c)) continue;
      if (c.fam ? nf() < n - wantDis : nd() < wantDis) take(c); }
    for (const c of good) { if (out.length >= n) break; if (ok(c, cap) && gOk(c)) take(c); }
  }
  for (const c of good) { if (out.length >= n) break; if (ok(c, 2)) take(c); }
  for (const c of cands) { if (out.length >= n) break; if (c.bad && ok(c, 2)) take(c); } // last resort only
  // deterministic shuffle so familiar/discovery interleave
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out.map(c => toTrack(c.t, reasonOf(c.p)));
}
// ---------------- critic/social descriptors (taste-descriptors.json) ----------------
// Each descriptor: {norm (0..1, rank-weighted, divide-by-max → never negative), genres, artists, tags, bpm}. Matching uses keyless
// proxies: iTunes primaryGenreName (canonGenre), candidate artist / Deezer-related anchor, MusicBrainz tags, Deezer bpm.
let DESC = null, DESC_P = null, PROBES = true;
function setDescriptors(d) { DESC = d && d.descriptors ? prepDesc(d) : null; DESC_P = Promise.resolve(DESC); return !!DESC; }
function prepDesc(d) { const list = Object.entries(d.descriptors).map(([id, e]) => ({ id, w: Math.max(0, +e.norm || 0), g: new Set((e.genres || []).map(x => canonGenre(x) || x)),
  a: new Set((e.artists || []).map(norm)), tags: (e.tags || []).map(x => String(x).toLowerCase()), bpm: e.bpm })).filter(e => e.w > 0);
  return { list, tot: list.reduce((s, e) => s + e.w, 0) || 1, raw: d }; }
function loadDescriptors() {
  if (DESC_P) return DESC_P;
  DESC_P = (async () => { try {
    if (isBrowser) { const r = await fetch('taste-descriptors.json', { cache: 'no-cache' }); if (r.ok) DESC = prepDesc(await r.json()); }
    else { const fs = require('fs'), path = require('path'), f = path.join(__dirname, 'taste-descriptors.json'); if (fs.existsSync(f)) DESC = prepDesc(JSON.parse(fs.readFileSync(f, 'utf8'))); }
  } catch (e) { DESC = null; } return DESC; })();
  return DESC_P;
}
function descStatic(D, t, p) {
  if (!D) return { bonus: 0, hits: [] };
  const g = canonGenre(t.primaryGenreName), names = splitArtists(t.artistName).map(norm), anchor = p.kind === 'related' ? norm(p.why) : '';
  let raw = 0; const hits = [];
  for (const e of D.list) { let h = 0;
    if (names.some(n => e.a.has(n))) h += 0.6; else if (anchor && e.a.has(anchor)) h += 0.4;
    if (g && e.g.has(g)) h += 0.35;
    if (h > 0) { raw += e.w * Math.min(1, h); hits.push(e.id); } }
  return { bonus: Math.min(1.8, 2.4 * raw / D.tot), hits, raw };           // ≥ 0 always
}
function descProbe(D, c, tags, bpm) {
  let raw = 0; const tl = (tags || []).map(x => String(x).toLowerCase());
  for (const e of D.list) { let h = 0;
    if (e.tags.length && tl.some(x => e.tags.some(y => x === y || x.includes(y)))) h += 0.5;
    if (bpm && e.bpm && bpm >= e.bpm[0] && bpm <= e.bpm[1] && (c.dsc.hits || []).includes(e.id)) h += 0.3;  // bpm only confirms a descriptor already hit
    raw += e.w * Math.min(1, h); }
  return Math.min(0.9, 1.6 * raw / D.tot);
}
async function mbTags(name) {
  return cached('mt:' + norm(name), 60, async () => { const d = await mb('artist', { query: `artist:"${String(name).replace(/"/g, '')}"`, limit: 3 });
    const a = (d.artists || []).find(x => norm(x.name) === norm(name)) || (d.artists || [])[0];
    return a && a.tags ? a.tags.filter(x => (x.count || 0) >= 0).map(x => x.name).slice(0, 15) : []; });
}
async function deezerBpm(t) {
  return cached('bp:' + t.trackId, 120, async () => {
    const q = `artist:"${splitArtists(t.artistName)[0] || t.artistName}" track:"${String(t.trackName).replace(/\s*[(\[].*$/, '')}"`;
    const s = await deezer('search', { q, limit: 1 }); const hit = s && s.data && s.data[0]; if (!hit) return 0;
    const d = await deezer('track/' + hit.id); return +(d && d.bpm) || 0; });
}
function reasonOf(p) {
  const who = p.why || p.name;
  switch (p.kind) {
    case 'liked': return `因为你喜欢 ${who}`;
    case 'seed': return `因为你喜欢 ${p.display || p.name}`;
    case 'song': return `因为你喜欢《${who}》`;
    case 'replay': return `你的 Replay 常听：${p.display || p.name}`;
    case 'related': return `和 ${who} 风格相似`;
    case 'genre': return `流派推荐：${who}`;
    default: return `为你推荐`;
  }
}
// Track record: new MusicRec fields + app.js legacy aliases (id,name,url,art,preview,year) so both UIs can render history.
function toTrack(t, reason) {
  const url = cleanUrl(t.trackViewUrl), art = (t.artworkUrl100 || '').replace('100x100bb', '600x600bb');
  return { trackId: t.trackId, title: t.trackName, artist: t.artistName, artistId: t.artistId, album: t.collectionName,
    artwork: art, previewUrl: t.previewUrl || '', appleMusicUrl: url, appUrl: toAppUrl(url), genre: t.primaryGenreName || '',
    year: (t.releaseDate || '').slice(0, 4), reason,
    id: t.trackId, name: t.trackName, url, art: art.replace('600x600bb', '300x300bb'), preview: t.previewUrl || '' };
}

// ---------------- stateful API (localStorage 'yinyuebot.v1') ----------------
const inflight = {};
const MusicRec = {
  version: '1.0.0',
  /** Returns the full state plus derived taste summary. */
  getProfile() {
    const S = loadState(), M = tasteModel(S, S.replay), fb = Object.values(S.feedback);
    return { seeds: S.seeds, settings: S.settings, replayCount: (S.replay || []).length,
      stats: { rated: fb.length, liked: fb.filter(f => f.v === 1).length, disliked: fb.filter(f => f.v === -1).length },
      topArtists: Object.values(M.artists).filter(e => e.w > 0).sort((a, b) => b.w - a.w).slice(0, 15).map(e => e.name),
      topGenres: Object.entries(M.genres).filter(e => e[1] > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]),
      dislikedArtists: [...M.bannedArtists].map(k => (M.artists[k] && M.artists[k].name) || k),
      artistBans: S.artistBans.slice(), artistBanIds: S.artistBanIds.slice(),
      feedback: MusicRec.getFeedback(),
      historyDates: Object.keys(S.history).sort().reverse() };
  },
  /** [{trackId, v, r, at, liked, disliked, track}] newest first (single source of truth: state.feedback). */
  getFeedback() {
    const S = loadState();
    return Object.entries(S.feedback || {}).filter(([, f]) => f && typeof f === 'object').map(([id, f]) => ({ trackId: id, v: f.v || 0, r: f.r || 0, at: f.at || 0, liked: f.v === 1, disliked: f.v === -1, track: f.track || null }))
      .sort((a, b) => b.at - a.at);
  },
  /** Artists in iTunes (active storefront, default us; CJK also tw/hk). -> [{artistId, name, genre, url, storefront}] */
  async searchArtists(term, o = {}) {
    const S = loadState(), sf = (o.storefront || S.settings.storefront || 'us').toLowerCase(), lim = o.limit || 10;
    for (const country of searchStores(S, term, sf)) {
      try { const res = ((await itunes('search', { term, entity: 'musicArtist', country, limit: lim })).results || []).filter(a => a.artistId);
        if (res.length) return res.map(a => ({ artistId: a.artistId, name: a.artistName, genre: a.primaryGenreName || '', url: cleanUrl(a.artistLinkUrl || '').replace('/' + country + '/', '/' + sf + '/'), storefront: country })); } catch (e) {}
    }
    return [];
  },
  /** Songs playable in the active storefront (default us). CJK: us → tw → hk merged, non-native hits verified in sf. (cn: us search + cn lookup.)
   *  -> normalized tracks (same shape as getDaily items, reason ''). */
  async searchSongs(term, o = {}) {
    const S = loadState(), sf = (o.storefront || S.settings.storefront || 'us').toLowerCase(), lim = o.limit || 15;

    const c = await searchSongCandidates(String(term || ''), S, sf, lim);
    const out = c.map(t => { const x = toTrack(t, ''); if (t.artistMatch !== undefined) x.artistMatch = t.artistMatch; return x; });
    out.storefront = c.storefront || sf; ['queryArtist', 'queryTitle', 'artistMissing'].forEach(k => { if (c[k] !== undefined) out[k] = c[k]; });
    return out;
  },
  /** Merge-save seeds. Fields omitted keep their value. Arrays or comma/newline strings accepted. */
  saveSeeds(seeds = {}) {
    const S = loadState(), list = v => Array.isArray(v) ? v.map(String).map(s => s.trim()).filter(Boolean) : String(v || '').split(/[\n,，;；、]+/).map(s => s.trim()).filter(Boolean);
    ['genres', 'artists'].forEach(k => { if (seeds[k] !== undefined) S.seeds[k] = list(seeds[k]); });
    if (seeds.songs !== undefined) S.seeds.songs = Array.isArray(seeds.songs) ? list(seeds.songs) : String(seeds.songs).split(/\n+/).map(s => s.trim()).filter(Boolean);
    saveState(S); return S.seeds;
  },
  /** Optional strong taste signal: Apple Music Replay JSON ({tracks:[{rank,trackId,artists,genre,cnGenre,inCN}]}) or its tracks array. Stored as state.replay. */
  setReplay(replayJson) {
    const S = loadState(), tr = Array.isArray(replayJson) ? replayJson : (replayJson && replayJson.tracks) || [];
    S.replay = toReplay(tr); saveState(S); return S.replay.length;
  },
  /** Daily set for dateStr (default today, 'YYYY-MM-DD'). Cached in state.history[date]; refresh:true makes a new batch (excludes earlier batches). */
  async getDaily(dateStr, opts = {}) {
    const st = curStore(), gen = storeGen, date = dateStr || todayStr(), S = loadState(st), H = S.history[date];
    const exclude = (opts.exclude || []).map(String), fresh = !!opts.refresh || exclude.length > 0;
    const ph = profileHash(S, S.replay), last = H && H.sets && H.sets[H.sets.length - 1];
    // An already-saved day is never regenerated implicitly: profile/seed/storefront/scoring changes apply to the NEXT day
    // or to an explicit refresh ({refresh:true} / exclude). (set.profile is kept for diagnostics only.)
    if (last && !fresh && last.tracks && last.tracks.length) return last.tracks;
    const k = gen + '|' + date + (fresh ? ':r:' + exclude.join(',') : ''); if (inflight[k]) return inflight[k];   // per store generation
    inflight[k] = (async () => {
      const setNo = H && H.sets ? H.sets.length : 0; // setNo>0 also excludes every earlier batch of this date
      const tracks = await recommend(S, { date, setNo, count: opts.count, exclude });
      if (tracks.length) { const S2 = loadState(st); (S2.history[date] = S2.history[date] || { sets: [] }).sets.push({ at: Date.now(), profile: ph, tracks }); saveState(S2, st); }
      return tracks;
    })().finally(() => { delete inflight[k]; });
    return inflight[k];
  },
  /** rate(trackId, 'like'|'dislike'|'clear'|0..5). Same semantics as app.js (>=4 stars implies like, <=2 implies dislike). */
  rate(trackId, value, track) {
    const S = loadState(), id = String(trackId);
    const prev = S.feedback[id] && typeof S.feedback[id] === 'object' ? S.feedback[id] : {};
    // merge: stored history/feedback copy fills fields the UI didn't pass (artistId, genre, album…); UI-provided non-empty values win
    const clean = o => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'feedback'));
    const known = findTrack(S, id), merged = Object.assign({}, clean(known), clean(prev.track), clean(track));
    const tr = Object.keys(merged).length ? normTrackRecord(merged) : null;
    const f = Object.assign({ v: 0, r: 0 }, prev);
    if (value === 'like') { f.v = 1; if (f.r && f.r <= 2) f.r = 0; }            // keep compatible stars, drop contradicting ones
    else if (value === 'dislike') { f.v = -1; if (f.r >= 4) f.r = 0; }
    else if (value === 'unlike' || value === 'undislike' || value === 'neutral') f.v = 0;
    else if (value === 'clear') { f.v = 0; f.r = 0; }
    else { const r = Math.max(0, Math.min(5, Math.round(+value) || 0)); f.r = r;
      if (r >= 4) f.v = 1; else if (r && r <= 2) f.v = -1; /* 3 = neutral: keeps existing thumb; 0 = clear stars only */ }
    f.at = Date.now(); f.track = tr || { trackId: id, id };
    if (!f.v && !f.r) delete S.feedback[id]; else S.feedback[id] = f; saveState(S); return S.feedback[id] || null;
  },
  /** [{date, sets:[{at, tracks}]}] newest first, with feedback attached per track. */
  getHistory() {
    const S = loadState();
    return Object.keys(S.history || {}).sort().reverse().map(date => ({ date, sets: ((S.history[date] || {}).sets || []).map(s => ({ at: (s && s.at) || 0,
      tracks: ((s && s.tracks) || []).map(t => Object.assign({}, t, { feedback: S.feedback[(t && (t.trackId || t.id))] || null })) })) }));
  },
  /** Clear all: seeds, feedback, history, replay, settings back to defaults (request cache kept). */
  reset() { const S = defaults(); saveState(S); return { ok: true, reset: true, days: 0, feedback: 0, seeds: S.seeds }; },
  exportData() { return JSON.stringify(loadState(), null, 2); },
  /** Accepts a MusicRec/app.js state, or an old UI export {app, profile, feedback, history:[…], engineState}. Throws a Chinese error if unusable. */
  importData(json) {
    let d; try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch (e) { throw new Error('导入失败：文件不是有效的 JSON'); }
    if (d && typeof d === 'object' && !Array.isArray(d) && !Object.keys(d).length) return MusicRec.reset(); // importData({}) = clear all
    const S = sanitizeImport(d); saveState(S);
    return { ok: true, days: Object.keys(S.history).length, feedback: Object.keys(S.feedback).length, seeds: S.seeds };
  },
  /**
   * Rebuild seeds from current signals: Replay ranks (positive-only weights), recent likes/ratings (last 120 d), plus pinned anchors.
   * opts: {replay (json or tracks; default state.replay), keep:['Coldplay'], maxArtists:14, maxGenres:4, apply:true}
   * Old seeds not supported by current signals are dropped (saved in seedsMeta.previous for undo). Returns {artists, genres, songs, dropped}.
   */
  rebuildSeedsFromSignals(opts = {}) {
    const S = loadState();
    if (opts.replay) S.replay = toReplay(opts.replay);
    const replay = S.replay || [], score = {}, names = {}, gScore = {};
    const bump = (a, w) => { const k = norm(a); if (!k || w <= 0) return; score[k] = (score[k] || 0) + w; names[k] = names[k] || a; };
    replay.forEach(t => { const w = replayBoost(t.rank), as = t.artists && t.artists.length ? t.artists : splitArtists(t.artistName);
      as.forEach((a, i) => bump(a, i ? w * 0.5 : w)); const g = canonGenre(t.cnGenre || t.genre); if (g) gScore[g] = (gScore[g] || 0) + w; });
    const now = Date.now();
    Object.values(S.feedback).forEach(f => { if (!f || !(f.v === 1 || f.r >= 4) || (f.at && now - f.at > RECENT_DAYS * DAY)) return; const tr = f.track || {};
      splitArtists(tr.artist || tr.artistName).slice(0, 1).forEach(a => bump(a, 2 + (f.r >= 4 ? f.r - 3 : 0))); const g = canonGenre(tr.genre); if (g) gScore[g] = (gScore[g] || 0) + 1; });
    const keep = (opts.keep || []).map(String), dislikedK = tasteModel(S, replay).bannedArtists;
    const top = Object.keys(score).filter(k => !dislikedK.has(k)).sort((a, b) => score[b] - score[a]).slice(0, opts.maxArtists || 14).map(k => names[k]);
    const artists = [...new Set([...keep, ...top])];
    const gTot = Object.values(gScore).reduce((a, b) => a + b, 0) || 1;
    const genres = Object.entries(gScore).sort((a, b) => b[1] - a[1]).filter(([, v], i) => i < 2 || v / gTot >= 0.06).slice(0, opts.maxGenres || 4).map(x => x[0]);
    const aSet = new Set(artists.map(norm));
    const songs = (S.seeds.songs || []).filter(q => { const a = q.split(/\s+[-–—]\s+/)[1]; return a && splitArtists(a).some(x => aSet.has(norm(x))); });
    const dropped = { artists: S.seeds.artists.filter(a => !aSet.has(norm(a))), genres: S.seeds.genres.filter(g => !genres.some(x => genreTargets(g).includes(norm(x)) || genreTargets(x).includes(norm(g)))),
      songs: S.seeds.songs.filter(q => !songs.includes(q)) };
    if (opts.apply !== false) {
      S.seedsMeta = { rebuiltAt: now, source: 'replay+recent-feedback', pinned: keep, previous: { seeds: S.seeds, at: now } };
      S.seeds = { genres, artists, songs }; saveState(S);
    }
    return { artists, genres, songs, dropped, weights: Object.fromEntries(top.map(n => [n, +score[norm(n)].toFixed(2)])) };
  },
  /** Apply a saved seed profile (object or URL of seed-profile-*.json: {seeds, pinned, replay?}). Browser: await MusicRec.applySeedProfile('seed-profile-2026.json'). */
  async applySeedProfile(src) {
    const d = typeof src === 'string' ? await (await fetch(src)).json() : src; if (!d || !d.seeds) throw new Error('种子文件格式不对');
    const S = loadState(); if (d.replay) S.replay = toReplay(d.replay);
    S.seedsMeta = { rebuiltAt: Date.now(), source: d.source || 'seed-profile', pinned: d.pinned || [], previous: { seeds: S.seeds, at: Date.now() } };
    S.seeds = { genres: d.seeds.genres || [], artists: d.seeds.artists || [], songs: d.seeds.songs || [] }; saveState(S); return S.seeds;
  },
  setStorefront(sf = 'us') { const S = loadState(); S.settings.storefront = String(sf || 'us').toLowerCase().slice(0, 2); saveState(S); return S.settings.storefront; },
  setSettings(p = {}) { const S = loadState(); Object.assign(S.settings, p); saveState(S); return S.settings; },
  clearCache() { RC = {}; try { baseStore.removeItem(RC_KEY); } catch (e) {} },
  // lower-level helpers
  recommend, verifyTracks, resolveArtist: (n, S) => resolveArtist(n, S || loadState()), relatedArtists, genreArtists: (g, S) => genreArtists(g, S || loadState()),
  tasteModel, replayBoost, canonGenre, versionKind, versionPrefs, versionPenalised, setDescriptors, loadDescriptors, descStatic,
  setProbes(on) { PROBES = !!on; return PROBES; },
  /** Explicit artist-level dislike: always bans the artist (unlike a song dislike on a collab). */
  dislikeArtist(nameOrId, o = {}) {
    // o.exact: ban the given name as-is (UI menu pick). Otherwise a multi-artist credit -> first-billed only; unsplittable -> as-is.
    const S = loadState(), raw = String(nameOrId ?? '').trim(), isId = !o.exact && /^\d+$/.test(raw);
    const id = String(o.artistId || (isId ? raw : '') || '').trim(), name = isId ? '' : o.exact ? raw : (splitArtists(raw)[0] || raw);
    if (name && !S.artistBans.some(a => norm(a) === norm(name))) S.artistBans.push(name);
    if (/^\d+$/.test(id) && !S.artistBanIds.includes(id)) S.artistBanIds.push(id);
    saveState(S); return S.artistBans;
  },
  undislikeArtist(nameOrId, o = {}) {
    const S = loadState(), raw = String(nameOrId ?? '').trim(), isId = !o.exact && /^\d+$/.test(raw), id = String(o.artistId || (isId ? raw : '') || '').trim();
    const name = isId ? '' : o.exact ? raw : (splitArtists(raw)[0] || raw);
    if (name) S.artistBans = S.artistBans.filter(a => norm(a) !== norm(name) && norm(a) !== norm(raw));
    if (id) S.artistBanIds = S.artistBanIds.filter(x => x !== id);
    saveState(S); return S.artistBans;
  },
  splitArtists,
  currentSignals, todayStr, hash, rng, stats,
  /** Inject a storage object ({getItem,setItem,removeItem}); used by Node tests. */
  setStorage(s) { baseStore = s; try { RC = JSON.parse(baseStore.getItem(RC_KEY)) || {}; } catch (e) { RC = {}; } },
  /** Per-account state store for KEY ('yinyuebot.v1') only: {getItem,setItem,removeItem} (sync). null = back to localStorage (guest).
   *  The request cache (RC_KEY) always stays in localStorage. In-flight getDaily calls finish into the store they started with. */
  setStore(s) { if (s != null && !(typeof s.getItem === 'function' && typeof s.setItem === 'function')) throw new Error('setStore: need {getItem,setItem,removeItem}');
    stateStore = s || null; storeGen++; return MusicRec.getStore(); },
  /** The store set by setStore, or null when on localStorage (guest). */
  getStore() { return stateStore; },
  KEY, RC_KEY,
};
function toReplay(x) { const tr = Array.isArray(x) ? x : (x && x.tracks) || [];
  return tr.filter(t => t && t.trackId).map(t => ({ rank: t.rank, trackId: String(t.trackId), title: t.title, artists: t.artists || splitArtists(t.artistName), artistName: t.artistName, genre: t.genre, cnGenre: t.cnGenre, inCN: t.inCN, releaseDate: t.releaseDate })); }
// map storefront/locale genre names to one canonical cn label
function canonGenre(g) { if (!g) return ''; const s = String(g);
  if (/hip-?hop|rap|嘻哈|说唱/i.test(s)) return '嘻哈/说唱'; if (/k-?pop/i.test(s)) return 'K-Pop'; if (/r&b|soul|灵魂/i.test(s)) return 'R&B/灵魂乐';
  if (/latin|拉丁|urbano/i.test(s)) return '拉丁都市音乐'; if (/alternative|另类/i.test(s)) return '另类音乐'; if (/electro|电子/i.test(s)) return '电子音乐';
  if (/mandopop|国语|华语/i.test(s)) return '国语流行'; if (/j-?pop/i.test(s)) return 'J-Pop'; if (/^pop$|国际流行|流行/i.test(s)) return '流行'; return s; }
function sanitizeImport(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('导入失败：不是音乐bot的数据文件');
  let es = d.engineState; if (typeof es === 'string') { try { es = JSON.parse(es); } catch (e) { es = null; } }
  const src = (es && typeof es === 'object' && !Array.isArray(es)) ? es : d;
  const out = defaults(), str = x => typeof x === 'string' ? x.trim() : x && (x.name || (x.title ? x.title + (x.artist ? ' - ' + x.artist : '') : '')) || '';
  const seeds = src.seeds || src.profile || d.profile || {};
  ['genres', 'artists', 'songs'].forEach(k => { if (Array.isArray(seeds[k])) out.seeds[k] = seeds[k].map(str).filter(Boolean); });
  const fb = (src.feedback && typeof src.feedback === 'object' && !Array.isArray(src.feedback)) ? src.feedback : {};
  Object.entries(fb).forEach(([id, f]) => { if (!f || typeof f !== 'object') return;
    const r = Math.max(0, Math.min(5, +(f.r ?? f.rating) || 0));
    let v;
    if (f.v !== undefined) v = [1, -1, 0].includes(+f.v) ? +f.v : 0;
    else if (f.like !== undefined || f.liked !== undefined || f.disliked !== undefined) v = (f.like === 1 || f.like === true || f.liked === true) ? 1 : (f.like === -1 || f.disliked === true) ? -1 : 0;
    else v = r >= 4 ? 1 : r && r <= 2 ? -1 : 0; // old format with stars only
    const hasTr = f.track && typeof f.track === 'object' && hasInfo(f.track);
    if (!v && !hasTr) return;                                  // v=0 with no track info = nothing usable (e.g. poison {v:'x',r:9,track:5})
    if (v || r) out.feedback[String(id)] = { v, r, at: +f.at || Date.now(), track: (f.track && typeof f.track === 'object') ? normTrackRecord(Object.assign({ trackId: String(id) }, f.track)) : { trackId: String(id), id: String(id) } }; });
  out.history = cleanHistory(src.history);
  if (src.settings && typeof src.settings === 'object') Object.assign(out.settings, src.settings);
  migrate(src, out);
  if (Array.isArray(src.artistBans)) out.artistBans = src.artistBans.map(String).filter(Boolean);
  if (Array.isArray(src.artistBanIds)) out.artistBanIds = src.artistBanIds.map(x => String(x)).filter(x => /^\d+$/.test(x));
  if (Array.isArray(src.replay)) out.replay = toReplay(src.replay);
  if (src.seedsMeta && typeof src.seedsMeta === 'object') out.seedsMeta = src.seedsMeta;
  // usable-data check counts only feedback that carries a title or URL (bare ids can't be shown or used for taste)
  const any = out.seeds.genres.length + out.seeds.artists.length + out.seeds.songs.length + Object.values(out.feedback).filter(f => hasInfo(f.track)).length + Object.keys(out.history).length + (out.replay ? out.replay.length : 0);
  const marked = src.version !== undefined || (src.seeds && typeof src.seeds === 'object') || d.engineState || d.app;
  if (!any && !(marked && src.settings)) throw new Error('导入失败：文件里没有可用的口味、反馈或历史数据');
  return out;
}
function hasInfo(t) { return !!(t && typeof t === 'object' && [t.title, t.name, t.trackName, t.url, t.appleMusicUrl, t.trackViewUrl].some(x => typeof x === 'string' && x.trim())); }
function findTrack(S, id) { for (const h of Object.values(S.history || {})) for (const s of (h && h.sets) || []) for (const x of (s && s.tracks) || []) if (x && String(x.trackId || x.id) === id) return x; return S.feedback[id] && S.feedback[id].track; }

if (typeof module !== 'undefined' && module.exports) module.exports = MusicRec;
if (root) { root.MusicRec = MusicRec; root.MusicRecommender = MusicRec; }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
