// 노스포 자동 수집 — 공식 채널·재생목록의 공개 페이지/RSS만 읽어서 data.json을 만든다.
// GitHub Actions에서 3시간마다 실행된다.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const VERSION = 4;
const KEEP_DAYS = 60;          // 이 기간 안의 경기만 보관
const MAX_DATE_LOOKUPS = 150;  // 한 번 실행에 영상 페이지로 날짜 조회할 최대 수
const PAGE_ITEMS = 40;         // 재생목록/채널 페이지에서 최신 몇 개까지 볼지

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Cookie': 'CONSENT=YES+1; SOCS=CAI',
};
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const get = async url => {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.text();
};
const kstDate = iso => new Date(iso).toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// ── 페이지에서 영상 목록 뽑기 ─────────────────────────────
function initialData(html) {
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  return m ? JSON.parse(m[1]) : null;
}
function lockups(data) {
  const out = [];
  JSON.stringify(data, (k, v) => {
    if (k === 'lockupViewModel' && v?.contentId && v.contentId.length === 11) {
      const md = v.metadata?.lockupMetadataViewModel;
      const t = md?.title?.content;
      const rows = (md?.metadata?.contentMetadataViewModel?.metadataRows || [])
        .flatMap(r => (r.metadataParts || []).map(p => p.text?.content || '')).join(' ');
      if (t) out.push({ id: v.contentId, title: t, ago: rows });
    }
    if (k === 'playlistVideoRenderer' && v?.videoId) out.push({ id: v.videoId, title: v.title?.runs?.[0]?.text || '' });
    if (k === 'videoRenderer' && v?.videoId) out.push({ id: v.videoId, title: v.title?.runs?.[0]?.text || '' });
    return v;
  });
  return out;
}
async function rss(query) {
  const xml = await get('https://www.youtube.com/feeds/videos.xml?' + query);
  return xml.split('<entry>').slice(1).map(e => ({
    id: (e.match(/<yt:videoId>([^<]+)/) || [])[1],
    title: decode((e.match(/<title>([^<]*)/) || [])[1] || ''),
    date: kstDate((e.match(/<published>([^<]+)/) || [])[1]),
  })).filter(x => x.id);
}
async function channelId(handle) {
  const html = await get('https://www.youtube.com/' + handle);
  const m = html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error('채널 ID 못 찾음');
  return m[1];
}
async function collect(src) {
  const items = new Map();
  const add = list => list.forEach(x => { if (!items.has(x.id) || x.date) items.set(x.id, { ...items.get(x.id), ...x }); });
  if (src.playlist) {
    add(lockups(initialData(await get('https://www.youtube.com/playlist?list=' + src.playlist))).slice(0, PAGE_ITEMS));
    add(await rss('playlist_id=' + src.playlist));
  } else {
    const id = await channelId(src.handle);
    add(lockups(initialData(await get(`https://www.youtube.com/${src.handle}/videos`))).slice(0, PAGE_ITEMS));
    add(await rss('channel_id=' + id));
  }
  return [...items.values()];
}

// ── 날짜 추정 ─────────────────────────────────────────
// 1) RSS의 정확한 업로드 시각  2) 제목 속 날짜(10/12, 11.04)  3) "3시간 전" 같은 상대 시간
const UNIT = { 초: 1e3, 분: 6e4, 시간: 36e5, 일: 864e5, 주: 6048e5, 개월: 2592e6, 년: 31536e6 };
function agoDate(text) {
  const m = (text || '').match(/(\d+)\s*(초|분|시간|일|주|개월|년)\s*전/);
  if (!m) return null;
  return { date: kstDate(new Date(Date.now() - Number(m[1]) * UNIT[m[2]]).toISOString()), coarse: ['주', '개월', '년'].includes(m[2]) };
}
function titleDate(title, ref) {
  const m = title.match(/(?:^|[\s(\[])(\d{1,2})[./](\d{1,2})(?=[\s)\]]|경기|$)/);
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const now = new Date(ref || Date.now());
  let y = now.getUTCFullYear();
  if (mo > now.getUTCMonth() + 2) y -= 1;   // 12월에 1월 날짜 등 연도 넘어감 처리
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ── 제목 해석 (점수·결과는 절대 저장하지 않음) ─────────────
const VS = /\s(?:vs\.?|VS|Vs|v)\s/;
function parseTeams(title) {
  const outside = title.replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)/g, ' ').split(/[|｜/·]|\sI\s/);
  const inside = (title.match(/\[[^\]]*\]|【[^】]*】/g) || []).map(x => x.slice(1, -1));
  const seg = outside.find(p => VS.test(p)) || inside.find(p => VS.test(p));
  if (!seg) return null;
  const [a, b] = seg.split(VS);
  const clean = x => (x || '')
    .replace(/ㅣ.*$/, ' ')
    .replace(/\d+\s*[-:]\s*\d+/g, ' ')
    .replace(/(^|\s)\d+R(?=\s|$)/g, ' ')
    .replace(/(^|\s)(플레이오프|준플레이오프|와일드카드|\d+차전|준결승|결승전?|8강|4강|16강)(?=\s|$)/g, ' ')
    .replace(/(^|\s)\d+라운드(?=\s|$)/g, ' ')
    .replace(/(^|\s)게임\s*\d+/g, ' ')
    .replace(/\d+\s*분/g, ' ')
    .replace(/하이라이트|HIGHLIGHTS?|Highlights?|H\/L|풀영상|FULL|매치|경기/gi, ' ')
    .replace(/(^|\s)(풀|전체|주요)(?=\s|$)/g, ' ')
    .replace(/[^\p{L}\p{N}\s.&']/gu, ' ')
    .replace(/\s+/g, ' ').trim();
  const A = clean(a).split(' ').slice(-4).join(' ');
  const B = clean(b).split(' ').slice(0, 4).join(' ');
  return A && B ? { a: A, b: B } : null;
}
function videoKind(title) {
  const g = title.match(/게임\s*(\d+)/);
  if (g) return { kind: 'game', n: Number(g[1]), label: `게임 ${g[1]}` };
  if (/풀\s*하이라이트|풀영상|Full VOD/i.test(title)) return { kind: 'full', label: '풀 하이라이트' };
  return { kind: 'main', label: '하이라이트' };
}
const SKIP = /주요장면|모음|클러치|인터뷰|TOP\s?\d|예고|프리뷰|리뷰|#shorts|쇼츠|현지해설|이슈/i;

function accept(src, title) {
  if (SKIP.test(title)) return null;
  if (src.must && !src.must.some(k => title.includes(k))) return null;
  if (src.exclude && new RegExp(src.exclude, 'i').test(title)) return null;
  let league = src.league;
  if (src.leagueFromBracket) {
    const br = (title.match(/\[([^\]]+)\]/) || [])[1] || '';
    const name = br.replace(/^\d+\/\d+\s*/, '').trim();
    if (src.bracketAllow && !src.bracketAllow.some(x => name.includes(x))) return null;
    if (!name || VS.test(name)) return null;
    league = LEAGUE_NAMES[name] || name;
  }
  return league;
}
const LEAGUE_NAMES = { UCL: '챔피언스리그', UEL: '유로파리그', UECL: '컨퍼런스리그', SPFL: '스코틀랜드 리그' };
const KBO_TEAMS = ['LG', 'KT', 'SSG', 'NC', '두산', 'KIA', '롯데', '삼성', '한화', '키움'];

// ── 실행 ─────────────────────────────────────────────
const sources = readJson('sources.json', []);
const old = readJson('data.json', {});
const dateCache = old.v === VERSION ? old.dates || {} : {};
const found = [];   // {id,title,date?,sport,league}

for (const src of sources) {
  const name = src.playlist ? `재생목록 ${src.league}` : src.handle;
  try {
    const list = await collect(src);
    let n = 0;
    for (const it of list) {
      const league = accept(src, it.title);
      if (!league) continue;
      const t = parseTeams(it.title);
      if (!t) continue;
      if (src.sport === 'baseball' && !(KBO_TEAMS.some(k => t.a.includes(k)) && KBO_TEAMS.some(k => t.b.includes(k)))) continue;
      found.push({ ...it, ...t, sport: src.sport, league, ...videoKind(it.title) });
      n++;
    }
    console.log(`✅ ${name}: 영상 ${list.length}개 중 경기 영상 ${n}개`);
  } catch (e) {
    console.log(`❌ ${name}: ${e.message}`);
  }
}

// 날짜: RSS → 제목 속 날짜 → "N시간 전" 순서로 정하고, 몇 주 전 영상만 영상 페이지에서 다시 확인
for (const f of found) {
  if (f.date) { dateCache[f.id] = f.date; continue; }
  if (dateCache[f.id]) continue;
  const td = titleDate(f.title);
  if (td) { dateCache[f.id] = td; continue; }
  const ad = agoDate(f.ago);
  if (ad && !ad.coarse) dateCache[f.id] = ad.date;
  else if (ad) f.coarse = ad.date;
}
const need = [...new Set(found.filter(f => !dateCache[f.id]).map(f => f.id))].slice(0, MAX_DATE_LOOKUPS);
for (let i = 0; i < need.length; i += 8) {
  await Promise.all(need.slice(i, i + 8).map(async id => {
    try {
      const html = await get('https://www.youtube.com/watch?v=' + id);
      const m = html.match(/"uploadDate":"([^"]+)"/) || html.match(/"publishDate":"([^"]+)"/)
        || html.match(/itemprop="uploadDate" content="([^"]+)"/);
      if (m) dateCache[id] = kstDate(m[1]);
    } catch {}
  }));
}
let fallback = 0;
for (const f of found) if (!dateCache[f.id] && f.coarse) { dateCache[f.id] = f.coarse; fallback++; }
console.log(`날짜 조회 ${need.length}개 · 대략 날짜 ${fallback}개`);

// 같은 경기(같은 종목·팀, 날짜 하루 이내)의 영상들을 한 카드로 묶음
const cutoff = new Date(Date.now() - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
const matches = [];
const seen = new Set();
for (const f of found.sort((x, y) => (dateCache[y.id] || '').localeCompare(dateCache[x.id] || ''))) {
  const date = dateCache[f.id];
  if (!date || date < cutoff || seen.has(f.id)) continue;
  seen.add(f.id);
  const teams = `${f.a} vs ${f.b}`;
  const day = Date.parse(date);
  let m = matches.find(x => x.sport === f.sport && x.teams === teams && Math.abs(Date.parse(x.date) - day) <= 864e5);
  if (!m) {
    m = { id: f.id, sport: f.sport, league: f.league, teams, date, videos: [] };
    matches.push(m);
  }
  if (date < m.date) m.date = date;
  if (m.videos.some(v => v.kind === f.kind && v.n === f.n)) continue;
  m.videos.push({ id: f.id, kind: f.kind, label: f.label, ...(f.n ? { n: f.n } : {}) });
}
for (const m of matches) {
  const order = { main: 0, full: 1, game: 2 };
  m.videos.sort((a, b) => order[a.kind] - order[b.kind] || (a.n || 0) - (b.n || 0));
}

const manual = readJson('manual.json', []);
const all = [...manual, ...matches].sort((a, b) => b.date.localeCompare(a.date));
if (!all.length) { console.log('경기를 하나도 못 찾음 — data.json 유지'); process.exit(0); }

const keepDates = {};
for (const m of all) for (const v of m.videos || []) if (dateCache[v.id]) keepDates[v.id] = dateCache[v.id];
writeFileSync('data.json', JSON.stringify({ v: VERSION, updated: new Date().toISOString(), matches: all, dates: keepDates }));
const count = s => all.filter(m => m.sport === s).length;
console.log(`저장: 축구 ${count('soccer')} · 야구 ${count('baseball')} · LCK ${count('lck')} · UFC ${count('ufc')}`);
