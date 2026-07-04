/* ============ iOS 26 Liquid Glass · 天气（Open-Meteo 真实数据） ============ */

const $  = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const rand = (a, b) => a + Math.random() * (b - a);
const pad  = n => String(n).padStart(2, '0');
const esc  = s => String(s).replace(/[&<>"']/g, m =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ---------- 本地存储 ---------- */

const store = {
  load(k, fb) { try { return JSON.parse(localStorage.getItem(k)) ?? fb; } catch { return fb; } },
  save(k, v)  { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
};

const DEFAULT_CITIES = [
  { id: '18.253,109.512', name: '三亚',   lat: 18.2528, lon: 109.5119 },
  { id: '49.215,119.707', name: '呼伦贝尔', lat: 49.2153, lon: 119.7069 },
  { id: '23.129,113.264', name: '广州',   lat: 23.1291, lon: 113.2644 },
  { id: '45.804,126.535', name: '哈尔滨', lat: 45.8038, lon: 126.5350 }
];

const state = {
  cities: store.load('lgw-cities', null) || DEFAULT_CITIES.map(c => ({ ...c })),
  unit:   store.load('lgw-unit', 'c'),
  activeId: store.load('lgw-active', null),
  updatedAt: null
};
if (!state.cities.find(c => c.id === state.activeId)) state.activeId = state.cities[0]?.id || null;

const dataMap  = new Map();   // id -> { wx, air, error }
const animated = new Set();   // 已播放过数字滚动的城市

/* ---------- 天气码 → 文案 / 图标 / 场景主题 ---------- */

const WMO = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '毛毛雨', 53: '小雨', 55: '细雨', 56: '冻雨', 57: '冻雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '霰',
  80: '阵雨', 81: '强阵雨', 82: '暴雨',
  85: '阵雪', 86: '暴雪',
  95: '雷阵雨', 96: '雷雨伴冰雹', 99: '强雷暴'
};

const STORM_CODES = [95, 96, 99];
const SNOW_CODES  = [71, 73, 75, 77, 85, 86];
const RAIN_CODES  = [51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82];
const FOG_CODES   = [45, 48];

function iconOf(code, isDay = 1) {
  if (STORM_CODES.includes(code)) return '⛈️';
  if (SNOW_CODES.includes(code))  return '🌨️';
  if ([61, 63, 65, 80, 81, 82].includes(code)) return '🌧️';
  if (RAIN_CODES.includes(code))  return '🌦️';
  if (FOG_CODES.includes(code))   return '🌫️';
  if (code === 3) return '☁️';
  if (code === 2) return isDay ? '⛅' : '☁️';
  if (code <= 1)  return isDay ? '☀️' : '🌙';
  return '🌡️';
}

function themeOf(code, isDay, gustKmh) {
  if (STORM_CODES.includes(code)) return 'storm';
  if (SNOW_CODES.includes(code))  return 'snow';
  if (RAIN_CODES.includes(code))  return 'rain';
  if (FOG_CODES.includes(code))   return 'fog';
  const base = code >= 2 ? 'cloudy' : (isDay ? 'sunny' : 'night');
  if (base !== 'night' && beaufort(gustKmh || 0) >= 7) return 'wind';
  return base;
}

/* ---------- 单位与换算 ---------- */

const cvt = c => state.unit === 'c' ? c : c * 9 / 5 + 32;
const deg = c => c == null ? '--°' : Math.round(cvt(c)) + '°';

const BFT_KMH = [1, 6, 12, 20, 29, 39, 50, 62, 75, 89, 103, 118];
function beaufort(kmh) {
  for (let i = 0; i < BFT_KMH.length; i++) if (kmh < BFT_KMH[i]) return i;
  return 12;
}

const DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];
const windDir = d => DIRS[Math.round(((d % 360) + 360) % 360 / 45) % 8] + '风';

const uvText = uv =>
  uv < 3 ? '弱' : uv < 6 ? '中等' : uv < 8 ? '强' : uv < 11 ? '很强' : '极强';

const aqiText = aqi =>
  aqi <= 50 ? '优' : aqi <= 100 ? '良' : aqi <= 150 ? '轻度污染'
  : aqi <= 200 ? '中度污染' : aqi <= 300 ? '重度污染' : '严重污染';

const fmtVis = m =>
  m == null ? '—' : m >= 10000 ? Math.round(m / 1000) + ' km' : (m / 1000).toFixed(1) + ' km';

/* ---------- 数据获取（Open-Meteo，免费无密钥） ---------- */

async function fetchCity(city) {
  const wxUrl = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${city.lat}&longitude=${city.lon}`
    + '&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,weather_code,'
    + 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,surface_pressure,precipitation'
    + '&hourly=temperature_2m,weather_code,precipitation_probability,visibility,is_day'
    + '&daily=weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,'
    + 'uv_index_max,precipitation_probability_max'
    + '&timezone=auto&forecast_days=7';
  const airUrl = 'https://air-quality-api.open-meteo.com/v1/air-quality'
    + `?latitude=${city.lat}&longitude=${city.lon}&current=pm2_5,us_aqi&timezone=auto`;

  const [wx, air] = await Promise.all([
    fetch(wxUrl).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    fetch(airUrl).then(r => r.ok ? r.json() : null).catch(() => null)
  ]);
  return { wx, air };
}

async function refreshCity(city) {
  try {
    dataMap.set(city.id, { ...(await fetchCity(city)), error: null });
  } catch {
    dataMap.set(city.id, { ...(dataMap.get(city.id) || {}), error: true });
  }
}

async function refreshAll() {
  const btn = $('#btn-refresh');
  btn.classList.add('spinning');
  await Promise.all(state.cities.map(refreshCity));
  state.updatedAt = new Date();
  btn.classList.remove('spinning');
  render();
}

async function retryCity(id) {
  const city = state.cities.find(c => c.id === id);
  if (!city) return;
  dataMap.delete(id);
  render();
  await refreshCity(city);
  state.updatedAt = new Date();
  render();
}

const hourIndex = wx => {
  const key = wx.current.time.slice(0, 13);
  const i = wx.hourly.time.findIndex(t => t.slice(0, 13) === key);
  return i < 0 ? 0 : i;
};

/* ---------- 顶栏时钟 ---------- */

function tick() {
  const d = new Date();
  $('#clock').textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#date').textContent = `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}
tick();
setInterval(tick, 1000);

/* ---------- 场景 DOM ---------- */

const WIND_SVG = `<svg class="wind-svg" viewBox="0 0 240 140" fill="none" aria-hidden="true">
  <path class="gust g1" pathLength="1" d="M16 46 H126 c20 0 28 -24 9 -32 c-13 -5 -25 4 -24 15"/>
  <path class="gust g2" pathLength="1" d="M16 80 H176 c24 0 32 28 11 36 c-14 5 -27 -4 -25 -16"/>
  <path class="gust g3" pathLength="1" d="M34 112 H122 c16 0 22 -18 7 -25 c-10 -4 -19 2 -19 11"/>
</svg>`;

function sceneHTML(theme) {
  switch (theme) {
    case 'sunny':  return `<div class="sun"><div class="sun-rays"></div><div class="sun-halo"></div><div class="sun-core"></div></div>
                           <div class="flare f1"></div><div class="flare f2"></div>`;
    case 'night':  return `<div class="moon"><div class="moon-core"></div></div><div class="stars"></div>`;
    case 'cloudy': return `<div class="cloud cloud-back cloud--grey"></div><div class="cloud cloud-front cloud--grey"></div>`;
    case 'fog':    return `<div class="fogbank fb1"></div><div class="fogbank fb2"></div><div class="fogbank fb3"></div>`;
    case 'wind':   return `${WIND_SVG}<div class="puff p1"></div><div class="puff p2"></div><div class="windbits"></div>`;
    case 'rain':   return `<div class="cloud cloud-back"></div><div class="cloud cloud-front"></div><div class="rain"></div>`;
    case 'storm':  return `<div class="cloud cloud-back"></div><div class="cloud cloud-front"></div>
                           <div class="bolt"></div><div class="rain"></div><div class="storm-flash"></div>`;
    case 'snow':   return `<div class="cloud cloud-back cloud--snow"></div><div class="cloud cloud-front cloud--snow"></div>
                           <div class="snow"></div><div class="snow-ground"></div>`;
    default:       return '';
  }
}

/* ---------- 粒子生成 ---------- */

function makeRain(layer, n = 55) {
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const d = document.createElement('span');
    d.className = 'drop';
    d.style.left = rand(-4, 108) + '%';
    d.style.height = rand(10, 22) + 'px';
    d.style.opacity = rand(0.25, 0.75);
    d.style.setProperty('--dx', rand(-95, -40) + 'px');
    d.style.animationDuration = rand(0.55, 1.05) + 's';
    d.style.animationDelay = rand(-1.2, 0) + 's';
    layer.appendChild(d);
  }
}

function makeSnow(layer, n = 55) {
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const o = document.createElement('span');
    o.className = 'flake';
    o.style.left = rand(0, 112) + '%';
    o.style.setProperty('--fx', rand(-130, -45) + 'px');
    o.style.animationDuration = rand(2.6, 6) + 's';
    o.style.animationDelay = rand(-6, 0) + 's';

    const dot = document.createElement('i');
    const size = rand(2.5, 6.5);
    dot.style.width = size + 'px';
    dot.style.height = size + 'px';
    dot.style.opacity = rand(0.35, 0.95);
    dot.style.setProperty('--amp', rand(4, 14) + 'px');
    dot.style.animationDuration = rand(1.2, 2.6) + 's';
    if (size < 3.5) dot.style.filter = 'blur(1px)';

    o.appendChild(dot);
    layer.appendChild(o);
  }
}

function makeStreaks(layer, n = 6) {
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    s.className = 'streak';
    s.style.top = rand(8, 90) + '%';
    s.style.width = rand(70, 160) + 'px';
    s.style.animationDuration = rand(1.1, 2.2) + 's';
    s.style.animationDelay = rand(-2.5, 0) + 's';
    layer.appendChild(s);
  }
}

function makeWindbits(layer, n = 12) {
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const w = document.createElement('span');
    w.className = 'windbit';
    w.style.top = rand(12, 88) + '%';
    w.style.width = rand(20, 48) + 'px';
    w.style.setProperty('--wy', rand(-32, 32) + 'px');
    w.style.setProperty('--op', rand(0.3, 0.8));
    w.style.animationDuration = rand(1.4, 2.8) + 's';
    w.style.animationDelay = rand(-3, 0) + 's';
    layer.appendChild(w);
  }
}

function makeStars(layer, n = 26) {
  if (!layer) return;
  for (let i = 0; i < n; i++) {
    const s = document.createElement('span');
    const size = rand(1.2, 3);
    s.style.left = rand(4, 96) + '%';
    s.style.top = rand(6, 62) + '%';
    s.style.width = s.style.height = size + 'px';
    s.style.animationDuration = rand(1.6, 3.6) + 's';
    s.style.animationDelay = rand(-4, 0) + 's';
    layer.appendChild(s);
  }
}

function initScene(card) {
  const theme = card.dataset.theme;
  const scene = $('.scene', card);
  if (!scene) return;
  const heavy = card.dataset.heavy === '1';
  if (theme === 'storm' || theme === 'rain') makeRain($('.rain', scene), heavy ? 85 : 50);
  if (theme === 'snow') { makeSnow($('.snow', scene), heavy ? 70 : 50); makeStreaks($('.snow', scene)); }
  if (theme === 'wind') makeWindbits($('.windbits', scene));
  if (theme === 'night') makeStars($('.stars', scene));
}

/* ---------- 卡片渲染 ---------- */

const cardsEl = $('#cards');
const panelEl = $('#panel');
let cardEls = [];
const tiltStates = new Map();

function badgeOf(cur, dy, air) {
  const code = cur.weather_code;
  const gust = beaufort(cur.wind_gusts_10m || 0);
  if (STORM_CODES.includes(code)) return ['雷电预警', true];
  if ([65, 82].includes(code))    return ['暴雨预警', true];
  if ([75, 86].includes(code))    return ['暴雪预警', true];
  if (gust >= 8)                  return [`阵风 ${gust} 级`, true];
  const aqi = air?.current?.us_aqi;
  if (aqi > 150)                  return [`空气 ${aqiText(aqi)}`, true];
  const uv = dy.uv_index_max?.[0];
  if (uv >= 8)                    return [`紫外线 ${uvText(uv)}`, false];
  if (gust >= 6)                  return [`阵风 ${gust} 级`, false];
  if (aqi != null)                return [`AQI ${Math.round(aqi)}`, false];
  return [`体感 ${deg(cur.apparent_temperature)}`, false];
}

const delBtnHTML = `<button class="card-del" title="移除城市">✕</button>`;

function cardHTML(city, i) {
  const rec = dataMap.get(city.id);
  const delay = `style="animation-delay:${(i * 0.07).toFixed(2)}s"`;

  if (!rec || (!rec.wx && !rec.error)) {
    return `<article class="card card--cloudy is-loading" data-id="${esc(city.id)}" data-theme="cloudy" tabindex="0" role="button" ${delay}>
      <div class="tint"></div><div class="scene">${sceneHTML('cloudy')}</div><div class="card-glare"></div>
      <div class="content">
        <header class="head">
          <div><h2 class="city">${esc(city.name)}</h2><p class="cond">加载中…</p></div>
          <div class="head-right">${delBtnHTML}</div>
        </header>
        <div class="spacer"></div>
        <div class="temp">--°</div>
        <p class="range">正在获取实时数据</p>
      </div></article>`;
  }

  if (rec.error) {
    return `<article class="card card--cloudy is-error" data-id="${esc(city.id)}" data-theme="cloudy" tabindex="0" role="button" ${delay}>
      <div class="tint"></div><div class="scene">${sceneHTML('cloudy')}</div><div class="card-glare"></div>
      <div class="content">
        <header class="head">
          <div><h2 class="city">${esc(city.name)}</h2><p class="cond">加载失败</p></div>
          <div class="head-right">${delBtnHTML}</div>
        </header>
        <div class="spacer"></div>
        <div class="temp">--°</div>
        <p class="range">网络异常</p>
        <div class="chips"><span class="chip">点击卡片重试</span></div>
      </div></article>`;
  }

  const { wx, air } = rec;
  const cur = wx.current, dy = wx.daily;
  const theme = themeOf(cur.weather_code, cur.is_day, cur.wind_gusts_10m);
  const heavy = [65, 67, 75, 82, 86, 95, 96, 99].includes(cur.weather_code);
  let cond = WMO[cur.weather_code] ?? '—';
  if (theme === 'wind') cond += ' · 大风';
  const [badge, alert] = badgeOf(cur, dy, air);
  const hi = hourIndex(wx);
  const vis = fmtVis(wx.hourly.visibility?.[hi]);

  return `<article class="card card--${theme}" data-id="${esc(city.id)}" data-theme="${theme}"
      ${heavy ? 'data-heavy="1"' : ''} tabindex="0" role="button" ${delay}>
    <div class="tint"></div>
    <div class="scene">${sceneHTML(theme)}</div>
    <div class="card-glare"></div>
    <div class="content">
      <header class="head">
        <div><h2 class="city">${esc(city.name)}</h2><p class="cond">${cond}</p></div>
        <div class="head-right"><span class="badge${alert ? ' badge--alert' : ''}">${badge}</span>${delBtnHTML}</div>
      </header>
      <div class="spacer"></div>
      <div class="temp" data-temp="${Math.round(cvt(cur.temperature_2m))}">--°</div>
      <p class="range">最高 ${deg(dy.temperature_2m_max[0])} · 最低 ${deg(dy.temperature_2m_min[0])}</p>
      <div class="chips">
        <span class="chip">湿度 ${cur.relative_humidity_2m}%</span>
        <span class="chip">${windDir(cur.wind_direction_10m)} ${beaufort(cur.wind_speed_10m)} 级</span>
      </div>
      <div class="detail">
        <div class="d-item"><span class="d-label">体感</span><span class="d-value">${deg(cur.apparent_temperature)}</span></div>
        <div class="d-item"><span class="d-label">气压</span><span class="d-value">${Math.round(cur.surface_pressure)} hPa</span></div>
        <div class="d-item"><span class="d-label">能见度</span><span class="d-value">${vis}</span></div>
      </div>
    </div>
  </article>`;
}

function render() {
  cardsEl.innerHTML = state.cities.map(cardHTML).join('');
  cardEls = $$('.card', cardsEl);
  tiltStates.clear();
  cardEls.forEach(card => { initScene(card); bindCard(card); });
  animateTemps();
  applyActive();
}

/* 温度数字滚动（每个城市只播一次） */
function animateTemps() {
  $$('.temp[data-temp]', cardsEl).forEach(el => {
    const id = el.closest('.card').dataset.id;
    const target = Number(el.dataset.temp);
    if (animated.has(id)) { el.textContent = target + '°'; return; }
    animated.add(id);
    const start = performance.now() + 250;
    const dur = 1200;
    (function frame(t) {
      const p = Math.min(1, Math.max(0, (t - start) / dur));
      const ease = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * ease) + '°';
      if (p < 1) requestAnimationFrame(frame);
    })(performance.now());
  });
}

/* ---------- 选中卡片 / 全局氛围 ---------- */

function applyActive({ zap = false } = {}) {
  const card = cardEls.find(c => c.dataset.id === state.activeId) || cardEls[0];
  if (!card) { panelEl.innerHTML = ''; syncTopbar(); return; }
  state.activeId = card.dataset.id;
  cardEls.forEach(c => c.classList.toggle('active', c === card));
  document.body.dataset.theme = card.dataset.theme || 'sunny';
  syncTopbar();
  renderPanel();
  if (zap && card.dataset.theme === 'storm') zapCard(card);
}

function syncTopbar() {
  const city = state.cities.find(c => c.id === state.activeId);
  const rec = city && dataMap.get(city.id);
  $('#now-summary').textContent = rec?.wx
    ? `现在 · ${city.name} ${WMO[rec.wx.current.weather_code] ?? ''} ${deg(rec.wx.current.temperature_2m)}`
    : '';
  $('#updated').textContent = state.updatedAt
    ? `更新于 ${pad(state.updatedAt.getHours())}:${pad(state.updatedAt.getMinutes())}` : '';
  $('#btn-unit').textContent = state.unit === 'c' ? '°F' : '°C';
}

/* ---------- 预报面板（24 小时 / 7 天 / 今日详情） ---------- */

function renderPanel() {
  const city = state.cities.find(c => c.id === state.activeId);
  const rec = city && dataMap.get(city.id);
  if (!rec?.wx) { panelEl.innerHTML = ''; return; }
  const { wx, air } = rec;
  const hi = hourIndex(wx);

  let hours = '';
  for (let i = hi; i < Math.min(hi + 24, wx.hourly.time.length); i++) {
    const pop = wx.hourly.precipitation_probability?.[i];
    hours += `<div class="h-item${i === hi ? ' now' : ''}">
      <span class="h-time">${i === hi ? '现在' : wx.hourly.time[i].slice(11, 13) + '时'}</span>
      <span class="h-ico">${iconOf(wx.hourly.weather_code[i], wx.hourly.is_day?.[i] ?? 1)}</span>
      <span class="h-temp">${deg(wx.hourly.temperature_2m[i])}</span>
      <span class="h-pop">${pop > 0 ? pop + '%' : ''}</span>
    </div>`;
  }

  const dy = wx.daily;
  const weekMin = Math.min(...dy.temperature_2m_min);
  const span = (Math.max(...dy.temperature_2m_max) - weekMin) || 1;
  const days = dy.time.map((t, i) => {
    const d = new Date(t + 'T00:00');
    const nm = i === 0 ? '今天' : i === 1 ? '明天' : WEEK[d.getDay()];
    const lo = dy.temperature_2m_min[i], hiT = dy.temperature_2m_max[i];
    const pop = dy.precipitation_probability_max?.[i];
    return `<div class="day-row">
      <span class="day-name">${nm}</span>
      <span class="day-ico">${iconOf(dy.weather_code[i], 1)}</span>
      <span class="day-pop">${pop > 0 ? pop + '%' : ''}</span>
      <span class="day-min">${deg(lo)}</span>
      <div class="day-bar"><i style="left:${((lo - weekMin) / span * 100).toFixed(1)}%;width:${Math.max(6, (hiT - lo) / span * 100).toFixed(1)}%"></i></div>
      <span class="day-max">${deg(hiT)}</span>
    </div>`;
  }).join('');

  const uv = dy.uv_index_max?.[0];
  const aqi = air?.current?.us_aqi;
  const pm25 = air?.current?.pm2_5;
  const stats = [
    ['日出', dy.sunrise?.[0]?.slice(11, 16) ?? '—'],
    ['日落', dy.sunset?.[0]?.slice(11, 16) ?? '—'],
    ['紫外线', uv != null ? `${Math.round(uv)} · ${uvText(uv)}` : '—'],
    ['空气质量', aqi != null ? `${Math.round(aqi)} · ${aqiText(aqi)}` : '—'],
    ['PM2.5', pm25 != null ? `${Math.round(pm25)} µg/m³` : '—'],
    ['今日降水', `${dy.precipitation_probability_max?.[0] ?? 0}%`]
  ].map(([l, v]) => `<div class="d-item"><span class="d-label">${l}</span><span class="d-value">${v}</span></div>`).join('');

  panelEl.innerHTML = `
    <div class="panel-block panel-block--hourly">
      <h3 class="panel-title">24 小时预报 · ${esc(city.name)}</h3>
      <div class="hourly">${hours}</div>
    </div>
    <div class="panel-block panel-block--daily">
      <h3 class="panel-title">7 天预报</h3>
      <div class="daily">${days}</div>
    </div>
    <div class="panel-block panel-block--stats">
      <h3 class="panel-title">今日详情</h3>
      <div class="stats">${stats}</div>
    </div>`;
}

/* ---------- 卡片交互：3D 倾斜 / 光斑 / 点击 ---------- */

function bindCard(card) {
  const st = { rx: 0, ry: 0, y: 0, s: 1, trx: 0, try: 0, ty: 0, ts: 1, press: 1 };
  tiltStates.set(card, st);

  card.addEventListener('pointermove', e => {
    const r = card.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width  - 0.5;
    const py = (e.clientY - r.top)  / r.height - 0.5;
    st.try = px * 10;
    st.trx = -py * 8;
    card.style.setProperty('--mx', (px + 0.5) * 100 + '%');
    card.style.setProperty('--my', (py + 0.5) * 100 + '%');
  });

  card.addEventListener('pointerenter', () => { st.ty = -7; st.ts = 1.02; });
  card.addEventListener('pointerleave', () => {
    st.trx = 0; st.try = 0; st.ty = 0; st.ts = 1; st.press = 1;
  });

  card.addEventListener('pointerdown', e => {
    if (e.target.closest('.card-del')) return;
    st.press = 0.97;
    spawnRipple(card, e);
  });

  card.addEventListener('click', e => {
    if (e.target.closest('.card-del')) { e.stopPropagation(); removeCity(card.dataset.id); return; }
    onCardTap(card);
  });

  card.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onCardTap(card); }
  });
}

function onCardTap(card) {
  if (card.classList.contains('is-loading')) return;
  if (card.classList.contains('is-error')) { retryCity(card.dataset.id); return; }
  state.activeId = card.dataset.id;
  store.save('lgw-active', state.activeId);
  applyActive({ zap: true });
}

window.addEventListener('pointerup', () => {
  tiltStates.forEach(st => { st.press = 1; });
});

/* 弹簧式插值动画 */
(function loop() {
  const k = 0.14;
  cardEls.forEach(card => {
    const st = tiltStates.get(card);
    if (!st) return;
    st.rx += (st.trx - st.rx) * k;
    st.ry += (st.try - st.ry) * k;
    st.y  += (st.ty  - st.y)  * k;
    const targetS = st.ts * st.press;
    st.s += (targetS - st.s) * k;
    card.style.transform =
      `perspective(1100px) translateY(${st.y.toFixed(2)}px) ` +
      `rotateX(${st.rx.toFixed(2)}deg) rotateY(${st.ry.toFixed(2)}deg) ` +
      `scale(${st.s.toFixed(3)})`;
  });
  requestAnimationFrame(loop);
})();

/* 液态涟漪 */
function spawnRipple(card, e) {
  const r = card.getBoundingClientRect();
  const span = document.createElement('span');
  span.className = 'ripple';
  span.style.left = (e.clientX - r.left) + 'px';
  span.style.top  = (e.clientY - r.top)  + 'px';
  card.appendChild(span);
  span.addEventListener('animationend', () => span.remove());
}

/* 雷暴卡片：点击触发闪电 */
function zapCard(card) {
  const scene = $('.scene', card);
  if (!scene) return;
  scene.classList.remove('zap');
  void scene.offsetWidth;
  scene.classList.add('zap');
  setTimeout(() => scene.classList.remove('zap'), 650);
}

/* ---------- 城市管理 ---------- */

const cityId = (lat, lon) => lat.toFixed(3) + ',' + lon.toFixed(3);

async function addCity({ name, lat, lon }) {
  const id = cityId(lat, lon);
  if (state.cities.some(c => c.id === id)) { toast('该城市已在列表中'); return; }
  if (state.cities.length >= 8) { toast('最多添加 8 个城市'); return; }
  const city = { id, name, lat, lon };
  state.cities.push(city);
  store.save('lgw-cities', state.cities);
  closeModal();
  render();
  await refreshCity(city);
  state.updatedAt = new Date();
  state.activeId = id;
  store.save('lgw-active', id);
  render();
  toast(`已添加 ${name}`);
}

function removeCity(id) {
  const i = state.cities.findIndex(c => c.id === id);
  if (i < 0) return;
  if (state.cities.length <= 1) { toast('至少保留一个城市'); return; }
  const [c] = state.cities.splice(i, 1);
  dataMap.delete(id);
  animated.delete(id);
  store.save('lgw-cities', state.cities);
  if (state.activeId === id) {
    state.activeId = state.cities[0].id;
    store.save('lgw-active', state.activeId);
  }
  render();
  toast(`已移除 ${c.name}`);
}

/* ---------- 城市搜索弹窗 ---------- */

const modal = $('#modal');
let lastResults = [];

function openModal() {
  modal.classList.add('open');
  $('#search-input').value = '';
  renderResults(null);
  setTimeout(() => $('#search-input').focus(), 60);
}
function closeModal() { modal.classList.remove('open'); }

$('#btn-add').addEventListener('click', openModal);
modal.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeModal(); });
window.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

async function searchCities(q) {
  const url = 'https://geocoding-api.open-meteo.com/v1/search'
    + `?name=${encodeURIComponent(q)}&count=8&language=zh&format=json`;
  const j = await fetch(url).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  return j.results || [];
}

let searchTimer = 0, searchSeq = 0;
$('#search-input').addEventListener('input', e => {
  const q = e.target.value.trim();
  clearTimeout(searchTimer);
  if (!q) { renderResults(null); return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    renderResults('searching');
    try {
      const res = await searchCities(q);
      if (seq === searchSeq) renderResults(res);
    } catch {
      if (seq === searchSeq) renderResults('error');
    }
  }, 350);
});

function renderResults(res) {
  const ul = $('#results');
  if (res === null)        { ul.innerHTML = '<li class="results-empty">输入城市名开始搜索</li>'; return; }
  if (res === 'searching') { ul.innerHTML = '<li class="results-empty">搜索中…</li>'; return; }
  if (res === 'error')     { ul.innerHTML = '<li class="results-empty">搜索失败，请稍后重试</li>'; return; }
  if (!res.length)         { ul.innerHTML = '<li class="results-empty">未找到相关城市</li>'; return; }
  lastResults = res;
  ul.innerHTML = res.map((r, i) =>
    `<li><button class="result" data-i="${i}">
      <span class="r-name">${esc(r.name)}</span>
      <span class="r-sub">${esc([r.admin1, r.country].filter(Boolean).join(' · '))}</span>
    </button></li>`).join('');
}

$('#results').addEventListener('click', e => {
  const btn = e.target.closest('.result');
  if (!btn) return;
  const r = lastResults[Number(btn.dataset.i)];
  if (r) addCity({ name: r.name, lat: r.latitude, lon: r.longitude });
});

/* 浏览器定位 → 反查城市名 */
$('#btn-locate').addEventListener('click', () => {
  if (!navigator.geolocation) { toast('当前浏览器不支持定位'); return; }
  toast('正在定位…');
  navigator.geolocation.getCurrentPosition(async pos => {
    const { latitude: lat, longitude: lon } = pos.coords;
    let name = '当前位置';
    try {
      const j = await fetch('https://api.bigdatacloud.net/data/reverse-geocode-client'
        + `?latitude=${lat}&longitude=${lon}&localityLanguage=zh`).then(r => r.json());
      name = j.city || j.locality || j.principalSubdivision || name;
    } catch {}
    addCity({ name: '📍 ' + name, lat, lon });
  }, err => {
    toast('定位失败：' + (err.code === 1 ? '未授权' : '无法获取位置'));
  }, { timeout: 10000, maximumAge: 300000 });
});

/* ---------- 工具栏按钮 ---------- */

$('#btn-refresh').addEventListener('click', refreshAll);

$('#btn-unit').addEventListener('click', () => {
  state.unit = state.unit === 'c' ? 'f' : 'c';
  store.save('lgw-unit', state.unit);
  render();
});

/* ---------- 提示气泡 ---------- */

let toastTimer = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

/* ---------- 启动 ---------- */

render();                                  // 先渲染骨架
refreshAll();                              // 拉取真实数据
setInterval(refreshAll, 15 * 60 * 1000);   // 每 15 分钟自动刷新
