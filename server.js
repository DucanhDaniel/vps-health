'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./lib/config');
const { SystemCollector } = require('./lib/system');
const { DockerCollector } = require('./lib/docker');
const { AuthWatcher } = require('./lib/security');
const { Telegram, esc } = require('./lib/telegram');
const { AlertEngine, fmtBytes, pct, ICON } = require('./lib/alerts');

// ---------- trạng thái bền vững ----------
fs.mkdirSync(cfg.dataDir, { recursive: true });
const STATE_FILE = path.join(cfg.dataDir, 'state.json');
const HISTORY_FILE = path.join(cfg.dataDir, 'history.json');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const state = readJson(STATE_FILE, {});

if (!cfg.dashboard.pass) {
  cfg.dashboard.pass = state.generatedPassword || crypto.randomBytes(9).toString('base64url');
  state.generatedPassword = cfg.dashboard.pass;
  console.warn(`[auth] Chưa đặt DASHBOARD_PASSWORD — dùng mật khẩu tự sinh: ${cfg.dashboard.pass} (user: ${cfg.dashboard.user})`);
}

const tg = new Telegram(cfg);
const sys = new SystemCollector(cfg);
const docker = new DockerCollector(cfg);
const alerts = new AlertEngine(cfg, tg, state);
const auth = new AuthWatcher(cfg, ev => alerts.onAuthEvent(ev, auth));
const staticInfo = sys.static();

// ---------- lịch sử: mẫu 5s trong 1 giờ + trung bình mỗi phút trong 24 giờ ----------
const hist = readJson(HISTORY_FILE, { fine: [], minute: [] });
const FINE_MAX = Math.ceil(3600 / cfg.intervalSec);
let minuteAcc = null;

function pushHistory(s) {
  const pt = {
    t: s.t, cpu: +s.cpu.usage.toFixed(1), mem: +s.mem.pct.toFixed(1), swap: +s.mem.swapPct.toFixed(1),
    load: s.load[0], rx: Math.round(s.net.rx), tx: Math.round(s.net.tx), rd: Math.round(s.io.rd), wr: Math.round(s.io.wr),
    conn: s.tcp.states.ESTABLISHED || 0, iowait: +s.cpu.iowait.toFixed(1),
  };
  hist.fine.push(pt);
  if (hist.fine.length > FINE_MAX) hist.fine.splice(0, hist.fine.length - FINE_MAX);
  const minute = Math.floor(s.t / 60000);
  if (minuteAcc && minuteAcc.minute !== minute) {
    const avg = { t: minuteAcc.minute * 60000 + 30000 };
    for (const k of Object.keys(minuteAcc.sum)) avg[k] = +(minuteAcc.sum[k] / minuteAcc.n).toFixed(k === 'load' ? 2 : 1);
    hist.minute.push(avg);
    if (hist.minute.length > 1440) hist.minute.splice(0, hist.minute.length - 1440);
    minuteAcc = null;
  }
  if (!minuteAcc) minuteAcc = { minute, n: 0, sum: {} };
  minuteAcc.n++;
  for (const [k, v] of Object.entries(pt)) if (k !== 't') minuteAcc.sum[k] = (minuteAcc.sum[k] || 0) + v;
}

function saveAll() {
  try {
    state.events = alerts.events.slice(0, 300);
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
    fs.writeFileSync(HISTORY_FILE + '.tmp', JSON.stringify(hist));
    fs.renameSync(HISTORY_FILE + '.tmp', HISTORY_FILE);
  } catch (e) { console.error('[save]', e.message); }
}

// ---------- vòng lặp thu thập ----------
let latest = null;
let containers = [];
let dockerBusy = false;

function tick() {
  try {
    const s = sys.collect();
    latest = s;
    if (s.ready) pushHistory(s);
    alerts.checkSystem(s);
    auth.poll();
  } catch (e) { console.error('[tick]', e); }
}

async function dockerTick() {
  if (dockerBusy) return;
  dockerBusy = true;
  try {
    const list = await docker.collect();
    containers = list || [];
    alerts.checkContainers(list);
  } catch (e) { console.error('[docker]', e.message); }
  dockerBusy = false;
}

// ---------- tóm tắt cho Telegram ----------
function statusText() {
  const s = latest;
  if (!s) return 'Đang khởi động...';
  const lvl = alerts.overall();
  const head = lvl === 'ok' ? '🟢 Mọi thứ ổn định' : `${ICON[lvl]} ${alerts.list().length} cảnh báo đang mở · ${alerts.recent().length} sự cố trong 1 giờ qua`;
  const running = containers.filter(c => c.state === 'running').length;
  const days = Math.floor(s.uptime / 86400), hrs = Math.floor((s.uptime % 86400) / 3600);
  return `<b>${esc(cfg.serverName)}</b> — ${head}\n\n` +
    `🧠 CPU: <b>${pct(s.cpu.usage)}</b> (${s.cpu.count} nhân, load ${s.load.map(x => x.toFixed(2)).join('/')})\n` +
    `💾 RAM: <b>${pct(s.mem.pct)}</b> (${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)})` +
    (s.mem.swapTotal ? `\n🔁 Swap: ${pct(s.mem.swapPct)}` : '') + '\n' +
    s.fs.map(f => `🗄 ${esc(f.mount)}: <b>${pct(f.pct)}</b> (còn ${fmtBytes(f.avail)})`).join('\n') + '\n' +
    `🌐 Mạng: ↓${fmtBytes(s.net.rx)}/s ↑${fmtBytes(s.net.tx)}/s · ${s.tcp.states.ESTABLISHED || 0} kết nối\n` +
    (docker.available ? `🐳 Container: ${running}/${containers.length} đang chạy\n` : '') +
    `⏱ Uptime: ${days} ngày ${hrs} giờ`;
}

tg.on('status', () => statusText());
tg.on('start', () => statusText());
tg.on('containers', () => {
  if (!docker.available) return `Không đọc được Docker: ${esc(docker.error)}`;
  if (!containers.length) return 'Không có container nào.';
  return '<b>🐳 Container</b>\n' + containers.map(c => {
    const icon = c.state === 'running' ? (c.health === 'unhealthy' ? '🟠' : '🟢') : c.state === 'restarting' ? '🔴' : '⚪️';
    return `${icon} <b>${esc(c.name)}</b> — ${esc(c.status)}${c.cpu != null ? ` · CPU ${c.cpu.toFixed(1)}%` : ''}${c.memUsage != null ? ` · RAM ${fmtBytes(c.memUsage)}` : ''}`;
  }).join('\n');
});
tg.on('security', () => {
  const sec = auth.summary(cfg.th.sshWindowMin);
  const syn = latest ? latest.tcp.states.SYN_RECV || 0 : 0;
  return `<b>🛡 Bảo mật</b>\nSSH sai (${cfg.th.sshWindowMin} phút): <b>${sec.failsWindow}</b>\nSSH sai (24h): <b>${sec.fails24h}</b> từ ${sec.uniqueIps24h} IP\nSYN_RECV: ${syn}\n` +
    (sec.topIps.length ? '\nTop IP tấn công:\n' + sec.topIps.slice(0, 8).map(x => `• <code>${esc(x.ip)}</code> — ${x.count} lần`).join('\n') : '') +
    (sec.logins.length ? '\n\nĐăng nhập gần đây:\n' + sec.logins.slice(0, 5).map(l => `• ${esc(l.user)} từ <code>${esc(l.ip)}</code> — ${alerts.time(l.t)}`).join('\n') : '') +
    (sec.source === 'none' ? '\n\n⚠️ Không đọc được log SSH (auth.log).' : '');
});
tg.on('alerts', () => {
  const l = alerts.list();
  if (!l.length) return '✅ Không có cảnh báo nào đang mở.';
  return '<b>Cảnh báo đang mở</b>\n' + l.map(a => `${ICON[a.level]} ${esc(a.title)} (từ ${alerts.time(a.since)})`).join('\n');
});
tg.on('help', () => '<b>Lệnh</b>\n/status — tình trạng VPS\n/containers — danh sách container\n/security — tình hình bảo mật\n/alerts — cảnh báo đang mở');

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const authFails = new Map(); // ip -> [ts]

function clientIp(req) { return (req.socket.remoteAddress || '').replace(/^::ffff:/, ''); }

function checkAuth(req, res) {
  const ip = clientIp(req);
  const now = Date.now();
  const fails = (authFails.get(ip) || []).filter(t => now - t < 15 * 60000);
  if (fails.length >= 20) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Quá nhiều lần thử. Đợi 15 phút.'); return false; }
  const h = req.headers.authorization || '';
  const expected = 'Basic ' + Buffer.from(`${cfg.dashboard.user}:${cfg.dashboard.pass}`).toString('base64');
  const a = crypto.createHash('sha256').update(h).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  if (crypto.timingSafeEqual(a, b)) return true;
  if (h) {
    fails.push(now);
    authFails.set(ip, fails);
    if (fails.length === cfg.th.dashAuthFail) {
      alerts.fire(`dashauth:${ip}`, 'warning', `Có người dò mật khẩu dashboard từ ${ip}`, `${fails.length} lần nhập sai trong 15 phút.`, 'security', 3600000);
    }
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="VPS Health", charset="UTF-8"', 'content-type': 'text/plain; charset=utf-8' });
  res.end('Cần đăng nhập');
  return false;
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function snapshot() {
  const s = latest;
  return {
    server: { name: cfg.serverName, ...staticInfo, tz: cfg.tz },
    now: Date.now(),
    status: alerts.overall(),
    alerts: alerts.list(),
    recent: alerts.recent(),
    system: s && {
      t: s.t, cpu: s.cpu, load: s.load, uptime: s.uptime, mem: s.mem, net: s.net, io: s.io, fs: s.fs,
      tcp: s.tcp, procs: { count: s.procs.count, zombies: s.procs.zombies, byCpu: s.procs.byCpu, byMem: s.procs.byMem },
    },
    docker: { available: docker.available, error: docker.error, containers },
    security: auth.summary(cfg.th.sshWindowMin),
    telegram: { enabled: tg.enabled, dryRun: cfg.telegram.dryRun, sent: tg.sent, lastError: tg.lastError },
    thresholds: cfg.th,
  };
}

function history(range) {
  const now = Date.now();
  if (range === '24h') return hist.minute.filter(p => p.t >= now - 86400000);
  const ms = range === '15m' ? 15 * 60000 : 3600000;
  return hist.fine.filter(p => p.t >= now - ms);
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (req.url === '/healthz') { res.end('ok'); return; }
  if (!checkAuth(req, res)) return;
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/snapshot') return sendJson(res, snapshot());
  if (url.pathname === '/api/history') return sendJson(res, { range: url.searchParams.get('range') || '1h', points: history(url.searchParams.get('range')) });
  if (url.pathname === '/api/events') return sendJson(res, alerts.events.slice(0, 200));
  if (url.pathname === '/api/test-alert' && req.method === 'POST') {
    tg.send(alerts.format('info', 'Tin nhắn thử từ dashboard', 'Nếu bạn nhận được tin này, cảnh báo Telegram đang hoạt động.'));
    return sendJson(res, { ok: tg.enabled });
  }
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(path.join(PUBLIC, file));
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
  });
});

// ---------- khởi động ----------
auth.start();
tick();
setInterval(tick, cfg.intervalSec * 1000);
dockerTick();
setInterval(dockerTick, Math.max(10, cfg.intervalSec * 2) * 1000);
setInterval(saveAll, 60000);

// Nếu bind vào IP Tailscale mà Tailscale chưa lên (lúc khởi động máy) -> thử lại, cảnh báo vẫn chạy bình thường
let listenTries = 0;
server.on('error', e => {
  if (e.code === 'EADDRNOTAVAIL' || e.code === 'EADDRINUSE') {
    if (listenTries++ % 12 === 0) console.warn(`[http] Chưa bind được ${cfg.bindHost}:${cfg.port} (${e.code}) — thử lại mỗi 5 giây...`);
    setTimeout(() => server.listen(cfg.port, cfg.bindHost), 5000);
  } else {
    console.error('[http]', e);
  }
});
server.on('listening', () => {
  console.log(`[vps-health] Dashboard: http://${cfg.bindHost}:${cfg.port}  (user: ${cfg.dashboard.user})`);
});
server.listen(cfg.port, cfg.bindHost);
console.log(`[vps-health] Telegram: ${tg.enabled ? (cfg.telegram.dryRun ? 'dry-run' : 'bật') : 'TẮT (thiếu TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'} · Log SSH: ${auth.source} · Docker: ${docker.exists() ? cfg.dockerSocket : 'không thấy'}`);

setTimeout(() => {
  if (cfg.telegram.startupMessage) {
    tg.send(`🟢 <b>VPS Health Monitor đã khởi động</b> trên <code>${esc(cfg.serverName)}</code>\nDashboard: http://${esc(cfg.bindHost)}:${cfg.port}\nGõ /status để xem tình trạng.\n\n` +
      `Log SSH: ${esc(auth.source)}\nDocker: ${docker.available ? `${containers.length} container` : esc(docker.error || 'không có')}`);
  }
  tg.pollCommands();
}, 12000);

function shutdown() { saveAll(); process.exit(0); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
