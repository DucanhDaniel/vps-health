'use strict';
// Thu thập số liệu hệ thống trực tiếp từ /proc — không cần lệnh ngoài.
const fs = require('fs');
const path = require('path');

const CLK_TCK = 100;
const PAGE_SIZE = 4096;
const REAL_FS = new Set(['ext2', 'ext3', 'ext4', 'xfs', 'btrfs', 'zfs', 'vfat', 'f2fs', 'jfs', 'reiserfs', 'ntfs', 'ntfs3', 'exfat', 'fuseblk']);
const DISK_RE = /^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;
const IGNORE_IFACE_RE = /^(lo|veth|docker|br-|virbr|cni|flannel|cali|vxlan)/;
const TCP_STATES = { '01': 'ESTABLISHED', '02': 'SYN_SENT', '03': 'SYN_RECV', '04': 'FIN_WAIT1', '05': 'FIN_WAIT2', '06': 'TIME_WAIT', '07': 'CLOSE', '08': 'CLOSE_WAIT', '09': 'LAST_ACK', '0A': 'LISTEN', '0B': 'CLOSING' };

function readSafe(f) {
  try { return fs.readFileSync(f, 'utf8'); } catch { return null; }
}

function hexToIPv4(h) {
  return [3, 2, 1, 0].map(i => parseInt(h.substr(i * 2, 2), 16)).join('.');
}

function hexToIPv6(h) {
  // 4 nhóm 32-bit, mỗi nhóm little-endian
  const bytes = [];
  for (let g = 0; g < 4; g++) {
    const word = h.substr(g * 8, 8);
    for (let i = 3; i >= 0; i--) bytes.push(parseInt(word.substr(i * 2, 2), 16));
  }
  if (bytes.slice(0, 10).every(b => b === 0) && bytes[10] === 255 && bytes[11] === 255) {
    return bytes.slice(12).join('.');
  }
  const parts = [];
  for (let i = 0; i < 16; i += 2) parts.push((bytes[i] << 8) | bytes[i + 1]);
  // Rút gọn chuỗi số 0 dài nhất thành "::"
  let best = -1, bestLen = 1;
  for (let i = 0; i < 8;) {
    if (parts[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && parts[j] === 0) j++;
    if (j - i > bestLen) { best = i; bestLen = j - i; }
    i = j;
  }
  const hex = parts.map(x => x.toString(16));
  if (best < 0) return hex.join(':');
  return hex.slice(0, best).join(':') + '::' + hex.slice(best + bestLen).join(':');
}

function isLocalIp(ip) {
  return ip === '::1' || ip === '::' || ip === '0.0.0.0' || ip.startsWith('127.');
}

class SystemCollector {
  constructor(cfg) {
    this.cfg = cfg;
    this.prev = null;
    this.prevProc = new Map();
    this.uidNames = null;
    this.uidLoaded = 0;
    this.listenOwners = new Map();
    this.listenOwnersAt = 0;
    this.listenKeyCache = '';
  }

  p(...parts) { return path.join(this.cfg.procPath, ...parts); }
  h(p) { return path.join(this.cfg.hostRoot || '/', p); }

  static() {
    const osr = readSafe(this.h('etc/os-release')) || '';
    const pretty = (osr.match(/^PRETTY_NAME="?([^"\n]*)"?/m) || [])[1] || 'Linux';
    const cpuinfo = readSafe(this.p('cpuinfo')) || '';
    const model = (cpuinfo.match(/^model name\s*:\s*(.*)$/m) || [])[1] || '';
    return {
      os: pretty,
      kernel: (readSafe(this.p('sys/kernel/osrelease')) || '').trim(),
      cpuModel: model.trim(),
    };
  }

  readCpu() {
    const out = { total: null, cores: [] };
    const txt = readSafe(this.p('stat')) || '';
    for (const line of txt.split('\n')) {
      if (!line.startsWith('cpu')) continue;
      const parts = line.trim().split(/\s+/);
      const v = parts.slice(1, 9).map(Number); // user nice system idle iowait irq softirq steal
      const rec = { all: v.reduce((a, b) => a + b, 0), idle: v[3] + v[4], iowait: v[4], steal: v[7] };
      if (parts[0] === 'cpu') out.total = rec; else out.cores.push(rec);
    }
    const ctxt = txt.match(/^procs_running\s+(\d+)/m);
    out.running = ctxt ? Number(ctxt[1]) : 0;
    return out;
  }

  readMem() {
    const txt = readSafe(this.p('meminfo')) || '';
    const m = {};
    for (const line of txt.split('\n')) {
      const r = line.match(/^(\w+):\s+(\d+)/);
      if (r) m[r[1]] = Number(r[2]) * 1024;
    }
    const total = m.MemTotal || 0;
    const avail = m.MemAvailable != null ? m.MemAvailable : (m.MemFree || 0) + (m.Cached || 0) + (m.Buffers || 0);
    const swapTotal = m.SwapTotal || 0;
    const swapUsed = swapTotal - (m.SwapFree || 0);
    return {
      total, available: avail, used: total - avail,
      pct: total ? ((total - avail) / total) * 100 : 0,
      cached: (m.Cached || 0) + (m.Buffers || 0),
      swapTotal, swapUsed,
      swapPct: swapTotal ? (swapUsed / swapTotal) * 100 : 0,
    };
  }

  readNet() {
    const txt = readSafe(this.p('net/dev')) || '';
    const ifaces = [];
    for (const line of txt.split('\n').slice(2)) {
      const [name, rest] = line.split(':');
      if (!rest) continue;
      const n = name.trim();
      const f = rest.trim().split(/\s+/).map(Number);
      ifaces.push({ name: n, rx: f[0], tx: f[8], ignored: IGNORE_IFACE_RE.test(n) });
    }
    return ifaces;
  }

  readDiskStats() {
    const txt = readSafe(this.p('diskstats')) || '';
    const disks = [];
    for (const line of txt.split('\n')) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14 || !DISK_RE.test(f[2])) continue;
      disks.push({ name: f[2], rd: Number(f[5]) * 512, wr: Number(f[9]) * 512, ioMs: Number(f[12]) });
    }
    return disks;
  }

  readFilesystems() {
    const root = this.cfg.hostRoot;
    const txt = readSafe('/proc/self/mounts') || '';
    const seen = new Map();
    for (const line of txt.split('\n')) {
      const f = line.split(' ');
      if (f.length < 3 || !REAL_FS.has(f[2])) continue;
      let mp = f[1].replace(/\\040/g, ' ');
      if (root) {
        if (mp !== root && !mp.startsWith(root + '/')) continue;
        mp = mp.slice(root.length) || '/';
      }
      if (/^\/(snap|var\/lib\/docker|run\/docker)/.test(mp)) continue;
      const dev = f[0];
      const prevEntry = seen.get(dev);
      if (prevEntry && prevEntry.mount.length <= mp.length) continue;
      seen.set(dev, { device: dev, mount: mp, fstype: f[2] });
    }
    const out = [];
    for (const fsEntry of seen.values()) {
      try {
        const s = fs.statfsSync(path.join(root || '/', fsEntry.mount));
        const total = s.blocks * s.bsize;
        const used = (s.blocks - s.bfree) * s.bsize;
        const avail = s.bavail * s.bsize;
        if (!total) continue;
        out.push({
          ...fsEntry, total, used, avail,
          pct: (used / (used + avail)) * 100,
          inodePct: s.files ? ((s.files - s.ffree) / s.files) * 100 : 0,
        });
      } catch { /* bỏ qua mount không đọc được */ }
    }
    return out.sort((a, b) => a.mount.localeCompare(b.mount));
  }

  readTcp() {
    const states = {};
    const perIp = new Map();
    const listen = [];
    const listenInodes = new Map();
    for (const [file, v6] of [['net/tcp', false], ['net/tcp6', true]]) {
      const txt = readSafe(this.p(file));
      if (!txt) continue;
      const lines = txt.split('\n');
      for (let i = 1; i < lines.length; i++) {
        const f = lines[i].trim().split(/\s+/);
        if (f.length < 10) continue;
        const st = TCP_STATES[f[3]] || f[3];
        states[st] = (states[st] || 0) + 1;
        if (st === 'LISTEN') {
          const [lh, lp] = f[1].split(':');
          const addr = v6 ? hexToIPv6(lh) : hexToIPv4(lh);
          const port = parseInt(lp, 16);
          listen.push({ addr, port, v6, inode: f[9] });
          listenInodes.set(f[9], true);
        } else if (st === 'ESTABLISHED' || st === 'SYN_RECV') {
          const [rh] = f[2].split(':');
          const ip = v6 ? hexToIPv6(rh) : hexToIPv4(rh);
          if (isLocalIp(ip)) continue;
          perIp.set(ip, (perIp.get(ip) || 0) + 1);
        }
      }
    }
    // Gộp các cổng nghe trùng (v4+v6)
    const ports = new Map();
    for (const l of listen) {
      const local = isLocalIp(l.addr) && l.addr !== '0.0.0.0' && l.addr !== '::';
      const key = `${l.port}${local ? ':local' : ''}`;
      const e = ports.get(key) || { port: l.port, addrs: [], local, inodes: [] };
      if (!e.addrs.includes(l.addr)) e.addrs.push(l.addr);
      e.inodes.push(l.inode);
      ports.set(key, e);
    }
    const topIps = [...perIp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([ip, count]) => ({ ip, count }));
    return { states, topIps, listening: [...ports.values()].sort((a, b) => a.port - b.port) };
  }

  // Map socket inode -> tên tiến trình (quét /proc/*/fd, chỉ chạy khi danh sách cổng đổi hoặc mỗi 60s)
  resolveListenOwners(listening) {
    const key = listening.map(l => l.port).join(',');
    if (key === this.listenKeyCache && Date.now() - this.listenOwnersAt < 60000) return;
    this.listenKeyCache = key;
    this.listenOwnersAt = Date.now();
    const want = new Set(listening.flatMap(l => l.inodes));
    const owners = new Map();
    let pids = [];
    try { pids = fs.readdirSync(this.cfg.procPath).filter(d => /^\d+$/.test(d)); } catch { return; }
    for (const pid of pids) {
      let fds;
      try { fds = fs.readdirSync(this.p(pid, 'fd')); } catch { continue; }
      for (const fd of fds) {
        let link;
        try { link = fs.readlinkSync(this.p(pid, 'fd', fd)); } catch { continue; }
        const m = link.match(/^socket:\[(\d+)\]$/);
        if (m && want.has(m[1]) && !owners.has(m[1])) {
          const comm = (readSafe(this.p(pid, 'comm')) || '?').trim();
          owners.set(m[1], `${comm} (${pid})`);
        }
      }
    }
    this.listenOwners = owners;
  }

  loadUids() {
    if (this.uidNames && Date.now() - this.uidLoaded < 300000) return;
    this.uidNames = new Map();
    this.uidLoaded = Date.now();
    const txt = readSafe(this.h('etc/passwd')) || '';
    for (const line of txt.split('\n')) {
      const f = line.split(':');
      if (f.length > 2) this.uidNames.set(f[2], f[0]);
    }
  }

  readProcesses(dtSec) {
    let pids = [];
    try { pids = fs.readdirSync(this.cfg.procPath).filter(d => /^\d+$/.test(d)); } catch { return { list: [], count: 0, zombies: 0 }; }
    const cur = new Map();
    const list = [];
    let zombies = 0;
    for (const pid of pids) {
      const st = readSafe(this.p(pid, 'stat'));
      if (!st) continue;
      const close = st.lastIndexOf(')');
      const comm = st.slice(st.indexOf('(') + 1, close);
      const f = st.slice(close + 2).split(' ');
      const state = f[0];
      if (state === 'Z') zombies++;
      const ticks = Number(f[11]) + Number(f[12]);
      const rss = Number(f[21]) * PAGE_SIZE;
      const startKey = f[19];
      cur.set(pid, { ticks, startKey });
      const prev = this.prevProc.get(pid);
      let cpu = 0;
      if (prev && prev.startKey === startKey && dtSec > 0) cpu = ((ticks - prev.ticks) / CLK_TCK / dtSec) * 100;
      if (Number(f[1]) === 2 || pid === '2') continue; // bỏ kernel thread kthreadd
      if (rss === 0 && cpu === 0) continue; // kernel threads
      list.push({ pid: Number(pid), name: comm, state, cpu, rss });
    }
    this.prevProc = cur;
    const byCpu = [...list].sort((a, b) => b.cpu - a.cpu).slice(0, 10);
    const byMem = [...list].sort((a, b) => b.rss - a.rss).slice(0, 10);
    this.loadUids();
    const enrich = p => {
      if (p.cmd !== undefined) return p;
      const cmd = (readSafe(this.p(String(p.pid), 'cmdline')) || '').replace(/\0/g, ' ').trim();
      const status = readSafe(this.p(String(p.pid), 'status')) || '';
      const uid = (status.match(/^Uid:\s+(\d+)/m) || [])[1];
      p.cmd = cmd.slice(0, 160) || `[${p.name}]`;
      p.user = this.uidNames.get(uid) || uid || '?';
      return p;
    };
    byCpu.forEach(enrich);
    byMem.forEach(enrich);
    return { count: pids.length, zombies, byCpu, byMem, all: list };
  }

  readOomKills() {
    const txt = readSafe(this.p('vmstat')) || '';
    const m = txt.match(/^oom_kill\s+(\d+)/m);
    return m ? Number(m[1]) : null;
  }

  collect() {
    const now = Date.now();
    const cpuRaw = this.readCpu();
    const net = this.readNet();
    const disks = this.readDiskStats();
    const prev = this.prev;
    const dt = prev ? (now - prev.t) / 1000 : 0;

    const pctOf = (a, b) => {
      if (!a || !b) return 0;
      const all = a.all - b.all;
      return all > 0 ? { usage: (1 - (a.idle - b.idle) / all) * 100, iowait: ((a.iowait - b.iowait) / all) * 100, steal: ((a.steal - b.steal) / all) * 100 } : { usage: 0, iowait: 0, steal: 0 };
    };
    const cpuT = prev ? pctOf(cpuRaw.total, prev.cpu.total) : { usage: 0, iowait: 0, steal: 0 };
    const cores = prev ? cpuRaw.cores.map((c, i) => pctOf(c, prev.cpu.cores[i]).usage || 0) : cpuRaw.cores.map(() => 0);

    let rx = 0, tx = 0;
    const ifaces = [];
    for (const n of net) {
      const p = prev && prev.net.find(x => x.name === n.name);
      const r = p && dt ? Math.max(0, (n.rx - p.rx) / dt) : 0;
      const t = p && dt ? Math.max(0, (n.tx - p.tx) / dt) : 0;
      if (!n.ignored) { rx += r; tx += t; ifaces.push({ name: n.name, rx: r, tx: t, rxTotal: n.rx, txTotal: n.tx }); }
    }

    let rd = 0, wr = 0, ioUtil = 0;
    for (const d of disks) {
      const p = prev && prev.disks.find(x => x.name === d.name);
      if (!p || !dt) continue;
      rd += Math.max(0, (d.rd - p.rd) / dt);
      wr += Math.max(0, (d.wr - p.wr) / dt);
      ioUtil = Math.max(ioUtil, Math.min(100, ((d.ioMs - p.ioMs) / (dt * 1000)) * 100));
    }

    const loadTxt = (readSafe(this.p('loadavg')) || '0 0 0').split(' ');
    const uptime = Number((readSafe(this.p('uptime')) || '0').split(' ')[0]);
    const mem = this.readMem();
    const fsList = this.readFilesystems();
    const tcp = this.readTcp();
    this.resolveListenOwners(tcp.listening);
    for (const l of tcp.listening) {
      l.process = l.inodes.map(i => this.listenOwners.get(i)).find(Boolean) || '';
      delete l.inodes;
    }
    const procs = this.readProcesses(dt);

    this.prev = { t: now, cpu: cpuRaw, net, disks };

    return {
      t: now,
      ready: !!prev,
      cpu: { usage: cpuT.usage, iowait: cpuT.iowait, steal: cpuT.steal, cores, count: cpuRaw.cores.length },
      load: [Number(loadTxt[0]), Number(loadTxt[1]), Number(loadTxt[2])],
      uptime,
      mem,
      net: { rx, tx, ifaces },
      io: { rd, wr, util: ioUtil },
      fs: fsList,
      tcp,
      procs,
      oomKills: this.readOomKills(),
    };
  }
}

module.exports = { SystemCollector, isLocalIp, hexToIPv4, hexToIPv6 };
