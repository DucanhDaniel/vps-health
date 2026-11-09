'use strict';
// Theo dõi log xác thực (SSH brute-force, đăng nhập, tạo user...).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const IP = '([0-9a-fA-F:.]+)';

const PATTERNS = [
  { type: 'fail', re: new RegExp(`Failed (?:password|publickey|none|keyboard-interactive/pam) for (?:invalid user )?(\\S*) from ${IP}`) },
  { type: 'fail', re: new RegExp(`Invalid user (\\S*) from ${IP}`) },
  { type: 'fail', re: new RegExp(`authentication failure;.*rhost=${IP}(?:\\s+user=(\\S+))?`), swap: true },
  { type: 'fail', re: new RegExp(`Connection (?:closed|reset) by (?:authenticating|invalid) user (\\S*) ${IP} port \\d+ \\[preauth\\]`) },
  { type: 'fail', re: new RegExp(`maximum authentication attempts exceeded for (?:invalid user )?(\\S*) from ${IP}`) },
  { type: 'login', re: new RegExp(`Accepted (\\S+) for (\\S+) from ${IP}`), login: true },
  { type: 'newuser', re: /new user: name=([^,\s]+)/ },
  { type: 'passwd', re: /password changed for (\S+)/ },
  { type: 'sudoers', re: /add '([^']+)' to group '(sudo|wheel|docker|root)'/ },
];

function parseTimestamp(line, now) {
  // ISO: 2026-11-09T11:37:01.123456+07:00
  const iso = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/);
  if (iso) { const t = Date.parse(iso[1]); if (!isNaN(t)) return t; }
  // Truyền thống: Nov  9 11:37:01
  const m = line.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m && MONTHS[m[1]] !== undefined) {
    const d = new Date(new Date(now).getFullYear(), MONTHS[m[1]], Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    let t = d.getTime();
    if (t > now + 86400000) { d.setFullYear(d.getFullYear() - 1); t = d.getTime(); }
    return t;
  }
  return null;
}

function parseLine(line) {
  for (const p of PATTERNS) {
    const m = line.match(p.re);
    if (!m) continue;
    if (p.type === 'fail') {
      return p.swap ? { type: 'fail', ip: m[1], user: m[2] || '' } : { type: 'fail', user: m[1], ip: m[2] };
    }
    if (p.type === 'login') return { type: 'login', method: m[1], user: m[2], ip: m[3] };
    if (p.type === 'newuser') return { type: 'newuser', user: m[1] };
    if (p.type === 'passwd') return { type: 'passwd', user: m[1] };
    if (p.type === 'sudoers') return { type: 'sudoers', user: m[1], group: m[2] };
  }
  return null;
}

class AuthWatcher {
  constructor(cfg, onEvent) {
    this.cfg = cfg;
    this.onEvent = onEvent;
    this.fails = [];      // {t, ip, user}
    this.logins = [];     // {t, ip, user, method}
    this.file = null;
    this.offset = 0;
    this.ino = null;
    this.buf = '';
    this.source = 'none';
    this.journal = null;
  }

  findFile() {
    if (this.cfg.authLog) return this.cfg.authLog;
    const root = this.cfg.hostRoot || '/';
    for (const f of ['var/log/auth.log', 'var/log/secure']) {
      const full = path.join(root, f);
      if (fs.existsSync(full)) return full;
    }
    return null;
  }

  start() {
    this.file = this.findFile();
    if (this.file) {
      this.source = this.file;
      this.loadBacklog();
      return;
    }
    // Không có file log -> thử journalctl (chế độ cài trực tiếp bằng systemd)
    try {
      const j = spawn('journalctl', ['-f', '-n', '2000', '-o', 'short-iso', '--no-pager', 'SYSLOG_FACILITY=4', 'SYSLOG_FACILITY=10'], { stdio: ['ignore', 'pipe', 'ignore'] });
      j.on('error', () => { this.source = 'none'; this.journal = null; });
      let first = true;
      const startAt = Date.now();
      j.stdout.setEncoding('utf8');
      j.stdout.on('data', chunk => {
        this.buf += chunk;
        const lines = this.buf.split('\n');
        this.buf = lines.pop();
        // Dòng trong 3s đầu là backlog -> không gửi cảnh báo
        const backlog = first && Date.now() - startAt < 3000;
        for (const l of lines) this.handleLine(l, backlog);
        if (!backlog) first = false;
      });
      this.journal = j;
      this.source = 'journalctl';
    } catch { this.source = 'none'; }
  }

  loadBacklog() {
    try {
      const st = fs.statSync(this.file);
      this.ino = st.ino;
      const start = Math.max(0, st.size - 8 * 1024 * 1024);
      const fd = fs.openSync(this.file, 'r');
      const len = st.size - start;
      const b = Buffer.alloc(len);
      fs.readSync(fd, b, 0, len, start);
      fs.closeSync(fd);
      this.offset = st.size;
      const lines = b.toString('utf8').split('\n');
      if (start > 0) lines.shift();
      for (const l of lines) this.handleLine(l, true);
    } catch (e) {
      this.source = `lỗi đọc ${this.file}: ${e.code || e.message}`;
    }
  }

  poll() {
    if (!this.file) return;
    let st;
    try { st = fs.statSync(this.file); } catch { return; }
    if (st.ino !== this.ino || st.size < this.offset) { // log rotate
      this.ino = st.ino;
      this.offset = 0;
    }
    if (st.size === this.offset) return;
    const len = Math.min(st.size - this.offset, 16 * 1024 * 1024);
    const b = Buffer.alloc(len);
    try {
      const fd = fs.openSync(this.file, 'r');
      fs.readSync(fd, b, 0, len, this.offset);
      fs.closeSync(fd);
    } catch { return; }
    this.offset += len;
    this.buf += b.toString('utf8');
    const lines = this.buf.split('\n');
    this.buf = lines.pop();
    for (const l of lines) this.handleLine(l, false);
  }

  handleLine(line, backlog) {
    if (!line) return;
    const ev = parseLine(line);
    if (!ev) return;
    const now = Date.now();
    // Dòng mới: dùng thời điểm đọc (tránh lệch múi giờ); backlog: dùng timestamp trong log
    ev.t = backlog ? (parseTimestamp(line, now) || now) : now;
    if (ev.type === 'fail') this.fails.push(ev);
    if (ev.type === 'login') this.logins.push(ev);
    this.prune();
    if (!backlog) this.onEvent(ev);
  }

  prune() {
    const cut = Date.now() - 24 * 3600 * 1000;
    if (this.fails.length && this.fails[0].t < cut) this.fails = this.fails.filter(f => f.t >= cut);
    if (this.fails.length > 200000) this.fails = this.fails.slice(-200000);
    if (this.logins.length > 200) this.logins = this.logins.slice(-200);
  }

  failsSince(ms) {
    const cut = Date.now() - ms;
    return this.fails.filter(f => f.t >= cut);
  }

  summary(windowMin) {
    this.prune();
    const win = this.failsSince(windowMin * 60000);
    const byIp = new Map();
    for (const f of this.fails) {
      const e = byIp.get(f.ip) || { ip: f.ip, count: 0, recent: 0, users: new Set(), last: 0 };
      e.count++;
      if (f.user) e.users.add(f.user);
      e.last = Math.max(e.last, f.t);
      byIp.set(f.ip, e);
    }
    for (const f of win) byIp.get(f.ip).recent++;
    const topIps = [...byIp.values()].sort((a, b) => b.count - a.count).slice(0, 15)
      .map(e => ({ ip: e.ip, count: e.count, recent: e.recent, users: [...e.users].slice(0, 5), last: e.last }));
    // Phân bố theo giờ (24 cột)
    const now = Date.now();
    const hourly = new Array(24).fill(0);
    for (const f of this.fails) {
      const h = Math.floor((now - f.t) / 3600000);
      if (h >= 0 && h < 24) hourly[23 - h]++;
    }
    return {
      source: this.source,
      failsWindow: win.length,
      fails24h: this.fails.length,
      uniqueIps24h: byIp.size,
      topIps,
      hourly,
      logins: this.logins.slice(-15).reverse(),
    };
  }
}

module.exports = { AuthWatcher, parseLine, parseTimestamp };
