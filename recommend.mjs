// recommend.mjs — 每日推歌（云端版）
// 流程：读取你回信里的评分 → DeepSeek 据此选 5 首 → B站核验官方链接 → 邮件发送 → 更新 history.json / feedback.json
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import nodemailer from 'nodemailer';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(__dirname, 'history.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TZ = 'Asia/Shanghai';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 工具 ----------
function todayStr() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// 轮次编号：日期 + 北京时间时分（如 2026-10-03 12:05），用于把回信永久锁定到对应那一轮
function nowStamp() {
  const d = new Date();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
  return `${date} ${time}`;
}
function daysAgo(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const then = Date.UTC(y, m - 1, d);
  const now = todayStr().split('-').map(Number);
  const nowUtc = Date.UTC(now[0], now[1] - 1, now[2]);
  return Math.round((nowUtc - then) / 86400000);
}
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtViews = (v) => (v >= 10000 ? (v / 10000).toFixed(1) + '万' : String(v));
const stripHtml = (s) => String(s).replace(/<[^>]+>/g, '').trim();
const sanitizeKeyword = (s) => String(s).replace(/[\/\\|,，、;；:：·]/g, ' ').replace(/\s+/g, ' ').trim();
// 归一化：去掉空格/标点/大小写差异，用于歌名与歌手比对（解决 "TheFatRat" vs "The Fat Rat" 这类问题）
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\-–—_~·・,，。.、()（）\[\]【】《》"'"'!！?？:：/\\]/g, '');

// ---------- 解析你回信里的评分 ----------
// 只取回信正文（去掉被引用的原文，避免把邮件里的示例"1 9 太燃了"误当成评分）
function stripQuoted(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (/^\s*>/.test(line)) break;
    if (/^\s*(On .* wrote:|在.*写道[:：]|-{2,}|原始邮件|发件人[:：]|From[:：]\s|回复本邮件即可打分|序号\s*分数)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n');
}

function parseRatings(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    // 兼容「第1首 9 感受」/「1首 9 感受」写法，但只处理行首的序号，避免误伤正文里的「首」字
    const line = raw.trim().replace(/^第\s*(\d{1,2})\s*首/, '$1').replace(/^(\d{1,2})\s*首/, '$1');
    const m = line.match(/^(\d{1,2})\s*[\.、,，:：\)）]?\s*(\d{1,2})(?:\s*[\/／]\s*10)?\s*(.*)$/);
    if (!m) continue;
    const index = Number(m[1]);
    const score = Number(m[2]);
    if (index < 1 || index > 5 || score < 0 || score > 10) continue;
    out.push({ index, score, comment: (m[3] || '').trim() });
  }
  return out;
}

// ---------- 通过 IMAP 读取你的回信 ----------
async function fetchFeedbackReplies(history, processedIds) {
  const result = { feedback: [], ids: [] };
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || 'imap.qq.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
  });
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - 7 * 86400000);
      const uids = await client.search({ since }, { uid: true });
      if (Array.isArray(uids) && uids.length) {
        for await (const msg of client.fetch(uids, { envelope: true, source: true }, { uid: true })) {
          try {
            const subject = msg.envelope?.subject || '';
            const messageId = msg.envelope?.messageId || `uid-${msg.uid}`;
            if (!subject.includes('推歌')) continue;
            if (processedIds.includes(messageId)) continue;
            const parsed = await simpleParser(msg.source);
            const body = stripQuoted(parsed.text || stripHtml(parsed.html || ''));
            const ratings = parseRatings(body);
            if (!ratings.length) continue;
            // 优先用主题里的「轮次编号」（日期+时分）精确定位那一轮；老邮件没有编号时才退化为"按日期取最近一轮"
            const pushIdMatch = subject.match(/(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/);
            const dateMatch = subject.match(/(\d{4}-\d{2}-\d{2})/);
            const pushId = pushIdMatch ? pushIdMatch[1].trim() : null;
            const date = dateMatch ? dateMatch[1] : null;
            let daySongs;
            if (pushId && (history.pushed || []).some((e) => e.pushId === pushId)) {
              daySongs = (history.pushed || []).filter((e) => e.pushId === pushId);
            } else if (date) {
              daySongs = (history.pushed || []).filter((e) => e.date === date).slice(-5);
            } else {
              daySongs = (history.pushed || []).slice(-5);
            }
            for (const r of ratings) {
              const song = daySongs[r.index - 1];
              result.feedback.push({
                pushId: pushId || song?.pushId || '',
                date: date || song?.date || todayStr(),
                index: r.index,
                title: song?.title || `第${r.index}首`,
                artist: song?.artist || '',
                score: r.score,
                comment: r.comment || '',
              });
            }
            result.ids.push(messageId);
            console.log(`[feedback] 解析到 ${ratings.length} 条评分（${date || '未知日期'}）`);
          } catch (e) {
            console.warn('[feedback] 跳过一封邮件:', e.message);
          }
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  return result;
}

// ---------- B站 wbi 签名 ----------
const mixinKeyEncTab = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];
const getMixinKey = (orig) => mixinKeyEncTab.map((n) => orig[n]).join('').slice(0, 32);

const cookieJar = new Map();
async function biliFetch(url) {
  const headers = { 'User-Agent': UA, 'Referer': 'https://www.bilibili.com/' };
  const cookie = [...cookieJar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  if (cookie) headers['Cookie'] = cookie;
  const res = await fetch(url, { headers });
  const setCookies = res.headers.getSetCookie?.() || [];
  for (const c of setCookies) {
    const first = c.split(';')[0];
    const eq = first.indexOf('=');
    if (eq > 0) cookieJar.set(first.slice(0, eq).trim(), first.slice(eq + 1).trim());
  }
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

let wbiKeys = null;
async function getWbiKeys() {
  if (wbiKeys) return wbiKeys;
  const { json } = await biliFetch('https://api.bilibili.com/x/web-interface/nav');
  const img = json.data.wbi_img.img_url;
  const sub = json.data.wbi_img.sub_url;
  wbiKeys = {
    imgKey: img.slice(img.lastIndexOf('/') + 1).split('.')[0],
    subKey: sub.slice(sub.lastIndexOf('/') + 1).split('.')[0],
  };
  return wbiKeys;
}

function encWbi(params, imgKey, subKey) {
  const mixinKey = getMixinKey(imgKey + subKey);
  const withWts = { ...params, wts: Math.round(Date.now() / 1000) };
  const query = Object.keys(withWts).sort().map((key) => {
    const value = String(withWts[key]).replace(/[!'()*]/g, '');
    return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
  }).join('&');
  const w_rid = crypto.createHash('md5').update(query + mixinKey).digest('hex');
  return `${query}&w_rid=${w_rid}`;
}

async function biliSearch(keyword) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) { await sleep(1500 * attempt); wbiKeys = null; }
    try {
      const { imgKey, subKey } = await getWbiKeys();
      const query = encWbi({ keyword, search_type: 'video', page: 1 }, imgKey, subKey);
      const { status, json } = await biliFetch('https://api.bilibili.com/x/web-interface/search/type?' + query);
      if (status !== 200 || !json || json.code !== 0) throw new Error(`HTTP ${status} code ${json?.code} ${json?.message || ''}`);
      return (json.data?.result || []).map((r) => ({ bvid: r.bvid, title: stripHtml(r.title), author: r.author, play: r.play || 0 }));
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('bili search failed');
}

// ---------- 链接选择：官方优先，排除翻唱/剧情版/剪辑 ----------
const OFFICIAL_HINTS = ['官方', 'official', '音乐', 'music', 'hoyo-mix', 'hoyomix', '崩坏星穹铁道', '绝区零', '崩坏3', '原神', '米哈游', '凤凰传奇', '工作室'];
const BAD_HINTS = ['翻唱', 'cover', 'remix', '混剪', '剪辑', '高清修复', '录音棚', '剧情版', '饭拍', '现场', 'live', '伴奏'];

function artistPartsOf(song) {
  return String(song.artist || '').split(/[\/、,，&＋+\s]+/).map(norm).filter((p) => p.length >= 2);
}

// 歌名必须完整匹配，且不能是"单词中段"命中（避免 "Monody" 命中 "Monodyx"）
function titleStrictHit(songTitle, candTitle) {
  const st = String(songTitle || '').trim();
  if (!st) return false;
  const ct = String(candTitle || '');
  const idx = ct.toLowerCase().indexOf(st.toLowerCase());
  if (idx === -1) return false;
  const isWordChar = (c) => /[a-z0-9]/i.test(c);
  const before = idx > 0 ? ct[idx - 1] : '';
  const after = idx + st.length < ct.length ? ct[idx + st.length] : '';
  if (before && isWordChar(before) && isWordChar(st[0])) return false;
  if (after && isWordChar(after) && isWordChar(st[st.length - 1])) return false;
  return true;
}

// 歌名前面若多出一个"可疑英文单词"，判为不同曲目（如 "Sin Devil Trigger" ≠ "Devil Trigger"）
const DECO_WORDS = ['official', 'mv', 'audio', 'lyric', 'lyrics', 'hd', '4k', '8k', 'full', 'version', 'ver', 'op', 'ed', 'ost', 'feat', 'ft', 'by', 'from', 'music', 'song', 'video', 'the', 'feat', 'original'];
function hasExtraLatinPrefix(songTitle, candTitle, artistParts) {
  const st = String(songTitle || '').trim();
  const ct = String(candTitle || '');
  const idx = ct.toLowerCase().indexOf(st.toLowerCase());
  if (idx <= 0) return false;
  const m = ct.slice(0, idx).match(/([A-Za-z][A-Za-z0-9]*)[^A-Za-z0-9]*$/);
  if (!m) return false; // 前面是中文/括号等 → 不算冲突
  const word = m[1].toLowerCase();
  if (artistParts.includes(norm(word))) return false; // 是歌手名 → 允许
  if (DECO_WORDS.includes(word)) return false; // 是修饰词 → 允许
  return true; // 多出一个可疑英文单词 → 拒绝
}

function scoreSearchResult(song, r) {
  const rawTitle = String(r.title || '');
  const parts = artistPartsOf(song);
  if (!titleStrictHit(song.title, rawTitle)) return -1;
  if (hasExtraLatinPrefix(song.title, rawTitle, parts)) return -1;
  if (BAD_HINTS.some((h) => rawTitle.toLowerCase().includes(h))) return -1;
  const rawAuthor = String(r.author || '');
  const author = norm(rawAuthor);
  const nt = norm(rawTitle);
  const artistHit = parts.some((p) => author.includes(p) || nt.includes(p));
  const officialAuthor = OFFICIAL_HINTS.some((h) => rawAuthor.toLowerCase().includes(h));
  const plays = r.play || 0;
  // 采纳门槛：官方账号上传，或（演唱者对得上 且 播放量够高）——太低播放的转载不采纳
  if (!officialAuthor && !(artistHit && plays >= 500000)) return -1;
  let s = 10;
  if (officialAuthor) s += 10;
  if (artistHit) s += 5;
  s += Math.min(plays / 200000, 8);
  return s;
}

function fallbackLink(kw) {
  return { url: `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}`, label: '搜索页(未找到可靠原曲)', owner: '', views: 0 };
}

async function findLink(song) {
  const kw = sanitizeKeyword(`${song.title} ${song.artist}`);
  try {
    const results = await biliSearch(kw);
    let best = null;
    let bestScore = -1;
    for (const r of results.slice(0, 6)) {
      const sc = scoreSearchResult(song, r);
      if (sc > bestScore) { bestScore = sc; best = r; }
    }
    if (best && bestScore >= 10) {
      const rawAuthor = String(best.author || '');
      const official = OFFICIAL_HINTS.some((h) => rawAuthor.toLowerCase().includes(h));
      return { url: `https://www.bilibili.com/video/${best.bvid}/`, label: official ? '官方版' : '原曲', owner: best.author, views: best.play || 0 };
    }
    return fallbackLink(kw);
  } catch (e) {
    console.error('[link] 搜索失败，改用搜索页链接:', kw, e.message);
    return fallbackLink(kw);
  }
}

// ---------- DeepSeek 生成（依据你的评分筛选） ----------
const SYSTEM_PROMPT = `你是「每日推歌」助手。根据用户的种子音乐、口味基准，以及用户本人的历史评分，每天推荐 5 首歌。

【种子音乐与口味基准】
- 《野马尘埃 Floating Mist》阿兰/HOYO-MiX（原神）：空灵大气的华语游戏人声、史诗管弦
- 《挪德卡莱 Nod-Krai》AURORA/HOYO-MiX（原神）：北欧空灵女声、电影感编排
- 《Saving Grace》KIRBY（Spider-Noir 插曲）：影视 OST、灵魂感强嗓音、cinematic
- 《覆灭重生 Come Alive》Philip Strand/雷声（绝区零 OP）：摇滚/电子、爆发力燃系人声
- 《最炫民族风》凤凰传奇：华语民族风流行、欢快洗脑、气氛担当
口味基准：游戏/影视 OST 级制作、强辨识度人声（空灵女声或燃系摇滚嗓）、宏大或高能量编曲；另有一条「欢快华语流行」的快乐轴。更广偏好：华语流行、欧美流行/摇滚、HoYoMix 游戏音乐。
用户尤其看重歌曲背后的故事与叙事：他的高分大多给到"有厚实背景故事"的作品（游戏剧情曲、影视 OST 等）。选曲请优先有丰富叙事背景的曲目，并在推荐理由里如实点出该作品的故事背景（不得编造）。

【硬性规则】
1. 5 首中 4 首贴合口味基准，1 首为随机惊喜（风格迥异）；惊喜约每 4 天一次即可。
2. 悲壮抒情/催泪类 OST（如《Nightglow》）最多每周推荐 1 次；若「最近7天已推分类」里已有此类，本次不要选。
3. 不要重复「最近已推」里的歌；尽量选用户大概率没听过的新歌/新发行。
4. 不推种子本身，但可推同艺人/同系列其他作品。
5. 每首歌给出：语种与风格、与种子的关联（一句话）、推荐理由（一句话）、分类标签。
6. title 只填歌曲的正式名称：不要把歌手名写进歌名、不要用" - "拼接；artist 只填主要演唱者（多位用"/"连接，最多两位），不要填作曲/制作人。
7. 只推荐你确信真实存在、且"歌手—歌曲"对应正确的作品：不要把 A 的歌安在 B 名下，不要凭印象拼凑歌名或编造作品。凡是不确定的，就换一首你更有把握的（宁可选知名作品）。
8. 「与种子的关联」和「推荐理由」必须基于事实，不得牵强附会：若只是风格相近就如实说"风格相近"，不要编造背景或情绪；不确定的信息不要写。
9. 不要给歌曲打分，也不要写"听感"——评分与感受由用户本人提供。
10. 必须参考「用户历史评分」调整选曲：评分高（≥8分）的风格/歌手/类型多推；评分低（≤5分）的方向少推或避开；用户备注里的明确要求（如"最多每周一次"）必须遵守。

【输出格式】只输出 JSON，结构如下：
{"songs":[{"title":"歌名","artist":"歌手","languageStyle":"语种与风格","seedMatch":"与种子的关联","reason":"推荐理由","category":"分类标签(史诗/燃系摇滚/空灵女声/电子/欢快华语/悲壮抒情/其他)"}]}`;

function userPrompt(history, feedback) {
  const recent = (history.pushed || []).slice(-30).map((e) => `${e.date} ${e.title}-${e.artist}[${e.category}]`).join('；') || '（空）';
  const last7 = (history.pushed || []).filter((e) => daysAgo(e.date) <= 7).map((e) => e.category).join('、') || '（无）';
  const fb = (feedback || []).slice(-40).map((f) => `${f.date} 《${f.title}》${f.score}分${f.comment ? ' ' + f.comment : ''}`).join('；') || '（暂无，用户还没回复过评分）';
  return `今天是 ${todayStr()}（北京时间）。\n最近已推（勿重复）：${recent}\n最近7天已推分类：${last7}\n用户历史评分：${fb}\n请推荐 5 首歌，严格按 JSON 格式输出。`;
}

async function generateSongs(history, feedback) {
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt(history, feedback) },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.8,
      max_tokens: 4000,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`DeepSeek HTTP ${res.status}: ${t.slice(0, 500)}`);
  }
  const j = await res.json();
  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error('DeepSeek 返回为空: ' + JSON.stringify(j).slice(0, 500));
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('解析 LLM JSON 失败: ' + content.slice(0, 500));
  }
}

// ---------- 邮件 ----------
function buildHtml(songs, label) {
  const rows = songs.map((s, i) => `
    <div style="margin-bottom:18px;border-left:4px solid #e50914;padding-left:12px;">
      <div style="font-size:16px;font-weight:bold;">${i + 1} 《${escapeHtml(s.title)}》— ${escapeHtml(s.artist)}</div>
      <div style="color:#555;margin-top:4px;">${escapeHtml(s.languageStyle)}｜${escapeHtml(s.seedMatch)}</div>
      <div style="color:#333;margin-top:4px;">推荐理由：${escapeHtml(s.reason)}</div>
      <div style="margin-top:4px;">在线试听：<a href="${escapeHtml(s.link.url)}">${escapeHtml(s.link.url)}</a>（${escapeHtml(s.link.label)}${s.link.views ? '，播放 ' + fmtViews(s.link.views) : ''}）</div>
    </div>`).join('');
  return `<!DOCTYPE html><html><body style="font-family:'Microsoft YaHei',sans-serif;max-width:640px;margin:auto;padding:16px;">
    <h2 style="color:#e50914;">🎵 今日推歌（${label}）</h2>${rows}
    <hr>
    <p style="font-size:15px;color:#333;"><b>📝 回复本邮件即可打分</b>，格式：序号 分数 一句感受，例如：</p>
    <pre style="background:#f5f5f5;padding:10px;border-radius:6px;font-size:14px;">1 9 太燃了
2 8 很喜欢
3 6 一般</pre>
    <p style="color:#888;font-size:13px;">你的评分会作为参考样本，用于调整之后的推荐。</p>
  </body></html>`;
}

async function sendEmail(songs, label) {
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  await transporter.sendMail({
    from: `"每日推歌" <${process.env.SMTP_USER}>`,
    to: process.env.MAIL_TO,
    subject: `🎵 今日推歌 ${label}（5 首）`,
    html: buildHtml(songs, label),
  });
  console.log('邮件已发送到', process.env.MAIL_TO);
}

// ---------- 主流程 ----------
async function main() {
  const required = ['DEEPSEEK_API_KEY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'MAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('缺少环境变量:', missing.join(', '));
    process.exit(1);
  }

  const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const fb = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf8')) : { feedback: [], processedIds: [] };
  fb.feedback = fb.feedback || [];
  fb.processedIds = fb.processedIds || [];

  // 1) 读取你回信里的评分（失败不影响本次推送）
  try {
    const replies = await fetchFeedbackReplies(history, fb.processedIds);
    if (replies.feedback.length) {
      fb.feedback.push(...replies.feedback);
      fb.processedIds.push(...replies.ids);
      fb.processedIds = fb.processedIds.slice(-300);
      console.log(`本次新增 ${replies.feedback.length} 条评分样本`);
    } else {
      console.log('没有新的评分回信');
    }
  } catch (e) {
    console.warn('读取邮件回复失败（不影响本次推送）:', e.message);
  }

  // 2) 生成推荐（带上你的历史评分）
  const data = await generateSongs(history, fb.feedback);
  const songs = data.songs;
  if (!Array.isArray(songs) || songs.length === 0) throw new Error('LLM 未返回有效歌单');

  for (const s of songs) {
    await sleep(1200);
    s.link = await findLink(s);
    console.log(`[link] ${s.title} -> ${s.link.url} (${s.link.label})`);
  }

  const date = todayStr();
  const pushId = nowStamp(); // 轮次编号（日期+时分）
  await sendEmail(songs, pushId);

  // 3) 落库：已推歌单 + 评分样本
  for (const s of songs) {
    history.pushed.push({ pushId, date, title: s.title, artist: s.artist, category: s.category || '其他' });
  }
  history.pushed = history.pushed.filter((e) => daysAgo(e.date) <= 30);
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2) + '\n');
  fs.writeFileSync(FEEDBACK_FILE, JSON.stringify(fb, null, 2) + '\n');
  console.log('完成：', songs.map((s) => s.title).join(' / '));
}

main().catch((e) => {
  console.error('运行失败:', e.message);
  process.exit(1);
});
