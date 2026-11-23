// 공식 유튜브 채널 RSS → data.json 자동 생성 (GitHub Actions에서 실행)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Cookie': 'CONSENT=YES+1; SOCS=CAI',
};
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);

async function channelId(handle) {
  if (handle.startsWith('UC')) return handle;
  const html = await (await fetch('https://www.youtube.com/' + handle, { headers: HEADERS })).text();
  const m = html.match(/"externalId":"(UC[\w-]{22})"/) || html.match(/channel\/(UC[\w-]{22})/);
  if (!m) throw new Error('채널 ID를 찾지 못함');
  return m[1];
}

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// 제목에서 "A vs B"만 뽑고 점수·괄호는 버림 (스포일러 방지)
function parseTeams(title) {
  const hasVs = p => /\s(vs\.?|VS|Vs|v)\s/.test(p);
  const outside = title.replace(/\[[^\]]*\]|【[^】]*】|\([^)]*\)/g, ' ').split(/[|｜/·]/);
  const inside = (title.match(/\[([^\]]*)\]|【([^】]*)】/g) || []).map(x => x.slice(1, -1));
  const t = outside.find(hasVs) || inside.find(hasVs);
  if (!t) return null;
  const [a, b] = t.split(/\s(?:vs\.?|VS|Vs|v)\s/);
  const clean = x => (x || '')
    .replace(/\d+\s*[-:]\s*\d+/g, ' ')
    .replace(/하이라이트|HIGHLIGHTS?|Highlights?|H\/L|풀영상|FULL/gi, ' ')
    .replace(/[^\p{L}\p{N}\s.&']/gu, ' ')
    .replace(/ㅣ.*$/, ' ')
    .replace(/(^|\s)\d+R(?=\s|$)/g, ' ')
    .replace(/(^|\s)\d+라운드(?=\s|$)/g, ' ')
    .replace(/\d+\s*분/g, ' ')
    .replace(/(^|\s)(매치|경기|주요장면)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ').trim();
  const A = clean(a).split(' ').slice(-4).join(' ');
  const B = clean(b).split(' ').slice(0, 4).join(' ');
  if (!A || !B) return null;
  return `${A} vs ${B}`;
}

const channels = readJson('channels.json', []);
// 다른 종목(농구·배구 등)이 섞이지 않게 거르는 단어
const EXCLUDE = /배드민턴|&|야구|APBC|WBC|모음|TOP ?\d|농구|KBL|WKBL|배구|V-?리그|은행|생명|BNK|KB스타즈|핸드볼/i;
const old = readJson('data.json', { matches: [] });
const prev = old.v === 3 ? old.matches.filter(m => !m.manual) : [];
const byId = new Map(prev.map(m => [m.id, m]));
let ok = 0;

for (const ch of channels) {
  try {
    const id = await channelId(ch.handle);
    const xml = await (await fetch('https://www.youtube.com/feeds/videos.xml?channel_id=' + id, { headers: HEADERS })).text();
    const entries = xml.split('<entry>').slice(1);
    let added = 0;
    for (const e of entries) {
      const vid = (e.match(/<yt:videoId>([^<]+)/) || [])[1];
      const title = decode((e.match(/<title>([^<]*)/) || [])[1] || '');
      const pub = (e.match(/<published>([^<]+)/) || [])[1] || '';
      if (!vid || (ch.must && !ch.must.some(k => title.includes(k)))) continue;
      if (EXCLUDE.test(title)) continue;
      if (ch.months && !ch.months.includes(Number(pub.slice(5, 7)))) continue;
      const teams = parseTeams(title);
      if (!teams) continue;
      if (ch.teams) {
        const [a, b] = teams.split(' vs ');
        if (!ch.teams.some(t => a.includes(t)) || !ch.teams.some(t => b.includes(t))) continue;
      }
      byId.set(vid, {
        id: vid, sport: ch.sport, league: ch.league, teams,
        date: pub.slice(0, 10), status: 'end',
        highlight: 'https://www.youtube.com/watch?v=' + vid,
      });
      added++;
    }
    ok++;
    console.log(`✅ ${ch.handle} (${id}): 영상 ${entries.length}개 중 경기 ${added}개`);
  } catch (err) {
    console.log(`❌ ${ch.handle}: ${err.message}`);
  }
}

const manual = readJson('manual.json', []).map((m, i) => ({ id: 'manual_' + i, status: 'end', ...m, manual: true }));
const matches = [...manual, ...[...byId.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 300)];

if (!ok && !manual.length) { console.log('모든 채널 실패 — data.json 유지'); process.exit(0); }
writeFileSync('data.json', JSON.stringify({ v: 3, updated: new Date().toISOString(), matches }, null, 1));
console.log(`총 ${matches.length}경기 저장`);
