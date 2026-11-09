'use strict';
// Đọc trạng thái Docker qua unix socket — không cần docker CLI.
const http = require('http');
const fs = require('fs');

function request(socketPath, urlPath, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: urlPath, method: 'GET', timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => { body += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`Docker API ${res.statusCode}: ${body.slice(0, 200)}`));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Docker API timeout')));
    req.on('error', reject);
    req.end();
  });
}

class DockerCollector {
  constructor(cfg) {
    this.cfg = cfg;
    this.prevStats = new Map();
    this.available = false;
    this.error = '';
    this.containers = [];
    this.lastInspect = new Map();
  }

  exists() {
    try { return fs.statSync(this.cfg.dockerSocket).isSocket(); } catch { return false; }
  }

  async collect() {
    if (!this.exists()) {
      this.available = false;
      this.error = `Không thấy Docker socket tại ${this.cfg.dockerSocket}`;
      this.containers = [];
      return null;
    }
    const sock = this.cfg.dockerSocket;
    let list;
    try {
      list = await request(sock, '/containers/json?all=1');
    } catch (e) {
      this.available = false;
      this.error = e.message;
      return null;
    }
    this.available = true;
    this.error = '';

    const out = await Promise.all(list.map(async c => {
      const name = (c.Names && c.Names[0] || c.Id.slice(0, 12)).replace(/^\//, '');
      const item = {
        id: c.Id,
        shortId: c.Id.slice(0, 12),
        name,
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created * 1000,
        ports: (c.Ports || []).filter(p => p.PublicPort).map(p => `${p.IP && p.IP !== '0.0.0.0' && p.IP !== '::' ? p.IP + ':' : ''}${p.PublicPort}→${p.PrivatePort}/${p.Type}`)
          .filter((v, i, a) => a.indexOf(v) === i),
        compose: (c.Labels || {})['com.docker.compose.project'] || '',
        cpu: null, memUsage: null, memLimit: null, memPct: null, netRx: null, netTx: null,
        restartCount: 0, health: '', exitCode: null, oomKilled: false, startedAt: null,
      };

      // inspect: số lần restart, health, exit code
      try {
        const ins = await request(sock, `/containers/${c.Id}/json`, 3000);
        item.restartCount = ins.RestartCount || 0;
        item.health = (ins.State && ins.State.Health && ins.State.Health.Status) || '';
        item.exitCode = ins.State ? ins.State.ExitCode : null;
        item.oomKilled = !!(ins.State && ins.State.OOMKilled);
        item.startedAt = ins.State && ins.State.StartedAt ? Date.parse(ins.State.StartedAt) : null;
        item.restartPolicy = ins.HostConfig && ins.HostConfig.RestartPolicy ? ins.HostConfig.RestartPolicy.Name : '';
      } catch { /* container có thể vừa bị xóa */ }

      if (c.State === 'running') {
        try {
          const s = await request(sock, `/containers/${c.Id}/stats?stream=false&one-shot=true`, 4000);
          const cpuTotal = s.cpu_stats && s.cpu_stats.cpu_usage ? s.cpu_stats.cpu_usage.total_usage : 0;
          const sysTotal = s.cpu_stats ? s.cpu_stats.system_cpu_usage : 0;
          const ncpu = (s.cpu_stats && s.cpu_stats.online_cpus) || 1;
          const prev = this.prevStats.get(c.Id);
          if (prev && sysTotal > prev.sys) {
            item.cpu = Math.max(0, ((cpuTotal - prev.cpu) / (sysTotal - prev.sys)) * ncpu * 100);
          }
          this.prevStats.set(c.Id, { cpu: cpuTotal, sys: sysTotal });
          const ms = s.memory_stats || {};
          const cache = ms.stats ? (ms.stats.inactive_file != null ? ms.stats.inactive_file : ms.stats.cache || 0) : 0;
          if (ms.usage != null) {
            item.memUsage = Math.max(0, ms.usage - cache);
            item.memLimit = ms.limit || null;
            item.memPct = ms.limit ? (item.memUsage / ms.limit) * 100 : null;
          }
          if (s.networks) {
            item.netRx = 0; item.netTx = 0;
            for (const n of Object.values(s.networks)) { item.netRx += n.rx_bytes || 0; item.netTx += n.tx_bytes || 0; }
          }
        } catch { /* bỏ qua */ }
      }
      return item;
    }));

    const ids = new Set(out.map(c => c.id));
    for (const id of this.prevStats.keys()) if (!ids.has(id)) this.prevStats.delete(id);
    this.containers = out.sort((a, b) => a.name.localeCompare(b.name));
    return this.containers;
  }
}

module.exports = { DockerCollector };
