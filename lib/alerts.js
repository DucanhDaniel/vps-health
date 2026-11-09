'use strict';
// Bộ luật cảnh báo: theo dõi trạng thái, chống spam, gửi Telegram.
const { esc } = require('./telegram');

const LEVELS = { ok: 0, info: 1, warning: 2, critical: 3 };
const ICON = { info: 'ℹ️', warning: '⚠️', critical: '🚨', ok: '✅' };
const LABEL = { info: 'THÔNG BÁO', warning: 'CẢNH BÁO', critical: 'NGHIÊM TRỌNG', ok: 'ĐÃ ỔN' };

// Các loại cảnh báo — bật/tắt gửi Telegram từng loại trên dashboard.
// keys = tiền tố của key cảnh báo (phần trước dấu ":")
const TYPES = [
  { id: 'ram', group: 'Tài nguyên', label: 'RAM / swap sắp đầy', keys: ['ram', 'swap'] },
  { id: 'oom', group: 'Tài nguyên', label: 'Hết RAM — kernel giết tiến trình (OOM)', keys: ['oom'] },
  { id: 'disk', group: 'Tài nguyên', label: 'Ổ đĩa / inode sắp đầy', keys: ['disk', 'inode'] },
  { id: 'cpu', group: 'Tài nguyên', label: 'CPU, load cao, tiến trình zombie', keys: ['cpu', 'load', 'zombie'] },
  { id: 'io', group: 'Tài nguyên', label: 'Ổ đĩa nghẽn (I/O wait), CPU steal', keys: ['iowait', 'steal'] },
  { id: 'cnew', group: 'Docker', label: 'Có container mới', keys: ['cnew'] },
  { id: 'crm', group: 'Docker', label: 'Container bị xóa', keys: ['crm'] },
  { id: 'cstop', group: 'Docker', label: 'Container dừng / crash / restart liên tục', keys: ['cstop', 'cdown'] },
  { id: 'crestart', group: 'Docker', label: 'Container tự khởi động lại', keys: ['crestart'] },
  { id: 'chealth', group: 'Docker', label: 'Container unhealthy', keys: ['chealth'] },
  { id: 'cmem', group: 'Docker', label: 'Container gần chạm giới hạn RAM', keys: ['cmem'] },
  { id: 'sshbrute', group: 'Bảo mật', label: 'Brute-force SSH', keys: ['sship', 'sshtotal'] },
  { id: 'sshlogin', group: 'Bảo mật', label: 'Đăng nhập SSH thành công', keys: ['login'] },
  { id: 'account', group: 'Bảo mật', label: 'Tạo tài khoản, cấp quyền sudo, đổi mật khẩu', keys: ['newuser', 'sudoers', 'passwd'] },
  { id: 'port', group: 'Bảo mật', label: 'Cổng mới mở ra Internet', keys: ['port'] },
  { id: 'ddos', group: 'Bảo mật', label: 'SYN flood, 1 IP mở quá nhiều kết nối', keys: ['synflood', 'conn'] },
  { id: 'miner', group: 'Bảo mật', label: 'Tiến trình / container nghi đào coin', keys: ['proc', 'cmal'] },
  { id: 'dashauth', group: 'Bảo mật', label: 'Có người dò mật khẩu dashboard', keys: ['dashauth'] },
  { id: 'recovery', group: 'Khác', label: 'Tin "đã trở lại bình thường"', keys: [] },
  { id: 'repeat', group: 'Khác', label: 'Nhắc lại cảnh báo chưa xử lý', keys: [] },
];
const KEY_TYPE = {};
for (const t of TYPES) for (const k of t.keys) KEY_TYPE[k] = t.id;

const fmtBytes = b => {
  if (b == null || isNaN(b)) return '–';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
};
const pct = v => `${(v || 0).toFixed(1)}%`;

class AlertEngine {
  constructor(cfg, telegram, state) {
    this.cfg = cfg;
    this.tg = telegram;
    this.state = state;          // trạng thái bền vững (lưu ra đĩa)
    this.active = new Map();     // key -> {level, title, detail, since, lastNotified}
    this.cooldowns = new Map();  // key -> ts
    this.events = state.events || [];
    this.counters = new Map();   // bộ đếm duy trì (sustain)
    this.prevContainers = null;
    this.prevPorts = null;
    this.prevOom = null;
  }

  time(t = Date.now()) {
    return new Date(t).toLocaleString('vi-VN', { timeZone: this.cfg.tz, hour12: false });
  }

  format(level, title, detail) {
    return `${ICON[level]} <b>${LABEL[level]}</b> · <code>${esc(this.cfg.serverName)}</code>\n<b>${esc(title)}</b>` +
      (detail ? `\n${esc(detail)}` : '') + `\n<i>${this.time()}</i>`;
  }

  typeOf(key) { return KEY_TYPE[String(key).split(':')[0]] || 'other'; }

  get muted() { return this.state.muted || (this.state.muted = {}); }
  get snoozed() { return (this.state.snoozeUntil || 0) > Date.now(); }

  // Gửi Telegram trừ khi một trong các loại bị tắt hoặc đang tạm tắt tất cả
  notify(types, html) {
    if (this.snoozed || types.some(t => this.muted[t])) return false;
    this.tg.send(html);
    return true;
  }

  log(level, title, detail, category, type, sent) {
    this.events.unshift({ t: Date.now(), level, title, detail: detail || '', category: category || 'system', type: type || 'other', sent: sent !== false });
    if (this.events.length > 300) this.events.length = 300;
  }

  // Cảnh báo có trạng thái (RAM, disk...): báo khi xấu đi, báo khi hồi phục, nhắc lại định kỳ
  set(key, level, title, detail, category) {
    const cur = this.active.get(key);
    const now = Date.now();
    const type = this.typeOf(key);
    if (level === 'ok') {
      if (cur) {
        this.active.delete(key);
        const msg = `${title || cur.title}: đã trở lại bình thường`;
        const sent = this.notify([type, 'recovery'], this.format('ok', msg, detail));
        this.log('ok', msg, detail, category, type, sent);
      }
      return;
    }
    if (!cur || LEVELS[level] > LEVELS[cur.level]) {
      this.active.set(key, { key, level, title, detail, category, type, since: cur ? cur.since : now, lastNotified: now });
      const sent = this.notify([type], this.format(level, title, detail));
      this.log(level, title, detail, category, type, sent);
      return;
    }
    cur.detail = detail;
    cur.title = title;
    if (LEVELS[level] < LEVELS[cur.level]) cur.level = level;
    const repeat = this.cfg.notify.repeatMin * 60000;
    if (repeat > 0 && now - cur.lastNotified > repeat) {
      cur.lastNotified = now;
      this.notify([type, 'repeat'], this.format(cur.level, `(Vẫn chưa xử lý) ${title}`, detail));
    }
  }

  // Sự kiện một lần (container mới, đăng nhập SSH...) có cooldown theo key
  fire(key, level, title, detail, category, cooldownMs = 0, notify = true) {
    const now = Date.now();
    if (cooldownMs && this.cooldowns.has(key) && now - this.cooldowns.get(key) < cooldownMs) return false;
    this.cooldowns.set(key, now);
    const type = this.typeOf(key);
    const sent = notify ? this.notify([type], this.format(level, title, detail)) : false;
    this.log(level, title, detail, category, type, sent);
    return true;
  }

  // Đếm số mẫu liên tiếp thỏa điều kiện
  sustain(key, cond) {
    const n = cond ? (this.counters.get(key) || 0) + 1 : 0;
    this.counters.set(key, n);
    return n;
  }

  get samplesPerMin() { return 60 / this.cfg.intervalSec; }

  checkSystem(s) {
    if (!s.ready) return;
    const th = this.cfg.th;

    // RAM (cần 2 mẫu liên tiếp để tránh đỉnh nhọn)
    const ramLevel = s.mem.pct >= th.ramCrit ? 'critical' : s.mem.pct >= th.ramWarn ? 'warning' : 'ok';
    const ramN = this.sustain('ram', ramLevel !== 'ok');
    const ramActive = this.active.get('ram');
    const ramDetail = `RAM dùng ${pct(s.mem.pct)} (${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}), còn trống ${fmtBytes(s.mem.available)}.\nTop RAM: ${s.procs.byMem.slice(0, 3).map(p => `${p.name} ${fmtBytes(p.rss)}`).join(', ')}`;
    if (ramLevel !== 'ok' && ramN >= 2) this.set('ram', ramLevel, `RAM sắp đầy: ${pct(s.mem.pct)}`, ramDetail, 'ram');
    else if (ramActive && s.mem.pct < th.ramWarn - 5) this.set('ram', 'ok', 'RAM', `RAM hiện ${pct(s.mem.pct)}`, 'ram');

    // Swap
    if (s.mem.swapTotal > 0) {
      if (s.mem.swapPct >= th.swapWarn) this.set('swap', 'warning', `Swap dùng nhiều: ${pct(s.mem.swapPct)}`, `${fmtBytes(s.mem.swapUsed)} / ${fmtBytes(s.mem.swapTotal)} — máy đang thiếu RAM, có thể chậm.`, 'ram');
      else if (s.mem.swapPct < th.swapWarn - 10) this.set('swap', 'ok', 'Swap', `Swap hiện ${pct(s.mem.swapPct)}`, 'ram');
    }

    // OOM killer
    if (s.oomKills != null) {
      if (this.prevOom != null && s.oomKills > this.prevOom) {
        this.fire('oom', 'critical', `Kernel OOM killer vừa giết ${s.oomKills - this.prevOom} tiến trình`, 'Hết RAM nghiêm trọng — kiểm tra container/tiến trình nào bị dừng.', 'ram');
      }
      this.prevOom = s.oomKills;
    }

    // Disk + inode
    const seenFs = new Set();
    for (const f of s.fs) {
      const key = `disk:${f.mount}`;
      seenFs.add(key);
      const lvl = f.pct >= th.diskCrit ? 'critical' : f.pct >= th.diskWarn ? 'warning' : 'ok';
      const detail = `Ổ ${f.mount} (${f.device}) dùng ${pct(f.pct)}: ${fmtBytes(f.used)} / ${fmtBytes(f.total)}, còn ${fmtBytes(f.avail)}.`;
      if (lvl !== 'ok') this.set(key, lvl, `Ổ đĩa ${f.mount} sắp đầy: ${pct(f.pct)}`, detail, 'disk');
      else if (f.pct < th.diskWarn - 3) this.set(key, 'ok', `Ổ đĩa ${f.mount}`, detail, 'disk');
      const ikey = `inode:${f.mount}`;
      if (f.inodePct >= th.inodeWarn) this.set(ikey, 'warning', `Hết inode trên ${f.mount}: ${pct(f.inodePct)}`, 'Quá nhiều file nhỏ — dù còn dung lượng vẫn không tạo được file mới.', 'disk');
      else if (f.inodePct < th.inodeWarn - 5) this.set(ikey, 'ok', `Inode ${f.mount}`, '', 'disk');
    }

    // CPU duy trì cao
    const cpuNeed = Math.max(1, Math.round(th.cpuSustainMin * this.samplesPerMin));
    const cpuN = this.sustain('cpu', s.cpu.usage >= th.cpuWarn);
    const top = s.procs.byCpu.slice(0, 3).map(p => `${p.name} ${p.cpu.toFixed(0)}%`).join(', ');
    if (cpuN >= cpuNeed) this.set('cpu', 'warning', `CPU cao liên tục ${th.cpuSustainMin} phút: ${pct(s.cpu.usage)}`, `Top CPU: ${top}`, 'cpu');
    else if (s.cpu.usage < th.cpuWarn - 15) this.set('cpu', 'ok', 'CPU', `CPU hiện ${pct(s.cpu.usage)}`, 'cpu');

    // Load
    const perCore = s.load[1] / Math.max(1, s.cpu.count);
    if (perCore >= th.loadPerCore) this.set('load', 'warning', `Load cao: ${s.load[1].toFixed(2)} (${s.cpu.count} nhân)`, `Load 1/5/15 phút: ${s.load.map(x => x.toFixed(2)).join(' / ')}. Top CPU: ${top}`, 'cpu');
    else if (perCore < th.loadPerCore * 0.7) this.set('load', 'ok', 'Load', `Load hiện ${s.load[1].toFixed(2)}`, 'cpu');

    // I/O wait & steal (VPS bị "hàng xóm" chiếm CPU)
    const twoMin = 2 * this.samplesPerMin;
    if (this.sustain('iowait', s.cpu.iowait >= th.iowaitWarn) >= twoMin) this.set('iowait', 'warning', `Ổ đĩa nghẽn: I/O wait ${pct(s.cpu.iowait)}`, `Đọc ${fmtBytes(s.io.rd)}/s, ghi ${fmtBytes(s.io.wr)}/s, disk bận ${pct(s.io.util)}`, 'disk');
    else if (s.cpu.iowait < th.iowaitWarn / 2) this.set('iowait', 'ok', 'I/O wait', '', 'disk');
    if (this.sustain('steal', s.cpu.steal >= th.stealWarn) >= twoMin) this.set('steal', 'warning', `CPU steal cao: ${pct(s.cpu.steal)}`, 'Nhà cung cấp VPS đang chia CPU cho máy khác — hiệu năng bị giảm.', 'cpu');
    else if (s.cpu.steal < th.stealWarn / 2) this.set('steal', 'ok', 'CPU steal', '', 'cpu');

    // Tiến trình ngốn CPU lâu (nghi đào coin)
    const procNeed = Math.round(th.procCpuSustainMin * this.samplesPerMin);
    const hot = new Set();
    for (const p of s.procs.all) {
      if (p.cpu < th.procCpuWarn) continue;
      const k = `proc:${p.pid}`;
      hot.add(k);
      if (this.sustain(k, true) === procNeed) {
        const full = s.procs.byCpu.find(x => x.pid === p.pid);
        this.fire(k, 'warning', `Tiến trình "${p.name}" (PID ${p.pid}) dùng ${p.cpu.toFixed(0)}% CPU suốt ${th.procCpuSustainMin} phút`,
          `${full ? `User: ${full.user}\nLệnh: ${full.cmd}\n` : ''}Nếu không phải tiến trình của bạn, có thể là mã độc đào coin.`, 'security', 6 * 3600000);
      }
    }
    for (const k of this.counters.keys()) if (k.startsWith('proc:') && !hot.has(k)) this.counters.delete(k);

    // Zombie
    if (s.procs.zombies >= 20) this.set('zombie', 'warning', `${s.procs.zombies} tiến trình zombie`, 'Có tiến trình cha không thu dọn tiến trình con.', 'cpu');
    else if (s.procs.zombies < 10) this.set('zombie', 'ok', 'Zombie', '', 'cpu');

    this.checkNetwork(s);
  }

  checkNetwork(s) {
    const th = this.cfg.th;
    const syn = s.tcp.states.SYN_RECV || 0;
    if (syn >= th.synRecv) this.set('synflood', 'critical', `Nghi bị SYN flood: ${syn} kết nối SYN_RECV`, `Top IP: ${s.tcp.topIps.slice(0, 5).map(x => `${x.ip} (${x.count})`).join(', ')}`, 'security');
    else if (syn < th.synRecv / 2) this.set('synflood', 'ok', 'SYN flood', `SYN_RECV hiện ${syn}`, 'security');

    for (const x of s.tcp.topIps) {
      if (x.count >= th.connPerIp) {
        this.fire(`conn:${x.ip}`, 'warning', `IP ${x.ip} mở ${x.count} kết nối cùng lúc`, 'Có thể là DDoS/crawler. Cân nhắc chặn: ufw deny from ' + x.ip, 'security', 3600000);
      }
    }

    // Cổng mới mở (không tính cổng chỉ nghe trên localhost)
    const ports = new Map(s.tcp.listening.filter(l => !l.local).map(l => [l.port, l]));
    const known = new Set(this.state.knownPorts || []);
    if (this.prevPorts === null && !this.state.knownPorts) {
      this.state.knownPorts = [...ports.keys()];
    } else {
      for (const [port, l] of ports) {
        if (known.has(port)) continue;
        known.add(port);
        this.fire(`port:${port}`, 'warning', `Cổng mới được mở ra Internet: ${port}`, `Địa chỉ: ${l.addrs.join(', ')}${l.process ? `\nTiến trình: ${l.process}` : ''}\nNếu bạn không mở cổng này, hãy kiểm tra ngay.`, 'security', 0, this.cfg.notify.newPort);
      }
      if (this.prevPorts) {
        for (const port of this.prevPorts) if (!ports.has(port)) this.log('info', `Cổng ${port} đã đóng`, '', 'security');
      }
      this.state.knownPorts = [...known].slice(-500);
    }
    this.prevPorts = [...ports.keys()];
  }

  checkContainers(list) {
    if (!list) return;
    const th = this.cfg.th;
    const prev = this.prevContainers;
    const byId = new Map(list.map(c => [c.id, c]));
    const knownIds = new Set(this.state.knownContainers || []);
    const firstRun = prev === null;

    for (const c of list) {
      const p = prev ? prev.get(c.id) : null;
      const isNew = firstRun ? (this.state.knownContainers && !knownIds.has(c.id)) : !p;
      if (isNew) {
        this.fire(`cnew:${c.id}`, 'info', `Có container mới: ${c.name}`,
          `Image: ${c.image}\nTrạng thái: ${c.status}${c.ports.length ? `\nCổng: ${c.ports.join(', ')}` : ''}${c.compose ? `\nCompose: ${c.compose}` : ''}`, 'docker');
        if (/xmrig|miner|monero|kinsing|kdevtmpfsi/i.test(c.image + ' ' + c.name)) {
          this.fire(`cmal:${c.id}`, 'critical', `Container nghi là mã độc đào coin: ${c.name}`, `Image: ${c.image}\nXóa ngay: docker rm -f ${c.shortId}`, 'security');
        }
      }
      if (p) {
        if (p.state === 'running' && c.state !== 'running' && c.state !== 'restarting') {
          const bad = c.exitCode !== 0 || c.oomKilled;
          if (bad || this.cfg.notify.containerStop) {
            this.fire(`cstop:${c.id}:${c.startedAt}`, bad ? 'critical' : 'warning',
              `Container ${c.name} đã dừng${c.oomKilled ? ' (hết RAM - OOM)' : bad ? ` (exit code ${c.exitCode})` : ''}`,
              `Image: ${c.image}\nTrạng thái: ${c.status}\nXem log: docker logs --tail 50 ${c.name}`, 'docker');
          }
        }
        if (p.state !== 'running' && c.state === 'running' && this.active.has(`cdown:${c.id}`)) {
          this.set(`cdown:${c.id}`, 'ok', `Container ${c.name}`, 'Đã chạy lại', 'docker');
        }
        if (c.restartCount > p.restartCount) {
          this.fire(`crestart:${c.id}`, 'warning', `Container ${c.name} tự khởi động lại (${c.restartCount} lần)`,
            `Có thể đang crash liên tục.\nXem log: docker logs --tail 50 ${c.name}`, 'docker', 15 * 60000);
        }
        if (c.health === 'unhealthy' && p.health !== 'unhealthy') {
          this.set(`chealth:${c.id}`, 'critical', `Container ${c.name} không khỏe (unhealthy)`, `Image: ${c.image}`, 'docker');
        } else if (c.health === 'healthy' && this.active.has(`chealth:${c.id}`)) {
          this.set(`chealth:${c.id}`, 'ok', `Container ${c.name}`, 'Đã healthy trở lại', 'docker');
        }
      }
      if (c.state === 'restarting') {
        this.set(`cdown:${c.id}`, 'critical', `Container ${c.name} đang restart liên tục`, `Xem log: docker logs --tail 50 ${c.name}`, 'docker');
      }
      if (c.memPct != null && c.memLimit && c.memLimit < 1e15) {
        if (c.memPct >= th.containerMemWarn) this.set(`cmem:${c.id}`, 'warning', `Container ${c.name} gần chạm giới hạn RAM: ${pct(c.memPct)}`, `${fmtBytes(c.memUsage)} / ${fmtBytes(c.memLimit)}`, 'docker');
        else if (c.memPct < th.containerMemWarn - 10) this.set(`cmem:${c.id}`, 'ok', `RAM container ${c.name}`, '', 'docker');
      }
    }
    if (prev) {
      for (const [id, p] of prev) {
        if (byId.has(id)) continue;
        this.fire(`crm:${id}`, 'info', `Container đã bị xóa: ${p.name}`, `Image: ${p.image}`, 'docker');
        for (const k of [...this.active.keys()]) if (k.endsWith(':' + id)) this.active.delete(k);
      }
    }
    this.prevContainers = byId;
    this.state.knownContainers = list.map(c => c.id);
  }

  onAuthEvent(ev, watcher) {
    const th = this.cfg.th;
    if (ev.type === 'fail') {
      const win = watcher.failsSince(th.sshWindowMin * 60000);
      const fromIp = win.filter(f => f.ip === ev.ip);
      if (fromIp.length >= th.sshFailPerIp) {
        const users = [...new Set(fromIp.map(f => f.user).filter(Boolean))].slice(0, 6).join(', ');
        this.fire(`sship:${ev.ip}`, 'warning', `Nghi brute-force SSH từ ${ev.ip}`,
          `${fromIp.length} lần đăng nhập sai trong ${th.sshWindowMin} phút.${users ? `\nThử user: ${users}` : ''}\nChặn: ufw deny from ${ev.ip}  (hoặc cài fail2ban)`, 'security', 3600000);
      }
      if (win.length >= th.sshFailTotal) {
        const ips = new Set(win.map(f => f.ip)).size;
        this.fire('sshtotal', 'critical', `Đang bị tấn công SSH: ${win.length} lần thử sai / ${th.sshWindowMin} phút`,
          `Từ ${ips} IP khác nhau.\nNên: tắt đăng nhập bằng mật khẩu (PasswordAuthentication no), đổi cổng SSH, cài fail2ban.`, 'security', 3600000);
      }
    } else if (ev.type === 'login') {
      const knownIps = new Set(this.state.sshIps || []);
      const isNewIp = !knownIps.has(ev.ip);
      knownIps.add(ev.ip);
      this.state.sshIps = [...knownIps].slice(-200);
      this.fire(`login:${ev.user}:${ev.ip}:${Date.now()}`, isNewIp ? 'warning' : 'info',
        `Đăng nhập SSH: ${ev.user} từ ${ev.ip}${isNewIp ? ' (IP lạ, lần đầu thấy)' : ''}`,
        `Phương thức: ${ev.method}\nNếu không phải bạn: đổi mật khẩu/khóa SSH ngay.`, 'security', 0, this.cfg.notify.sshLogin || isNewIp);
    } else if (ev.type === 'newuser') {
      this.fire(`newuser:${ev.user}:${Date.now()}`, 'critical', `Tài khoản hệ thống mới được tạo: ${ev.user}`, 'Nếu không phải bạn tạo, máy có thể đã bị xâm nhập.', 'security');
    } else if (ev.type === 'sudoers') {
      this.fire(`sudoers:${ev.user}:${Date.now()}`, 'critical', `User ${ev.user} được thêm vào nhóm ${ev.group}`, 'Quyền quản trị vừa được cấp — kiểm tra nếu không phải bạn làm.', 'security');
    } else if (ev.type === 'passwd') {
      this.fire(`passwd:${ev.user}:${Date.now()}`, 'warning', `Mật khẩu của ${ev.user} vừa bị đổi`, '', 'security');
    }
  }

  // Sự cố một lần (tấn công, container crash...) trong 1 giờ qua
  recent(ms = 3600000) {
    const cut = Date.now() - ms;
    return this.events.filter(e => e.t >= cut && (e.level === 'warning' || e.level === 'critical'));
  }

  overall() {
    let lvl = 'ok';
    for (const a of this.active.values()) if (LEVELS[a.level] > LEVELS[lvl]) lvl = a.level;
    for (const e of this.recent()) if (LEVELS[e.level] > LEVELS[lvl]) lvl = e.level;
    return lvl;
  }

  settings() {
    return {
      types: TYPES.map(({ id, group, label }) => ({ id, group, label })),
      muted: this.muted,
      snoozeUntil: this.snoozed ? this.state.snoozeUntil : 0,
    };
  }

  updateSettings(body) {
    if (body && body.muted && typeof body.muted === 'object') {
      for (const t of TYPES) if (t.id in body.muted) {
        if (body.muted[t.id]) this.muted[t.id] = true; else delete this.muted[t.id];
      }
    }
    if (body && body.snoozeMinutes !== undefined) {
      const m = Math.max(0, Math.min(7 * 24 * 60, Number(body.snoozeMinutes) || 0));
      this.state.snoozeUntil = m ? Date.now() + m * 60000 : 0;
    }
    return this.settings();
  }

  list() {
    return [...this.active.values()].sort((a, b) => LEVELS[b.level] - LEVELS[a.level] || b.since - a.since);
  }
}

module.exports = { AlertEngine, fmtBytes, pct, LEVELS, ICON, TYPES };
