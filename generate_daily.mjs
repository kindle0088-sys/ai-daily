#!/usr/bin/env node
/**
 * AI HOT 每日晨报生成器
 * 
 * 工作流：
 * 1. 调用 AI HOT /api/public/daily 拉取今天日报
 * 2. 若当天未生成或无内容则自动回退前一天
 * 3. 生成单文件 HTML，保存为 YYYY-MM-DD.html 并更新 index.html
 * 4. 提交并推送至 GitHub Pages 仓库
 */

const API_BASE = 'https://aihot.virxact.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const REPO_DIR = process.cwd();

// ============= Helpers =============
async function fetchJSON(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!resp.ok) return null;
  return resp.json();
}

function safeDate(d) {
  if (!d) return '';
  return d.slice(0, 10);
}

function truncate(text, max = 60) {
  if (!text) return '';
  // Remove extra whitespace
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  return clean.slice(0, max) + '…';
}

// ============= Data Fetching =============
function countItems(d) {
  if (!d || !d.sections) return 0;
  return d.sections.reduce((s, sec) => s + (sec.items || []).length, 0);
}

async function fetchDaily() {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);

  // Try today's daily first
  let daily = await fetchJSON(`${API_BASE}/api/public/daily`);
  let dateStr = todayStr;
  let merged = false;
  let fallbackNote = '';

  const isEmpty = !daily || !daily.sections || daily.sections.length === 0 ||
    daily.sections.every(s => !s.items || s.items.length === 0);

  if (isEmpty) {
    // Try yesterday
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    daily = await fetchJSON(`${API_BASE}/api/public/daily/${yStr}`);
    dateStr = yStr;
    fallbackNote = `今日(${todayStr})日报未生成，展示 ${yStr} 日报`;
  } else if (countItems(daily) < 3) {
    // Today has very few items (e.g. weekend) — merge with yesterday
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toISOString().slice(0, 10);
    const yDaily = await fetchJSON(`${API_BASE}/api/public/daily/${yStr}`);
    if (yDaily && yDaily.sections && countItems(yDaily) > 0) {
      // Merge: today's items go first in each section, then yesterday's
      const mergedSections = [];
      const labelOrder = ['模型发布/更新', '产品发布/更新', '行业动态', '论文研究', '技巧与观点'];
      for (const label of labelOrder) {
        const todayItems = (daily.sections.find(s => s.label === label) || {}).items || [];
        const yItems = (yDaily.sections.find(s => s.label === label) || {}).items || [];
        const merged_ = [...todayItems, ...yItems];
        if (merged_.length > 0) {
          mergedSections.push({ label, items: merged_ });
        }
      }
      daily.sections = mergedSections;
      merged = true;
      fallbackNote = `今日(${todayStr})日报仅${countItems(daily)}条，合并昨日(${yStr})完整日报`;
    }
  }

  // If still no data, try day before yesterday
  if (!daily || !daily.sections || daily.sections.length === 0 ||
      daily.sections.every(s => !s.items || s.items.length === 0)) {
    const twoDaysAgo = new Date(today);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const tStr = twoDaysAgo.toISOString().slice(0, 10);
    daily = await fetchJSON(`${API_BASE}/api/public/daily/${tStr}`);
    if (daily && daily.sections) {
      dateStr = tStr;
      fallbackNote = `最近三日均无完整日报，展示 ${tStr} 数据`;
    }
  }

  if (!daily || !daily.sections) {
    throw new Error('No daily data available after fallback');
  }

  return { daily, dateStr, fallbackNote, merged };
}

// ============= Movie Recommendation =============
function movieCardHTML(movie, dateStr) {
  if (!movie) return '';
  const c = { color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' };
  const guide = movie.audience || '';
  const genre = Array.isArray(movie.genre) ? movie.genre.join(' / ') : (movie.genre || '');
  const meta = [movie.year, movie.director, movie.rating, movie.runtime, genre].filter(Boolean).join(' · ');
  return `
  <section class="section" id="sec-movie">
    <div class="section-header" style="border-bottom-color:${c.color};">
      <h2>今日电影推荐</h2>
      <span class="section-count">影史经典</span>
    </div>
    <div class="card" style="border-top:3px solid ${c.color};">
      <div class="card-header">
        <div class="card-title">《${movie.title}》 (${movie.year || ''})</div>
      </div>
      <div class="card-meta">
        <span class="source-chip" style="background:${c.bg}; color:${c.color}">${meta}</span>
      </div>
      <p class="card-summary">${movie.synopsis || ''}</p>
      <a class="card-link" href="movie-${dateStr}.html" style="color:${c.color}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
        查看完整推荐 →
      </a>
      ${guide ? `<p class="card-summary" style="margin-top:6px;color:#7c3aed;font-weight:500">${guide}</p>` : ''}
    </div>
  </section>`;
}

function generateMoviePage(movie, dateStr) {
  const c = { color: '#7c3aed', bg: '#f5f3ff', border: '#ddd6fe' };
  const genre = Array.isArray(movie.genre) ? movie.genre.join(' / ') : (movie.genre || '');
  const highlights = Array.isArray(movie.highlights) ? movie.highlights : [];
  const metaRows = [
    ['年份', movie.year], ['导演', movie.director], ['评分', movie.rating],
    ['片长', movie.runtime], ['类型', genre],
  ].filter(r => r[1]);

  const metaHTML = metaRows.map(([k, v]) => `
      <div class="m-meta">
        <span class="m-meta-label">${k}</span>
        <span class="m-meta-value">${v}</span>
      </div>`).join('');

  const hlHTML = highlights.map(h => `<li>${h}</li>`).join('');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>今日电影推荐 · ${movie.title} (${movie.year || ''})</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;font-size:16px}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6fa;color:#2d3436;line-height:1.6;min-height:100vh}
.hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);color:#fff;padding:56px 24px 44px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(ellipse at 40% 40%,rgba(124,58,237,0.2) 0%,transparent 50%),radial-gradient(ellipse at 70% 30%,rgba(99,102,241,0.15) 0%,transparent 50%);pointer-events:none}
.hero-content{position:relative;z-index:1;max-width:800px;margin:0 auto}
.hero-badge{display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:20px;padding:4px 16px;font-size:0.8rem;letter-spacing:0.05em;color:#c4b5fd;margin-bottom:18px;backdrop-filter:blur(10px)}
.hero h1{font-size:2.2rem;font-weight:700;margin-bottom:10px;letter-spacing:-0.02em}
.hero-year{font-size:1rem;color:#94a3b8;margin-bottom:14px}
.hero-meta{display:flex;justify-content:center;gap:12px;flex-wrap:wrap}
.hero-chip{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:20px;padding:5px 16px;font-size:0.8rem;color:#e2e8f0}
.back-link{position:absolute;top:20px;left:20px;z-index:2;color:#94a3b8;text-decoration:none;font-size:0.85rem;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);padding:6px 14px;border-radius:20px;transition:all 0.2s}
.back-link:hover{color:#fff;border-color:#c4b5fd}
.main{max-width:800px;margin:0 auto;padding:36px 20px 56px}
.section{background:#fff;border-radius:14px;padding:28px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border:1px solid #f1f5f9;margin-bottom:20px}
.section h3{font-size:0.95rem;font-weight:700;color:${c.color};margin-bottom:14px;display:flex;align-items:center;gap:8px}
.section h3::before{content:'';width:6px;height:6px;border-radius:50%;background:${c.color};display:inline-block}
.meta-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:12px;margin-bottom:20px}
.m-meta{background:${c.bg};border-radius:10px;padding:12px 16px}
.m-meta-label{display:block;font-size:0.7rem;color:#94a3b8;margin-bottom:4px}
.m-meta-value{font-size:0.92rem;font-weight:600;color:#1e293b}
.synopsis p{font-size:0.95rem;color:#475569;line-height:1.8}
.hl-list{list-style:none;padding:0}
.hl-list li{position:relative;padding:8px 0 8px 22px;font-size:0.92rem;color:#475569;line-height:1.6}
.hl-list li::before{content:'';position:absolute;left:4px;top:15px;width:8px;height:8px;border-radius:50%;background:${c.color};opacity:0.6}
.why-box{background:linear-gradient(135deg,#f5f3ff 0%,#eef2ff 100%);border-radius:12px;padding:18px 22px;font-size:0.95rem;color:#334155;line-height:1.8}
.audience-box{background:#f8fafc;border:1px dashed #e2e8f0;border-radius:12px;padding:16px 20px;font-size:0.92rem;color:#475569;line-height:1.7}
.audience-box strong{color:${c.color}}
.footer{text-align:center;padding:32px 16px;color:#94a3b8;font-size:0.8rem;border-top:1px solid #e2e8f0;margin-top:16px}
@media(max-width:768px){
  .hero{padding:44px 16px 36px}
  .hero h1{font-size:1.6rem}
  .main{padding:24px 14px 40px}
  .section{padding:20px}
}
</style>
</head>
<body>
<a class="back-link" href="index.html">← 返回首页</a>
<header class="hero">
  <div class="hero-content">
    <div class="hero-badge">AI HOT 每日晨报 · 今日电影推荐</div>
    <h1>《${movie.title}》</h1>
    <div class="hero-year">${movie.year || ''} · ${movie.director || ''}</div>
    <div class="hero-meta">
      ${movie.rating ? `<span class="hero-chip">⭐ ${movie.rating}</span>` : ''}
      ${movie.runtime ? `<span class="hero-chip">⏱ ${movie.runtime}</span>` : ''}
      ${genre ? `<span class="hero-chip">${genre}</span>` : ''}
    </div>
  </div>
</header>
<main class="main">
  <div class="section">
    <h3>剧情梗概</h3>
    <div class="synopsis"><p>${movie.synopsis || ''}</p></div>
  </div>
  ${hlHTML ? `<div class="section"><h3>亮点所在</h3><ul class="hl-list">${hlHTML}</ul></div>` : ''}
  ${movie.why ? `<div class="section"><h3>为什么值得一看</h3><div class="why-box">${movie.why}</div></div>` : ''}
  ${movie.audience ? `<div class="section"><h3>观影建议</h3><div class="audience-box">${movie.audience}</div></div>` : ''}
</main>
<footer class="footer">
  <p>今日电影推荐 · 数据来源：AI 精选 · 页面生成于 ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}</p>
</footer>
</body>
</html>`;
}

// ============= HTML Generation =============
function generateHTML(data, fallbackNote, showDateNav = false, availableDates = [], movie = null) {
  const { daily, dateStr } = data;
  const sections = daily.sections || [];
  const sectionLabels = ['模型发布/更新', '产品发布/更新', '行业动态', '论文研究', '技巧与观点'];

  // Build section map
  const sectionMap = {};
  for (const s of sections) {
    sectionMap[s.label] = (s.items || []).map(item => ({
      title: item.title || '',
      summary: truncate(item.summary || ''),
      sourceUrl: item.sourceUrl || '',
      sourceName: item.sourceName || '',
      is_today: false,
    }));
  }

  // Build ordered items with global numbering
  let globalNum = 1;
  const sectionOutput = [];

  for (const label of sectionLabels) {
    const items = sectionMap[label] || [];
    const outItems = items.map(item => ({
      num: globalNum++,
      ...item,
    }));
    if (outItems.length > 0) {
      sectionOutput.push({ label, count: outItems.length, items: outItems });
    }
  }

  const total = globalNum - 1;

  // Color maps
  const sectionColors = {
    '模型发布/更新': { color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe' },
    '产品发布/更新': { color: '#0ea5e9', bg: '#ecfeff', border: '#a5f3fc' },
    '行业动态':     { color: '#f59e0b', bg: '#fef3c7', border: '#fde68a' },
    '论文研究':     { color: '#10b981', bg: '#d1fae5', border: '#a7f3d0' },
    '技巧与观点':   { color: '#ec4899', bg: '#fdf2f8', border: '#fbcfe8' },
  };

  // Stats HTML
  let statsHTML = '';
  for (const so of sectionOutput) {
    const c = sectionColors[so.label] || { color: '#6366f1' };
    statsHTML += `
      <div class="hero-stat">
        <div class="stat-num" style="color:${c.color}">${so.count}</div>
        <div class="stat-label">${so.label}</div>
      </div>`;
  }

  // Section anchor IDs
  const sectionIds = {
    '模型发布/更新': 'sec-models',
    '产品发布/更新': 'sec-products',
    '行业动态': 'sec-industry',
    '论文研究': 'sec-paper',
    '技巧与观点': 'sec-tip',
  };

  // Nav HTML — section anchors (for date pages: also include date nav)
  let navHTML = '';
  for (const so of sectionOutput) {
    const sid = sectionIds[so.label] || '';
    navHTML += `<a href="#${sid}" class="nav-item">${so.label}</a>`;
  }

  // Date archive dropdown (only on index page)
  let dropdownHTML = '';
  if (showDateNav && availableDates.length > 0) {
    const dateObj = new Date(dateStr + 'T00:00:00+08:00');
    const currentLabel = `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;
    let optionsHTML = '';
    for (const d of availableDates) {
      const dd = new Date(d + 'T00:00:00+08:00');
      const label = `${dd.getFullYear()}年${dd.getMonth() + 1}月${dd.getDate()}日${d === dateStr ? ' (当前)' : ''}`;
      const selected = d === dateStr ? ' selected' : '';
      optionsHTML += `<option value="${d}.html"${selected}>${label}</option>`;
    }
    dropdownHTML = `
    <div class="nav-date-select">
      <select id="dateSelector" aria-label="选择日期">
        ${optionsHTML}
      </select>
    </div>`;
  }

  // Cards HTML
  let cardsHTML = '';
  for (const so of sectionOutput) {
    const c = sectionColors[so.label] || { color: '#6366f1', bg: '#eef2ff', border: '#c7d2fe' };
    let sectionCards = '';
    for (const item of so.items) {
      const numStr = String(item.num).padStart(2, '0');
      const todayBadge = item.is_today ? '<span class="today-badge">今日</span>' : '';
      sectionCards += `
      <div class="card" style="border-top: 3px solid ${c.color};">
        <div class="card-num" style="color:${c.border}">${numStr}</div>
        <div class="card-header">
          <div class="card-title">${item.title}</div>
        </div>
        <div class="card-meta">
          <span class="source-chip" style="background:${c.bg}; color:${c.color}">${item.sourceName}</span>
          ${todayBadge}
        </div>
        <p class="card-summary">${item.summary}</p>
        <a class="card-link" href="${item.sourceUrl}" target="_blank" rel="noopener noreferrer" style="color:${c.color}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
          阅读原文
        </a>
      </div>`;
    }

    const sid = sectionIds[so.label] || '';
    cardsHTML += `
  <section class="section" id="${sid}">
    <div class="section-header" style="border-bottom-color:${c.color};">
      <h2>${so.label}</h2>
      <span class="section-count">${so.count} 条</span>
    </div>
    <div class="card-grid">
${sectionCards}
    </div>
  </section>`;
  }

  // Movie recommendation — appended after the last section (技巧与观点)
  if (movie && dateStr) {
    cardsHTML += movieCardHTML(movie, dateStr);
  }

  // Date display
  const dateObj = new Date(dateStr + 'T00:00:00+08:00');
  const dateDisplay = `${dateObj.getFullYear()}年${dateObj.getMonth() + 1}月${dateObj.getDate()}日`;

  const noteHTML = fallbackNote
    ? `<div class="hero-note">${fallbackNote}</div>`
    : '';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AI HOT 日报 · ${dateDisplay}</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
html{scroll-behavior:smooth;font-size:16px}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:#f5f6fa;color:#2d3436;line-height:1.6;min-height:100vh}

.hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);color:#fff;padding:48px 24px 40px;text-align:center;position:relative;overflow:hidden}
.hero::before{content:'';position:absolute;top:-50%;left:-50%;width:200%;height:200%;background:radial-gradient(ellipse at 30% 50%,rgba(99,102,241,0.15) 0%,transparent 50%),radial-gradient(ellipse at 70% 30%,rgba(14,165,233,0.1) 0%,transparent 50%);pointer-events:none}
.hero-content{position:relative;z-index:1;max-width:900px;margin:0 auto}
.hero-badge{display:inline-block;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);border-radius:20px;padding:4px 16px;font-size:0.8rem;letter-spacing:0.05em;color:#a5b4fc;margin-bottom:16px;backdrop-filter:blur(10px)}
.hero h1{font-size:2rem;font-weight:700;margin-bottom:8px;letter-spacing:-0.02em}
.hero-date{font-size:1rem;color:#94a3b8;margin-bottom:6px}
.hero-note{font-size:0.8rem;color:#f59e0b;margin-bottom:20px;padding:6px 16px;background:rgba(245,158,11,0.1);border-radius:12px;display:inline-block}
.hero-total{font-size:3.5rem;font-weight:800;color:#6366f1;line-height:1;margin-bottom:20px}
.hero-total small{font-size:1rem;font-weight:400;color:#94a3b8}
.hero-stats{display:flex;justify-content:center;gap:16px;flex-wrap:wrap}
.hero-stat{background:rgba(255,255,255,0.08);border-radius:12px;padding:12px 20px;min-width:120px;backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.1)}
.hero-stat .stat-num{font-size:1.5rem;font-weight:700}
.hero-stat .stat-label{font-size:0.7rem;color:#94a3b8;margin-top:2px}

.nav-bar{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid #e2e8f0;box-shadow:0 1px 3px rgba(0,0,0,0.04)}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;gap:0;padding:0 16px;overflow-x:auto;-webkit-overflow-scrolling:touch}
.nav-inner::-webkit-scrollbar{height:0}
.nav-item{flex-shrink:0;padding:14px 20px;font-size:0.85rem;font-weight:500;color:#64748b;text-decoration:none;border-bottom:2px solid transparent;transition:all 0.2s;white-space:nowrap}
.nav-item:hover{color:#6366f1}
.nav-date-select{margin-left:auto;flex-shrink:0;padding:8px 0 8px 12px;border-left:1px solid #e2e8f0}
.nav-date-select select{appearance:none;-webkit-appearance:none;background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:6px 28px 6px 12px;font-size:0.8rem;color:#334155;cursor:pointer;font-family:inherit;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394a3b8' stroke-width='2'%3E%3Cpolyline points='6 9 12 15 18 9'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:right 8px center;min-width:130px}
.nav-date-select select:hover{border-color:#c7d2fe}
.nav-date-select select:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 2px rgba(99,102,241,0.15)}

.main{max-width:1200px;margin:0 auto;padding:32px 16px 48px}
.section{margin-bottom:40px}
.section-header{display:flex;align-items:baseline;gap:12px;margin-bottom:20px;padding-bottom:12px;border-bottom:2px solid #e2e8f0}
.section-header h2{font-size:1.25rem;font-weight:700;color:#1e293b}
.section-header .section-count{font-size:0.8rem;color:#94a3b8;font-weight:400}
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,0.05);border:1px solid #f1f5f9;transition:box-shadow 0.2s,transform 0.15s;position:relative;overflow:hidden}
.card:hover{box-shadow:0 4px 16px rgba(0,0,0,0.08);transform:translateY(-1px)}
.card-num{position:absolute;top:12px;right:16px;font-size:2.5rem;font-weight:800;line-height:1;pointer-events:none}
.card-header{display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:10px;padding-right:36px}
.card-title{font-size:0.95rem;font-weight:600;color:#1e293b;line-height:1.45}
.card-meta{display:flex;align-items:center;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.source-chip{display:inline-block;font-size:0.7rem;padding:3px 10px;border-radius:10px;font-weight:500;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.today-badge{display:inline-block;font-size:0.65rem;padding:2px 8px;background:#fef3c7;color:#d97706;border-radius:8px;font-weight:600}
.card-summary{font-size:0.8rem;color:#64748b;line-height:1.55;margin-bottom:12px}
.card-link{display:inline-flex;align-items:center;gap:4px;font-size:0.8rem;text-decoration:none;font-weight:500;transition:color 0.15s}
.card-link:hover{opacity:0.8}
.card-link svg{width:14px;height:14px}
.footer{text-align:center;padding:32px 16px;color:#94a3b8;font-size:0.8rem;border-top:1px solid #e2e8f0;margin-top:16px}
.footer strong{color:#6366f1}
.back-top{position:fixed;bottom:32px;right:32px;width:44px;height:44px;background:#6366f1;color:#fff;border:none;border-radius:50%;cursor:pointer;font-size:1.2rem;box-shadow:0 4px 12px rgba(99,102,241,0.35);opacity:0;transform:translateY(20px);transition:opacity 0.3s,transform 0.3s;pointer-events:none;display:flex;align-items:center;justify-content:center}
.back-top.visible{opacity:1;transform:translateY(0);pointer-events:auto}

@media(max-width:768px){
  .hero{padding:36px 16px 32px}
  .hero h1{font-size:1.5rem}
  .hero-total{font-size:2.5rem}
  .hero-stats{gap:8px}
  .hero-stat{min-width:90px;padding:10px 14px}
  .hero-stat .stat-num{font-size:1.2rem}
  .card-grid{grid-template-columns:1fr}
  .nav-item{padding:12px 14px;font-size:0.8rem}
  .nav-date-select select{min-width:120px;font-size:0.75rem;padding:5px 26px 5px 10px}
  .back-top{bottom:20px;right:20px}
}
</style>
</head>
<body>

<header class="hero">
  <div class="hero-content">
    <div class="hero-badge">AI HOT 每日晨报</div>
    <h1>AI 日报</h1>
    <div class="hero-date">${dateDisplay}</div>
    ${noteHTML}
    <div class="hero-total">${total} <small>条</small></div>
    <div class="hero-stats">${statsHTML}</div>
  </div>
</header>

<nav class="nav-bar">
  <div class="nav-inner">${navHTML}${dropdownHTML}</div>
</nav>

<main class="main">
${cardsHTML}
</main>

<footer class="footer">
  <p>共 <strong>${total}</strong> 条 AI 动态 · 数据来源：<strong>AI HOT</strong>（aihot.virxact.com）· 自动生成于 ${new Date().toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'})}</p>
</footer>

<button class="back-top" id="backTop" title="回到顶部">↑</button>

<script>
const sections=document.querySelectorAll('.section');
const navItems=document.querySelectorAll('.nav-item');
const obs=new IntersectionObserver((entries)=>{entries.forEach(e=>{if(e.isIntersecting){navItems.forEach(n=>n.classList.remove('active'));document.querySelector('.nav-item[href="#'+e.target.id+'"]')?.classList.add('active')}})},{rootMargin:'-80px 0px -60% 0px'});
sections.forEach(s=>obs.observe(s));
const bt=document.getElementById('backTop');
window.addEventListener('scroll',()=>bt.classList.toggle('visible',window.scrollY>400));
bt.addEventListener('click',()=>window.scrollTo({top:0,behavior:'smooth'}));
const ds=document.getElementById('dateSelector');
if(ds)ds.addEventListener('change',function(){window.location.href=this.value});
</script>
</body>
</html>`;
}

// ============= Main =============
async function main() {
  console.log(`[${new Date().toISOString()}] Starting AI daily report generation...`);

  // Fetch data
  const data = await fetchDaily();
  const { dateStr, fallbackNote } = data;

  // Count total items
  const totalItems = (data.daily.sections || []).reduce((sum, s) => sum + (s.items || []).length, 0);
  console.log(`Date: ${dateStr}, Sections: ${(data.daily.sections || []).length}, Total items: ${totalItems}`);

  // Scan available dates for archive dropdown
  const fs = await import('fs');
  const path = await import('path');
  const allFiles = fs.readdirSync(REPO_DIR);
  const availableDates = allFiles
    .filter(f => /^\d{4}-\d{2}-\d{2}\.html$/.test(f))
    .map(f => f.replace('.html', ''))
    .sort((a, b) => b.localeCompare(a)); // descending

  // Load today's movie recommendation (movie/YYYY-MM-DD.json), if present
  const movieDir = path.join(REPO_DIR, 'movie');
  let movie = null;
  try {
    const movieFile = path.join(movieDir, `${dateStr}.json`);
    if (fs.existsSync(movieFile)) {
      movie = JSON.parse(fs.readFileSync(movieFile, 'utf-8'));
      console.log(`Movie: ${movie.title} (${movie.year || '未知年份'})`);
    } else {
      console.log('Movie: 无今日电影数据，跳过');
    }
  } catch (e) {
    console.warn(`Movie: 读取失败，跳过（${e.message}）`);
  }

  // Generate HTML — date page (no dropdown) and index page (with dropdown)
  const htmlDate = generateHTML(data, fallbackNote, false, availableDates, movie);
  const htmlIndex = generateHTML(data, fallbackNote, true, availableDates, movie);

  // Write files
  const dateFile = path.join(REPO_DIR, `${dateStr}.html`);
  const idxFile = path.join(REPO_DIR, 'index.html');

  fs.writeFileSync(dateFile, htmlDate, 'utf-8');
  console.log(`Written: ${dateFile}`);

  fs.writeFileSync(idxFile, htmlIndex, 'utf-8');
  console.log(`Written: ${idxFile}`);

  // Movie independent page
  if (movie) {
    const moviePage = path.join(REPO_DIR, `movie-${dateStr}.html`);
    fs.writeFileSync(moviePage, generateMoviePage(movie, dateStr), 'utf-8');
    console.log(`Written: ${moviePage}`);
  }

  // Git commit & push
  const { execSync } = await import('child_process');
  execSync('git add *.html movie/', { cwd: REPO_DIR });
  execSync(`git commit -m "chore: AI daily report for ${dateStr}"`, { cwd: REPO_DIR });
  execSync('git push origin main', { cwd: REPO_DIR });

  console.log('Pushed to GitHub Pages successfully.');
  console.log(`URL: https://kindle0088-sys.github.io/ai-daily/`);
}

main().catch(err => {
  console.error('Failed:', err.message);
  process.exit(1);
});
