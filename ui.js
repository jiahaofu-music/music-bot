/* 音乐bot — UI layer (ui.js). window.MusicRec (recommender.js) is the ONLY source of seeds, history and feedback.
 * localStorage 'yinyuebot.ui.v1' holds UI prefs only ({tab, banIds}). See API_CONTRACT.md. Vanilla JS, no build step. */
(() => {
'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const todayStr = (d = new Date()) => { const z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const TZ = 'Asia/Shanghai';
const hhmm = ms => new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
const ymd = ms => new Date(ms).toLocaleDateString('sv-SE', { timeZone: TZ });   // YYYY-MM-DD in Shanghai time
const MOCK = new URLSearchParams(location.search).get('mock') === '1';
const reduceMotion = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

// ---------- UI prefs (+ graceful migration of the old fat state) ----------
const PREF_KEY = 'yinyuebot.ui.v1', LEGACY_KEY = 'yinyuebot.ui.legacy.v1';
let legacy = null;
let prefs = (() => {
  let d = null; try { d = JSON.parse(localStorage.getItem(PREF_KEY)); } catch (e) {}
  if (d && (d.profile || d.history || d.feedback)) {            // old ui.js state: keep a read-only copy, never read history/feedback from it
    legacy = d; try { if (!localStorage.getItem(LEGACY_KEY)) localStorage.setItem(LEGACY_KEY, JSON.stringify(d)); } catch (e) {}
    d = { tab: 'today' };
  }
  return Object.assign({ tab: '' }, d || {});
})();
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {} };
savePrefs();

// ---------- Track normalisation (display only) ----------
function normTrack(t) {
  if (!t || typeof t !== 'object') return null;
  const trackId = String(t.trackId ?? t.id ?? ''); if (!trackId) return null;
  let url = String(t.appleMusicUrl || t.url || t.trackViewUrl || t.cn_url || '').replace(/([?&])uo=\d+&?/, '$1').replace(/[?&]$/, '');
  let cid = t.collectionId ?? ''; if (!cid && url) { const m = url.match(/\/album\/(?:[^/]+\/)?(\d+)/); if (m) cid = m[1]; }
  if (!url) { const s = sf(); url = cid ? `https://music.apple.com/${s}/album/${cid}?i=${trackId}` : `https://music.apple.com/${s}/song/${trackId}`; }
  let art = String(t.artwork || t.artworkUrl || t.art || t.artworkUrl100 || '');
  if (art) art = art.replace(/\/\d+x\d+bb\./, '/300x300bb.');
  const str = v => (v == null ? '' : String(v));
  return { trackId, artistId: str(t.artistId), collectionId: str(cid),
    title: str(t.title ?? t.name ?? t.trackName ?? t.song) || '未知歌曲', artist: str(t.artist ?? t.artistName ?? (Array.isArray(t.artists) ? t.artists.join(' & ') : '')),
    album: str(t.album ?? t.collectionName), artworkUrl: str(art), previewUrl: str(t.previewUrl ?? t.preview),
    appleMusicUrl: url, appUrl: str(t.appUrl) || url.replace(/^https:/, 'music:'), genre: str(t.genre ?? t.primaryGenreName),
    year: str(t.year ?? t.releaseDate ?? t.release).slice(0, 4), reason: str(t.reason), feedback: t.feedback || null };
}

// ---------- engine ----------
let E = null, engineErr = '';
const loadScript = src => new Promise(res => { const s = document.createElement('script'); s.src = src; s.onload = () => res(true); s.onerror = () => res(false); document.head.appendChild(s); });
async function initEngine() {
  if (MOCK) { E = devMock(); return; }
  if (!window.MusicRec) await loadScript('recommender.js?retry=' + Date.now());   // only if the static <script> failed
  const m = window.MusicRec;
  if (!m || typeof m.getDaily !== 'function') { engineErr = m ? 'MusicRec 缺少 getDaily()' : '未找到 recommender.js'; return; }
  E = m;
}
const has = fn => !!E && typeof E[fn] === 'function';
function engineNotice() {
  const n = $('#notice'); if (E) { n.hidden = true; return; }
  n.hidden = false;
  n.innerHTML = `<b>推荐引擎还没就绪</b><br><span class="muted">${esc(engineErr || '正在加载…')}。请稍后刷新页面。</span>`;
}
const profile = () => (has('getProfile') && E.getProfile()) || { seeds: { genres: [], artists: [], songs: [] }, settings: {} };
const seeds = () => { let s = {}; try { s = profile().seeds || {}; } catch (e) { console.error(e); }
  const arr = v => (Array.isArray(v) ? v : []).map(x => typeof x === 'string' ? x : (x && (x.name || (x.title ? (x.artist ? x.title + ' - ' + x.artist : x.title) : ''))) || '').filter(Boolean);
  return { genres: arr(s.genres), artists: arr(s.artists), songs: arr(s.songs) }; };
const feedbackList = () => { try { const l = has('getFeedback') ? E.getFeedback() : []; return Array.isArray(l) ? l.filter(f => f && f.trackId != null) : []; } catch (e) { console.error(e); return []; } };
const fbMap = () => { const m = {}; feedbackList().forEach(f => { m[String(f.trackId)] = f; }); return m; };
// no taste data = no seed genres/artists/songs and no Replay signal (feedback alone doesn't count)
const noTasteData = () => { const s = seeds(); let rc = 0; try { rc = profile().replayCount || 0; } catch (e) {} return !(s.genres.length + s.artists.length + s.songs.length + rc); };
// switch to 口味 with a hint, without remembering 口味 as the preferred tab (so the next load with taste opens 今日 again)
function promptTaste(msg) { const keep = prefs.tab; show('taste'); prefs.tab = keep; savePrefs(); const el = $('#taste-status'); if (el) el.textContent = msg; }
const hasTaste = () => { const p = profile(), s = seeds(); return s.genres.length + s.artists.length + s.songs.length + (p.replayCount || 0) + (feedbackList().length || 0) > 0; };

// ---------- iTunes fallback search (only if MusicRec lacks searchArtists/searchSongs) ----------
let jn = 0;
function jsonp(url, timeout = 10000) {
  return new Promise((res, rej) => {
    const cb = '__yybui' + (++jn), s = document.createElement('script');
    const done = () => { delete window[cb]; s.remove(); clearTimeout(tm); };
    const tm = setTimeout(() => { done(); rej(new Error('timeout')); }, timeout);
    window[cb] = d => { done(); res(d); }; s.onerror = () => { done(); rej(new Error('network')); };
    s.src = url + '&callback=' + cb; document.head.appendChild(s);
  });
}
async function itunesSearch(term, entity, limit = 8) {
  const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=${sf()}&entity=${entity}&limit=${limit}`;
  let d; try { d = await (await fetch(url)).json(); } catch { try { d = await jsonp(url); } catch { d = null; } }
  return (d && d.results) || [];
}
// storefront is read from the engine (default 'us'); ui.js only sets it when the user changes the setting
function sf() { let p = {}; try { p = profile() || {}; } catch (e) {} return String(p.storefront || (p.settings || {}).storefront || 'us').toLowerCase(); }
async function searchArtists(term) {
  if (has('searchArtists')) return (await E.searchArtists(term, { limit: 8 })) || [];
  return (await itunesSearch(term, 'musicArtist')).map(a => ({ artistId: a.artistId, name: a.artistName, genre: a.primaryGenreName }));
}
// Returns {list: Track[], missing, queryArtist, queryTitle}. The engine may return a Track[] that carries array props
// (artistMissing / queryArtist / queryTitle) or an object {tracks, artistMissing, queryArtist, queryTitle}; tracks may have artistMatch:false.
async function searchSongs(term) {
  const raw = has('searchSongs') ? await E.searchSongs(term, { limit: 8 }) : (await itunesSearch(term, 'song')).filter(x => x.kind === 'song');
  const src = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' && Array.isArray(raw.tracks) ? raw.tracks : []);
  const meta = raw && typeof raw === 'object' ? raw : {}, str = v => (typeof v === 'string' ? v.trim() : '');
  const list = src.map(t => { const n = normTrack(t); if (n && t && t.artistMatch === false) n.artistMatch = false; return n; }).filter(Boolean);
  return { list, missing: meta.artistMissing === true, queryArtist: str(meta.queryArtist), queryTitle: str(meta.queryTitle) };
}
// artistMissing notice: names (from the engine's queryArtist/queryTitle) or generic; second half depends on whether anything came back
const missingNote = (r, n) => (r.queryArtist && r.queryTitle ? `美区 Apple Music 没有${r.queryArtist}的《${r.queryTitle}》` : '美区 Apple Music 没找到这位歌手的原版')
  + (n ? '，下面是同名或相关歌曲' : '，也没有找到相关歌曲');

// ---------- views ----------
function show(v) {
  document.querySelectorAll('.view').forEach(x => x.classList.toggle('active', x.id === 'view-' + v));
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x.dataset.view === v));
  prefs.tab = v; savePrefs();
  if (v === 'history') renderHistory();
  if (v === 'settings') renderSettings();
  if (v === 'taste') renderTaste();
}
document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => show(b.dataset.view)));
const setStatus = m => { $('#status').textContent = m || ''; };

// ---------- odometer stats ----------
function odometer(el, text) {
  text = String(text);
  if (el.dataset.v === text) return; el.dataset.v = text;
  el.setAttribute('aria-label', text);
  el.innerHTML = [...text].map(ch => /\d/.test(ch)
    ? `<span class="odo-d" aria-hidden="true"><span class="odo-col">${'0123456789'.split('').map(d => `<span>${d}</span>`).join('')}</span></span>`
    : `<span class="odo-c" aria-hidden="true">${esc(ch)}</span>`).join('');
  const digits = [...text].filter(c => /\d/.test(c));
  const cols = el.querySelectorAll('.odo-col');
  if (reduceMotion()) { cols.forEach((c, i) => { c.style.transform = `translateY(-${digits[i] * 10}%)`; }); el.classList.add('in'); return; }
  el.classList.remove('in'); void el.offsetWidth;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    el.classList.add('in');
    cols.forEach((c, i) => { c.style.transitionDelay = (i * 70) + 'ms'; c.style.transform = `translateY(-${digits[i] * 10}%)`; });
  }));
}
function renderStats(todayCount) {
  const fb = feedbackList();
  const rated = fb.filter(f => f.r > 0);
  let hist = []; try { hist = (has('getHistory') && E.getHistory()) || []; } catch (e) { console.error(e); }
  const vals = { 'st-today': todayCount, 'st-likes': fb.filter(f => f.liked || f.v === 1).length,
    'st-avg': rated.length ? (rated.reduce((s, f) => s + f.r, 0) / rated.length).toFixed(1) : '–', 'st-days': hist.length };
  Object.entries(vals).forEach(([id, v]) => odometer($('#' + id), v));
  $('#stats').hidden = !E;
}

// ---------- today ----------
const player = $('#player'); let playingId = null;
let current = [];                       // tracks of today's latest set (from MusicRec)
let busy = false;

// ---------- artist bans (only when the engine has dislikeArtist) ----------
const canBan = () => has('dislikeArtist') && has('undislikeArtist');
// MusicRec matches artistBans by normalized artist NAME; newer engines also take (name, {artistId, exact}) — see banOpts().
// Split a collaboration credit into individual artists (engine's splitArtists if exposed, else local), keeping known names that contain separators.
// Mirrors recommender.js KEEP_WHOLE + splitArtists (fallback only; MusicRec.splitArtists is preferred). qa/unit-ui.js checks the two stay identical.
const ARTIST_KEEP = ['Tyler, The Creator', 'Earth, Wind & Fire', 'Simon & Garfunkel', 'Hall & Oates', 'Crosby, Stills, Nash & Young', 'Mumford & Sons', 'Florence + the Machine', 'Marina & The Diamonds', 'Chase & Status', 'Above & Beyond', 'Chloe x Halle', 'AC/DC', 'Belle & Sebastian', 'Iron & Wine', 'Hootie & the Blowfish', 'Brooks & Dunn', 'Dan + Shay', 'Sam & Dave', 'Peter, Bjorn and John', 'Years & Years', 'Sly & the Family Stone', 'Kool & the Gang', 'Prince & the Revolution'];
function splitArtistsLocal(s) { let x = String(s || ''); const keep = [];
  ARTIST_KEEP.forEach(n => { const i = x.toLowerCase().indexOf(n.toLowerCase()); if (i >= 0) { keep.push(x.substr(i, n.length)); x = x.slice(0, i) + '\u0000' + (keep.length - 1) + '\u0000' + x.slice(i + n.length); } });
  return x.split(/\s*(?:,|，|&|＆|、|[(\[（]?\bfeaturing\b|[(\[（]?\bfeat\b\.?|[(\[（]?\bft\b\.?|;|\s\/\s|\bwith\b|(?<=\s)[x×](?=\s+[^\s&,，、;＆(（])|\s\+\s)\s*/i)
    .map(y => y.replace(/\u0000(\d+)\u0000/g, (_, i) => keep[+i]).replace(/^[\s(（\[]+|[\s)）\]]+$/g, '').trim()).filter((y, i, arr) => y && arr.findIndex(z => z.toLowerCase() === y.toLowerCase()) === i); }
const splitArtists = s => { let r = null; try { if (E && typeof E.splitArtists === 'function') r = E.splitArtists(s); } catch (e) {} r = Array.isArray(r) && r.length ? r.map(String) : splitArtistsLocal(s); return [...new Set(r.map(x => x.trim()).filter(Boolean))]; };
const banNames = t => { const a = splitArtists(t.artist); return a.length ? a : (t.artist ? [String(t.artist).trim()] : []); };
function artistBans() { let p = {}; try { p = profile() || {}; } catch (e) {}
  if (Array.isArray(p.artistBans)) return p.artistBans.map(String);
  try { const s = JSON.parse(E.exportData()); return Array.isArray(s.artistBans) ? s.artistBans.map(String) : []; } catch (e) { return []; } }
// getProfile().artistBanIds (engine) — an id ban hits the track whose first-billed artist has that artistId
function artistBanIds() { let p = {}; try { p = profile() || {}; } catch (e) {} return Array.isArray(p.artistBanIds) ? p.artistBanIds.map(String) : []; }
const normName = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const isBanned = (name, bans = artistBans()) => bans.some(b => normName(b) === normName(name));
let toastTimer = null;
function toast(msg, undo) {
  const el = $('#toast'); if (!el) return; clearTimeout(toastTimer);
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button" class="toast-undo">撤销</button>' : ''}`; el.hidden = false;
  const u = el.querySelector('.toast-undo'); if (u) u.onclick = () => { el.hidden = true; undo(); };
  toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
// opts for dislikeArtist/undislikeArtist(name, {artistId, exact}): always the single chosen name with exact:true;
// artistId only when that name is the track's first-billed artist and the track has one. Older engines ignore the 2nd arg.
// The artistId we sent is remembered in UI prefs (banIds: normName -> id) so unbanning from the 口味 list (no track) clears the id ban too.
function banOpts(name, t, undo) { const o = { exact: true }, k = normName(name);
  if (t && t.artistId && normName(banNames(t)[0]) === k) o.artistId = String(t.artistId);
  else if (undo && prefs.banIds && prefs.banIds[k]) o.artistId = prefs.banIds[k];
  return o; }
function rememberBanId(name, o, undo) { const k = normName(name); prefs.banIds = prefs.banIds || {};
  if (undo) delete prefs.banIds[k]; else if (o.artistId) prefs.banIds[k] = o.artistId; savePrefs(); }
function banArtist(name, t) {
  if (!canBan() || !name) return; const o = banOpts(name, t); E.dislikeArtist(name, o); rememberBanId(name, o); markBanned(); renderBans();
  toast(`已不再推荐「${name}」。换一批或明天的推荐里会避开。`, () => unbanArtist(name, t));
}
function unbanArtist(name, t) { if (!canBan()) return; const o = banOpts(name, t, true); E.undislikeArtist(name, o); rememberBanId(name, o, true); markBanned(); renderBans(); toast(`已恢复推荐「${name}」。`); }
function markBanned() { const bans = canBan() ? artistBans() : [], ids = canBan() ? artistBanIds() : [];
  document.querySelectorAll('#today-list .card').forEach(c => { const t = current.find(x => x.trackId === c.dataset.id); if (!t) return;
    const ns = banNames(t), hit = ns.filter((n, i) => isBanned(n, bans) || (i === 0 && t.artistId && ids.includes(String(t.artistId)))), on = hit.length > 0; c.classList.toggle('banned', on);
    const b = c.querySelector('[data-act=ban]'); if (!b) return; b.setAttribute('aria-pressed', on);
    if (ns.length > 1) { b.textContent = on ? `已不想听 ${hit.length}/${ns.length} ▾` : '不想听… ▾'; b.setAttribute('aria-haspopup', 'menu'); }
    else b.textContent = on ? '已不想听 · 撤销' : '不想听这位歌手'; });
  const m = $('#ban-menu'); if (m && !m.hidden) m.querySelectorAll('[data-ban-name]').forEach(x => { const on = isBanned(x.dataset.banName, bans); x.setAttribute('aria-checked', on); x.classList.toggle('on', on); }); }
// tiny popover: one row per credited artist; click toggles that artist's ban
function banMenu(anchor, names, t) {
  let m = $('#ban-menu'); if (!m) { m = document.createElement('div'); m.id = 'ban-menu'; m.className = 'ban-menu'; m.setAttribute('role', 'menu'); document.body.appendChild(m);
    m.addEventListener('click', e => { const x = e.target.closest('[data-ban-name]'); if (!x) return; const n = x.dataset.banName, tr = m._track; if (isBanned(n)) unbanArtist(n, tr); else banArtist(n, tr); closeBanMenu(); }); }
  if (!m.hidden && m.dataset.for === anchor.closest('.card').dataset.id) { closeBanMenu(); return; }
  const bans = artistBans(); m.dataset.for = anchor.closest('.card').dataset.id; m._track = t;
  m.innerHTML = `<div class="ban-menu-h">不想听哪位？</div>` + names.map(n => { const on = isBanned(n, bans); return `<button type="button" role="menuitemcheckbox" aria-checked="${on}" class="${on ? 'on' : ''}" data-ban-name="${esc(n)}">${on ? '✓ ' : ''}${esc(n)}</button>`; }).join('');
  const r = anchor.getBoundingClientRect(); m.hidden = false;
  m.style.left = Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + window.scrollX)) + 'px'; m.style.top = (r.bottom + window.scrollY + 6) + 'px';
  const f = m.querySelector('button'); if (f) f.focus();
}
function closeBanMenu() { const m = $('#ban-menu'); if (m) m.hidden = true; }
document.addEventListener('click', e => { const m = $('#ban-menu'); if (m && !m.hidden && !m.contains(e.target) && !e.target.closest('[data-act=ban]')) closeBanMenu(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeBanMenu(); });
function renderBans() {
  const box = $('#bans'); if (!box) return; const bans = canBan() ? artistBans() : []; box.hidden = !canBan();
  $('#ban-list').innerHTML = bans.length ? bans.map(b => `<button class="chip" data-unban="${esc(b)}" aria-label="恢复推荐 ${esc(b)}">${esc(b)}</button>`).join('') : '<span class="muted">还没有。卡片上点「不想听这位歌手」即可加入。</span>';
}

function cardHTML(t, f) {
  const liked = f && (f.liked || f.v === 1), disliked = f && (f.disliked || f.v === -1), r = (f && f.r) || 0;
  const playing = playingId === t.trackId;
  return `<li class="card${playing ? ' playing' : ''}${disliked ? ' disliked' : ''}" data-id="${esc(t.trackId)}">
    <button class="vinyl${t.artworkUrl ? '' : ' noart'}${t.previewUrl ? '' : ' nopreview'}" data-act="play" ${t.previewUrl ? '' : 'disabled'} aria-label="试听 30 秒">
      <span class="disc" style="${t.artworkUrl ? `background-image:url('${esc(t.artworkUrl)}')` : ''}"></span><span class="sheen"></span>
      ${t.previewUrl ? `<span class="play">${playing ? '❚❚' : '▶'}</span>` : ''}
    </button>
    <div class="info">
      <div class="t-title">${esc(t.title)}</div>
      <div class="t-artist">${esc(t.artist)}${canBan() && t.artist ? `<button class="ban" data-act="ban" title="不再推荐这位歌手" aria-label="不想听 ${esc(t.artist)}">不想听这位歌手</button>` : ''}</div>
      <div class="t-meta">${[t.album, t.year, t.genre].filter(Boolean).map(esc).join(' · ')}</div>
      ${t.reason ? `<div class="t-reason">${esc(t.reason)}</div>` : ''}
      <div class="controls">
        <button data-act="like" class="${liked ? 'on-like' : ''}" aria-pressed="${!!liked}">♥ 喜欢</button>
        <button data-act="dislike" class="${disliked ? 'on-dislike' : ''}" aria-pressed="${!!disliked}">不喜欢</button>
        <span class="stars" role="group" aria-label="评分">${[1, 2, 3, 4, 5].map(i => `<button data-act="rate" data-r="${i}" class="${r >= i ? 'on' : ''}" aria-label="${i} 星">★</button>`).join('')}</span>
      </div>
      <div class="links">
        <a href="${esc(t.appleMusicUrl)}" target="_blank" rel="noopener">在 Apple Music 打开</a>
        <a class="app" href="${esc(t.appUrl)}">用 App 打开</a>
      </div>
    </div></li>`;
}
function renderToday() {
  $('#today-date').textContent = todayStr().replace(/-/g, ' · ');
  const fb = fbMap();
  $('#today-list').innerHTML = current.map(t => cardHTML(t, fb[t.trackId])).join('');
  $('#refresh').disabled = !E || busy || !current.length;
  renderStats(current.length); renderTimeline();
  markBanned();
}
function updateCard(id) {           // re-render one card in place after rate()
  const li = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`), t = current.find(x => x.trackId === id); if (!li || !t) return;
  const tmp = document.createElement('div'); tmp.innerHTML = cardHTML(t, fbMap()[id]); li.replaceWith(tmp.firstElementChild);
}

async function loadToday() {
  engineNotice();
  if (!E) { current = []; renderToday(); return; }
  if (!hasTaste()) { current = []; renderToday(); setStatus('先在「口味」里选几个喜欢的流派、歌手或歌曲吧。'); return; }
  busy = true; renderToday(); setStatus('正在为你挑选今天的唱片…');
  try {
    current = ((await E.getDaily(todayStr(), { count: countPref() })) || []).map(normTrack).filter(Boolean);
    setStatus(current.length ? `今天的 ${current.length} 首已就绪。你的评分会让明天更准。` : '这次没找到合适的歌，试试多加几个口味种子。');
  } catch (e) { console.error(e); setStatus('推荐出错：' + (e && e.message || e)); }
  busy = false; renderToday();
}
const countPref = () => +((profile().settings || {}).count) || 10;

async function nextBatch() {
  if (!E || busy) return;
  const prevIds = current.map(t => t.trackId);
  const fromEl = document.querySelector('.card.playing .vinyl') || document.querySelector('.card .vinyl');
  const fromRect = fromEl && fromEl.getBoundingClientRect(), fromArt = fromEl && fromEl.querySelector('.disc').style.backgroundImage;
  busy = true; $('#refresh').disabled = true; setStatus('正在换一批…');
  stopPlayback();
  try {
    let tr = ((await E.getDaily(todayStr(), { exclude: prevIds, count: countPref() })) || []).map(normTrack).filter(Boolean);
    const same = tr.length && tr.every(t => prevIds.includes(t.trackId));
    if (same) tr = ((await E.getDaily(todayStr(), { refresh: true, count: countPref() })) || []).map(normTrack).filter(Boolean); // defensive only: MusicRec supports exclude; this covers an engine that ignores it
    if (tr.length) { current = tr; setStatus(`新的一批 ${tr.length} 首。`); } else setStatus('没有更多新歌了，明天再来吧。');
  } catch (e) { console.error(e); setStatus('推荐出错：' + (e && e.message || e)); }
  busy = false; renderToday();
  const toEl = document.querySelector('.card .vinyl');
  if (fromRect && toEl) relay(fromRect, fromArt, toEl);
}
$('#refresh').addEventListener('click', nextBatch);

// ---------- playback + relay ----------
function stopPlayback() { player.pause(); setPlaying(null); }
function setPlaying(id) {
  playingId = id;
  document.querySelectorAll('.card').forEach(li => {
    const on = li.dataset.id === id; li.classList.toggle('playing', on);
    const p = li.querySelector('.vinyl .play'); if (p) p.textContent = on ? '❚❚' : '▶';
  });
}
function play(t) {
  player.src = t.previewUrl;
  player.play().catch(err => { console.warn(err); setStatus('试听无法播放'); setPlaying(null); });
  setPlaying(t.trackId);
}
// A disc overlay slides from the previous cover to the next one, then the next record spins.
function relay(fromRect, fromArt, toVinyl, done) {
  if (reduceMotion() || !fromRect || !toVinyl) { done && done(); return; }
  const to = toVinyl.getBoundingClientRect();
  const d = document.createElement('div'); d.className = 'relay-disc'; d.setAttribute('aria-hidden', 'true');
  if (fromArt) d.style.backgroundImage = fromArt;
  Object.assign(d.style, { left: fromRect.left + 'px', top: fromRect.top + 'px', width: fromRect.width + 'px', height: fromRect.height + 'px' });
  document.body.appendChild(d);
  const dx = to.left - fromRect.left, dy = to.top - fromRect.top, s = to.width / fromRect.width;
  toVinyl.classList.add('awaiting');
  const a = d.animate([{ transform: 'translate(0,0) rotate(0deg) scale(1)', opacity: 1 },
    { transform: `translate(${dx}px,${dy}px) rotate(200deg) scale(${s})`, opacity: 1, offset: .85 },
    { transform: `translate(${dx}px,${dy}px) rotate(240deg) scale(${s})`, opacity: 0 }],
    { duration: Math.min(900, 520 + Math.abs(dy) * 0.25), easing: 'cubic-bezier(.4,0,.2,1)' });
  const fin = () => { d.remove(); toVinyl.classList.remove('awaiting'); done && done(); };
  a.onfinish = fin; a.oncancel = fin;
}
function playWithRelay(fromId, t) {
  const fromLi = fromId && document.querySelector(`.card[data-id="${CSS.escape(fromId)}"]`);
  const toLi = document.querySelector(`.card[data-id="${CSS.escape(t.trackId)}"]`);
  if (!fromLi || !toLi || fromLi === toLi) { play(t); return; }
  const fromV = fromLi.querySelector('.vinyl'); let fr = fromV.getBoundingClientRect(); const art = fromV.querySelector('.disc').style.backgroundImage;
  const y0 = scrollY; toLi.scrollIntoView({ block: 'nearest' }); const dy = scrollY - y0;
  fr = { left: fr.left, top: fr.top - dy, width: fr.width, height: fr.height };
  play(t); relay(fr, art, toLi.querySelector('.vinyl'));
}
player.addEventListener('ended', () => {            // auto-advance to the next playable card, with the relay
  const from = playingId, i = current.findIndex(t => t.trackId === from);
  const next = current.slice(i + 1).find(t => t.previewUrl);
  if (next) playWithRelay(from, next); else setPlaying(null);
});

// ---------- feedback ----------
$('#today-list').addEventListener('click', e => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const id = b.closest('.card').dataset.id, t = current.find(x => x.trackId === id); if (!t) return;
  const act = b.dataset.act;
  if (act === 'ban') { const ns = banNames(t); if (ns.length === 1) { if (isBanned(ns[0])) unbanArtist(ns[0], t); else banArtist(ns[0], t); } else banMenu(b, ns, t); return; }
  if (act === 'play') {
    if (!t.previewUrl) return;
    if (playingId === id) stopPlayback(); else if (playingId) { const f = playingId; player.pause(); playWithRelay(f, t); } else play(t);
    return;
  }
  if (!has('rate')) return;
  const f = fbMap()[id] || {}, liked = f.liked || f.v === 1, disliked = f.disliked || f.v === -1;
  let value;
  // un-toggling a thumb uses 'unlike'/'undislike' (engine: v=0, stars kept); same star again -> 0 (engine: stars cleared, thumb kept)
  if (act === 'like') value = liked ? 'unlike' : 'like';
  if (act === 'dislike') value = disliked ? 'undislike' : 'dislike';
  if (act === 'rate') { const r = +b.dataset.r; value = f.r === r ? 0 : r; }
  const { feedback, ...plain } = t;
  try { E.rate(id, value, plain); } catch (err) { console.error(err); setStatus('保存反馈失败：' + err.message); }
  updateCard(id); renderStats(current.length); renderTimeline();   // state read back from getFeedback()
});

// ---------- timeline ----------
function fbLabel(f) {
  const parts = [];
  if (f.liked || f.v === 1) parts.push('喜欢'); else if (f.disliked || f.v === -1) parts.push('不喜欢');
  if (f.r) parts.push('★'.repeat(f.r)); return parts.join(' · ') || '评分';
}
function renderTimeline() {
  const el = $('#timeline'); const fb = feedbackList().slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  el.hidden = !fb.length; if (!fb.length) return;
  $('#tl-count').textContent = fb.length;
  const today = ymd(Date.now());
  $('#tl-list').innerHTML = fb.slice(0, 40).map(f => { const t = normTrack(f.track) || { title: f.trackId, artist: '' };
    const day = f.at ? ymd(f.at) : ''; if (typeof f.r !== 'number') f.r = +f.r || 0;
    return `<li class="${f.disliked || f.v === -1 ? 'neg' : ''}"><time datetime="${f.at ? new Date(f.at).toISOString() : ''}">${f.at ? (day === today ? '' : day.slice(5) + ' ') + hhmm(f.at) : ''}</time>
      <span class="tl-what">${esc(fbLabel(f))}</span><span class="tl-track">${esc(t.title)}<span class="muted"> — ${esc(t.artist)}</span></span></li>`; }).join('');
}

// ---------- taste / onboarding ----------
const DEFAULT_GENRES = ['华语流行', '说唱 / Hip-Hop', 'K-Pop', 'R&B', '流行 Pop', '摇滚', '独立 / Indie', '电子', '爵士', '古典', '民谣', 'J-Pop', '粤语', '城市流行 City Pop', 'Lo-fi', '原声 / 影视'];
function renderTaste() {
  const s = seeds();
  const gs = [...new Set([...DEFAULT_GENRES, ...s.genres])];
  $('#genre-chips').innerHTML = gs.map(g => `<button class="chip${s.genres.includes(g) ? ' on' : ''}" data-g="${esc(g)}">${esc(g)}</button>`).join('');
  $('#artist-picked').innerHTML = s.artists.map((a, i) => `<button class="chip" data-rm="artists" data-i="${i}">${esc(a)}</button>`).join('');
  $('#song-picked').innerHTML = s.songs.map((x, i) => `<button class="chip" data-rm="songs" data-i="${i}">${esc(x)}</button>`).join('');
  const p = profile(); $('#taste-status').textContent = p.replayCount ? `已读取 ${p.replayCount} 首 Replay 歌曲作为口味信号。` : '';
  renderBans();
}
$('#ban-list').addEventListener('click', e => { const b = e.target.closest('[data-unban]'); if (b) unbanArtist(b.dataset.unban); });
const saveSeeds = patch => { if (has('saveSeeds')) E.saveSeeds(patch); };
$('#genre-chips').addEventListener('click', e => {
  const g = e.target.closest('[data-g]'); if (!g) return; const list = seeds().genres, v = g.dataset.g, i = list.indexOf(v);
  i >= 0 ? list.splice(i, 1) : list.push(v); saveSeeds({ genres: list }); g.classList.toggle('on', i < 0);
});
document.querySelectorAll('.picked').forEach(el => el.addEventListener('click', e => {
  const b = e.target.closest('[data-rm]'); if (!b) return; const k = b.dataset.rm, list = seeds()[k]; list.splice(+b.dataset.i, 1); saveSeeds({ [k]: list }); renderTaste();
}));
let lastResults = { artist: [], song: [] };
document.querySelectorAll('form.search').forEach(f => f.addEventListener('submit', async e => {
  e.preventDefault(); const kind = f.dataset.kind, q = f.querySelector('input').value.trim(); if (!q) return;
  const ul = $(`#${kind}-results`); ul.innerHTML = '<li class="muted">搜索中…</li>';
  try {
    let res; const note = kind === 'song' ? $('#song-note') : null; if (note) { note.hidden = true; note.textContent = ''; }
    if (kind === 'artist') res = (await searchArtists(q)) || [];
    else { const r = await searchSongs(q); res = r.list; if (note && r.missing) { note.textContent = missingNote(r, res.length); note.hidden = false; } }
    lastResults[kind] = res;
    ul.innerHTML = res.length ? res.map((r, i) => kind === 'artist'
      ? `<li data-i="${i}"><div><div>${esc(r.name)}</div><div class="sub">${esc(r.genre || '')}</div></div></li>`
      : `<li data-i="${i}"${r.artistMatch === false ? ' class="cover"' : ''}>${r.artworkUrl ? `<img src="${esc(r.artworkUrl)}" alt="">` : ''}<div><div>${esc(r.title)}${r.artistMatch === false ? ' <span class="tag" title="不是你搜索的歌手的原版">非原唱 / 同名</span>' : ''}</div><div class="sub"><span class="r-artist">${esc(r.artist || '未知歌手')}</span>${r.album ? ' · ' + esc(r.album) : ''}</div></div></li>`).join('')
      : '<li class="muted">没有找到结果</li>';
  } catch (err) { ul.innerHTML = `<li class="muted">搜索失败：${esc(err.message)}</li>`; }
}));
['artist', 'song'].forEach(kind => $(`#${kind}-results`).addEventListener('click', e => {
  const li = e.target.closest('li[data-i]'); if (!li) return; const r = lastResults[kind][+li.dataset.i]; if (!r) return;
  const s = seeds();
  if (kind === 'artist') { if (!s.artists.includes(r.name)) saveSeeds({ artists: [...s.artists, r.name] }); }
  else { const v = `${r.title} - ${r.artist}`; if (!s.songs.includes(v)) saveSeeds({ songs: [...s.songs, v] }); }
  renderTaste(); $(`#${kind}-results`).innerHTML = '';
}));
$('#save-taste').addEventListener('click', () => {
  if (!hasTaste()) { $('#taste-status').textContent = '至少选一个流派、歌手或歌曲。'; return; }
  show('today'); loadToday();
});
$('#import-replay').addEventListener('click', async () => {
  if (!has('setReplay')) return;
  try { const j = await (await fetch('replay-2026.json')).json(); const n = E.setReplay(j); $('#taste-status').textContent = `已读取 ${n} 首 Replay 2026 歌曲作为口味信号。`; }
  catch (e) { $('#taste-status').textContent = '读取 Replay 失败：' + e.message; }
});

// ---------- history (grouped by date, then by set) ----------
function renderHistory() {
  let H = []; try { H = (has('getHistory') && E.getHistory()) || []; } catch (e) { console.error(e); }
  if (!Array.isArray(H)) H = [];
  H = H.filter(d => d && d.date).map(d => ({ date: String(d.date), sets: (Array.isArray(d.sets) ? d.sets : []).map(x => ({ at: x && x.at, tracks: (x && Array.isArray(x.tracks) ? x.tracks : []).filter(t => t && typeof t === 'object') })) }));
  $('#history-list').innerHTML = H.length ? H.map((d, di) => {
    const n = d.sets.reduce((s, x) => s + x.tracks.length, 0);
    return `<details class="day"${di === 0 ? ' open' : ''}><summary><span>${esc(d.date)}</span><span class="muted small">${d.sets.length} 批 · ${n} 首</span></summary>${
      d.sets.map((set, si) => `<div class="set"><div class="set-head"><span>第 ${si + 1} 批</span>${set.at ? `<time>${hhmm(set.at)}</time>` : ''}</div><ul class="hist">${
        set.tracks.map(x => { const t = normTrack(x); if (!t) return ''; const f = x.feedback || {};
          return `<li>${t.artworkUrl ? `<img src="${esc(t.artworkUrl)}" alt="">` : '<span class="dot"></span>'}<span class="grow">${esc(t.title)} — <span class="muted">${esc(t.artist)}</span></span>
          <span class="fb">${f.v === 1 ? '♥' : f.v === -1 ? '✕' : ''}${f.r ? ' ' + '★'.repeat(f.r) : ''}</span><a href="${esc(t.appleMusicUrl)}" target="_blank" rel="noopener">打开</a></li>`; }).join('')}</ul></div>`).join('')}</details>`;
  }).join('') : '<p class="muted">还没有历史记录。</p>';
}

// ---------- settings / data (all via MusicRec) ----------
function renderSettings() {
  const st = profile().settings || {};
  $('#set-count').value = st.count || 10; const cur = sf(), sel = $('#set-storefront'); if (![...sel.options].some(o => o.value === cur)) sel.add(new Option(cur.toUpperCase(), cur)); sel.value = cur;
  $('#engine-info').textContent = E ? `推荐引擎：MusicRec${E.version ? ' v' + E.version : ''}${MOCK ? '（开发模拟数据）' : ''}${legacy ? ' · 已忽略旧版界面数据（只读备份于 ' + LEGACY_KEY + '）' : ''}` : '推荐引擎还没就绪';
}
$('#save-settings').addEventListener('click', () => {
  if (!E) return;
  if (has('setSettings')) E.setSettings({ count: Math.min(30, Math.max(3, +$('#set-count').value || 10)) });
  const want = ($('#set-storefront').value || 'us').toLowerCase(); if (has('setStorefront') && want !== sf()) E.setStorefront(want);
  renderSettings(); $('#engine-info').textContent += ' · 已保存';
});
$('#export').addEventListener('click', () => {
  if (!has('exportData')) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([E.exportData()], { type: 'application/json' }));
  a.download = `yinyuebot-${todayStr()}.json`; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
// Old files: an old ui.js export wraps engine JSON in `engineState`; an even older ui.js state used {profile, history:[...], feedback:{like,rating}}.
function toEngineData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) throw new Error('bad format');
  if (d.engineState !== undefined) return toEngineData(typeof d.engineState === 'string' ? JSON.parse(d.engineState) : d.engineState);
  if (d.seeds || (d.history && !Array.isArray(d.history) && typeof d.history === 'object') || d.feedback && !d.profile) return d;   // MusicRec / app.js shape
  if (d.profile || Array.isArray(d.history)) {                                                                                   // old ui.js shape -> MusicRec shape
    const p = d.profile || {}, out = { seeds: { genres: [], artists: [], songs: [] }, feedback: {}, history: {} };
    out.seeds.genres = (p.genres || []).map(String);
    out.seeds.artists = (p.artists || []).map(a => typeof a === 'string' ? a : a && a.name).filter(Boolean);
    out.seeds.songs = (p.songs || []).map(x => typeof x === 'string' ? x : x && (x.artist ? `${x.title} - ${x.artist}` : x.title)).filter(Boolean);
    Object.entries(d.feedback || {}).forEach(([id, f]) => { if (!f) return; const v = f.v ?? f.like ?? 0, r = f.r ?? f.rating ?? 0; if (v || r) out.feedback[id] = { v, r, at: f.at || 0, track: f.track || null }; });
    (Array.isArray(d.history) ? d.history : []).forEach(h => { if (!h || !h.date) return; const tracks = (h.tracks || []).map(normTrack).filter(Boolean);
      (out.history[h.date] = out.history[h.date] || { sets: [] }).sets.push({ at: h.at || 0, tracks }); });
    if (d.settings) out.settings = d.settings;
    return out;
  }
  throw new Error('bad format');
}
function renderAllViews() { renderToday(); renderTaste(); renderHistory(); renderSettings(); }
const engineKey = () => (E && E.KEY) || 'yinyuebot.v1';
$('#import').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  if (!has('importData')) { alert('导入失败：推荐引擎还没就绪'); return; }
  // 1) read + parse + convert: failures here happen before importData -> just show the error, nothing to roll back
  let data;
  try {
    const text = await file.text();
    let d; try { d = JSON.parse(text); } catch { throw new Error('文件格式不对（不是 JSON）'); }
    try { data = toEngineData(d); } catch { throw new Error('文件格式不对'); }
  } catch (err) { console.warn('import rejected:', err.message); alert('导入失败：' + err.message); return; }
  // 2) confirm replacement
  const nFb = feedbackList().length; let nDays = 0; try { nDays = (E.getHistory() || []).length; } catch (e2) {}
  if (!confirm(`将替换现有 ${nFb} 条反馈、${nDays} 天历史，确定导入？`)) return;
  // 3) import; roll back the raw engine storage only if importData was called and it (or anything after it) failed
  const KEY = engineKey(), backup = localStorage.getItem(KEY), prevCurrent = current;
  try {
    await E.importData(data);
    E.getHistory(); E.getFeedback(); profile();          // engine must be able to read what it imported
    current = []; await loadToday(); renderAllViews();
    if (noTasteData()) { const m = '导入成功，但没有口味数据，请先选择喜欢的曲风/歌手'; promptTaste(m); alert(m); }
    else alert('导入成功');
  } catch (err) {
    console.warn('import failed, rolling back:', err && err.message);
    try { if (backup === null) localStorage.removeItem(KEY); else localStorage.setItem(KEY, backup); } catch (e3) { console.warn(e3); }
    // MusicRec re-reads localStorage on every call (no in-memory state), so restoring the key is enough
    current = prevCurrent; try { renderAllViews(); } catch (e4) { console.warn(e4); }
    const m = err && err.message || ''; alert(/^导入失败/.test(m) ? m : '导入失败：' + (/[\u4e00-\u9fa5]/.test(m) ? m : '文件格式不对'));
  }
});
$('#reset').addEventListener('click', () => {
  if (!confirm('确定清空所有口味、评分和历史？')) return;
  try { if (E && typeof E.reset === 'function') E.reset(); else localStorage.removeItem(engineKey()); } catch (e) { console.warn(e); }
  try { localStorage.removeItem(PREF_KEY); if (MOCK) localStorage.removeItem('yinyuebot.mock.v1'); } catch (e) {}
  location.reload();
});

// ---------- dev-only mock implementing the MusicRec surface (?mock=1) ----------
function devMock() {
  const KEY = 'yinyuebot.mock.v1';
  const def = () => ({ seeds: { genres: [], artists: [], songs: [] }, settings: { storefront: 'us', count: 10 }, feedback: {}, history: {}, replay: [] });
  const load = () => { try { return Object.assign(def(), JSON.parse(localStorage.getItem(KEY)) || {}); } catch { return def(); } };
  const save = S => localStorage.setItem(KEY, JSON.stringify(S));
  const art = (h, l) => 'data:image/svg+xml,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300"><rect width="300" height="300" fill="hsl(${h},35%,${l}%)"/><circle cx="210" cy="90" r="60" fill="hsl(${(h + 40) % 360},45%,60%)" opacity=".7"/></svg>`);
  let wav = '';
  const silentWav = (sec = 4, rate = 8000) => {   // short silent clip generated locally so play/ended/relay can be tested offline
    if (wav) return wav; const n = sec * rate, buf = new ArrayBuffer(44 + n), v = new DataView(buf), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); v.setUint32(4, 36 + n, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true); w(36, 'data'); v.setUint32(40, n, true);
    new Uint8Array(buf, 44).fill(128); return (wav = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' })));
  };
  const names = [['FE!N', 'Travis Scott', '嘻哈/说唱'], ['pushin P', 'Gunna', '嘻哈/说唱'], ['Midas Touch', 'KISS OF LIFE', 'K-Pop'], ['Ghostface Killers', '21 Savage, Offset & Metro Boomin', '嘻哈/说唱'],
    ['晴天', '周杰伦', '华语流行'], ['UNFORGIVEN', 'LE SSERAFIM', 'K-Pop'], ['I AM', 'IVE', 'K-Pop'], ['Supernova', 'aespa', 'K-Pop'], ['No Pole', 'Don Toliver', 'R&B'], ['夜的第七章', '周杰伦', '华语流行']];
  const POOL = Array.from({ length: 40 }, (_, i) => { const [t, a, g] = names[i % names.length]; const id = String(9000000 + i), cid = String(8000000 + i);
    const url = `https://music.apple.com/us/album/${cid}?i=${id}`;
    return { trackId: id, artistId: String(7000000 + (i % names.length)), title: i < names.length ? t : `${t} (Mock ${Math.floor(i / names.length) + 1})`, artist: a, album: 'Mock Album', genre: g,
      artwork: i % 7 === 6 ? '' : art(i * 37, 28 + (i % 3) * 8), previewUrl: '', appleMusicUrl: url, appUrl: url.replace(/^https:/, 'music:'), reason: i % 2 ? `和 ${a} 风格相似` : `流派推荐：${g}` }; });
  const withPreview = t => Object.assign({}, t, { previewUrl: silentWav() });
  const M = {
    version: 'mock', KEY,
    getProfile() { const S = load(); return { seeds: S.seeds, settings: S.settings, replayCount: S.replay.length, feedback: M.getFeedback(), historyDates: Object.keys(S.history).sort().reverse() }; },
    getFeedback() { const S = load(); return Object.entries(S.feedback).map(([id, f]) => ({ trackId: id, v: f.v || 0, r: f.r || 0, at: f.at || 0, liked: f.v === 1, disliked: f.v === -1, track: f.track || null })).sort((a, b) => b.at - a.at); },
    saveSeeds(p = {}) { const S = load(); ['genres', 'artists', 'songs'].forEach(k => { if (p[k] !== undefined) S.seeds[k] = [...p[k]]; }); save(S); return S.seeds; },
    setReplay(j) { const S = load(); S.replay = (Array.isArray(j) ? j : (j && j.tracks) || []).filter(t => t && t.trackId).map(t => ({ trackId: String(t.trackId), title: t.title })); save(S); return S.replay.length; },
    async getDaily(date, o = {}) {
      await new Promise(r => setTimeout(r, 250));
      const S = load(), H = S.history[date], ex = (o.exclude || []).map(String), fresh = !!o.refresh || ex.length > 0;
      if (H && H.sets.length && !fresh) return H.sets[H.sets.length - 1].tracks.map(withPreview);
      const shown = new Set(); if (H) H.sets.forEach(s => s.tracks.forEach(t => shown.add(t.trackId)));
      const tracks = POOL.filter(t => !shown.has(t.trackId) && !ex.includes(t.trackId) && !S.feedback[t.trackId] && !(S.artistBans || []).some(a => splitArtistsLocal(t.artist).concat(t.artist).some(x => x.toLowerCase() === a.toLowerCase()))).slice(0, o.count || S.settings.count || 10);
      if (tracks.length) { (S.history[date] = S.history[date] || { sets: [] }).sets.push({ at: Date.now(), tracks }); save(S); }
      return tracks.map(withPreview);
    },
    rate(id, value, track) {
      const S = load(); id = String(id); const f = Object.assign({ v: 0, r: 0 }, S.feedback[id] || {});
      if (value === 'like') { f.v = 1; if (f.r && f.r <= 2) f.r = 0; } else if (value === 'dislike') { f.v = -1; if (f.r >= 4) f.r = 0; }
      else if (value === 'unlike' || value === 'undislike' || value === 'neutral') f.v = 0;
      else if (value === 'clear') { f.v = 0; f.r = 0; } else { const r = Math.max(0, Math.min(5, Math.round(+value) || 0)); f.r = r; if (r >= 4) f.v = 1; else if (r && r <= 2) f.v = -1; }
      f.at = Date.now(); if (track) f.track = Object.assign({}, track, { previewUrl: '' });
      if (!f.v && !f.r) delete S.feedback[id]; else S.feedback[id] = f; save(S); return S.feedback[id] || null;
    },
    getHistory() { const S = load(); return Object.keys(S.history).sort().reverse().map(date => ({ date, sets: S.history[date].sets.map(s => ({ at: s.at, tracks: s.tracks.map(t => Object.assign({}, t, { feedback: S.feedback[t.trackId] || null })) })) })); },
    exportData() { return JSON.stringify(load(), null, 2); },
    banCalls: [],   // dev spy: [fn, name, opts]
    dislikeArtist(n, o) { this.banCalls.push(['dislikeArtist', n, o]); const S = load(); S.artistBans = S.artistBans || []; n = String(n || '').trim(); if (n && !S.artistBans.some(a => a.toLowerCase() === n.toLowerCase())) S.artistBans.push(n); save(S); return S.artistBans; },
    undislikeArtist(n, o) { this.banCalls.push(['undislikeArtist', n, o]); const S = load(); S.artistBans = (S.artistBans || []).filter(a => a.toLowerCase() !== String(n || '').toLowerCase()); save(S); return S.artistBans; },
    importData(j) { const d = typeof j === 'string' ? JSON.parse(j) : j; if (!d || typeof d !== 'object') throw new Error('invalid data'); save(Object.assign(def(), d)); return true; },
    setStorefront(s = 'us') { const S = load(); S.settings.storefront = s; save(S); return s; },
    setSettings(p = {}) { const S = load(); Object.assign(S.settings, p); save(S); return S.settings; },
    async searchArtists(q) { return [{ artistId: 1, name: q + '（模拟）', genre: 'Pop', url: '' }]; },
    async searchSongs(q) {   // dev cases: 晴天 = array + artistMissing props (names given); 稻香 = object shape, no names (generic notice); 无此歌 / 查无 = the 0-result variants
      const cover = (t, a, i) => Object.assign({}, POOL[i], { title: t, artist: a, artistMatch: false });
      if (/晴天/.test(q)) { const r = [cover('晴天', 'Cover Band', 1), cover('晴天 (Piano)', 'Piano Pal', 2)]; r.artistMissing = true; r.queryArtist = '周杰伦'; r.queryTitle = '晴天'; return r; }
      if (/无此歌/.test(q)) { const r = []; r.artistMissing = true; r.queryArtist = '周杰伦'; r.queryTitle = '无此歌'; return r; }   // names, 0 results
      if (/zzqx/.test(q)) return [];                                                                                                  // 0 results, no flag
      if (/查无/.test(q)) return { tracks: [], artistMissing: true };                                                                   // generic, 0 results
      if (/稻香/.test(q)) return { tracks: [cover('稻香', 'Someone Else', 3), POOL[4]], artistMissing: true };
      return [POOL[0]]; },
  };
  return M;
}

// ---------- boot ----------
(async () => {
  const initialTab = prefs.tab; show(initialTab || 'today'); engineNotice();
  await initEngine();
  if (E && legacy && legacy.profile && !hasTaste()) {            // one-time: carry old seeds over to MusicRec (history/feedback stay ignored)
    const p = legacy.profile; saveSeeds({ genres: p.genres || [], artists: (p.artists || []).map(a => a.name || a).filter(Boolean),
      songs: (p.songs || []).map(s => typeof s === 'string' ? s : (s.artist ? `${s.title} - ${s.artist}` : s.title)).filter(Boolean) });
  }
  if (MOCK && !hasTaste()) saveSeeds({ genres: ['K-Pop'] });
  $('#import-replay').hidden = !has('setReplay');
  engineNotice();
  if (noTasteData()) promptTaste('先选择喜欢的曲风/歌手，再生成今天的推荐。');
  else show(initialTab || 'today');
  await loadToday();
  window.YYBUI = { get engine() { return E; }, get current() { return current; }, nextBatch, normTrack };   // debug handle
})();
})();
