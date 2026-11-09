'use strict';
(() => {
  // ---------- tiện ích ----------
  const $ = id => document.getElementById(id);
  const SVGNS = 'http://www.w3.org/2000/svg';

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'style' && typeof v === 'object') { for (const [sk, sv] of Object.entries(v)) sk.startsWith('--') ? el.style.setProperty(sk, sv) : (el.style[sk] = sv); }
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  function s(tag, attrs, text) {
    const el = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
    if (text != null) el.textContent = text;
    return el;
  }

  const fmtBytes = b => {
    if (b == null || isNaN(b)) return '–';
    const u = ['B', 'KB', 'MB', 'GB', 'TB'];
    let i = 0;
    while (Math.abs(b) >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(b >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
  };
  const fmtRate = b => `${fmtBytes(b)}/s`;
  const fmtPct = v => (v == null || isNaN(v) ? '–' : `${v.toFixed(v >= 10 ? 0 : 1)}%`);
  const fmtNum = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(n >= 1e4 ? 0 : 1)}K` : String(Math.round(n * 100) / 100));
  const fmtDur = sec => {
    const d = Math.floor(sec / 86400), hh = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d ? `${d} ngày ${hh} giờ` : hh ? `${hh} giờ ${m} phút` : `${m} phút`;
  };
  const timeFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const timeSecFmt = new Intl.DateTimeFormat('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dateTimeFmt = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const ago = t => {
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'vừa xong';
    if (s < 3600) return `${Math.floor(s / 60)} phút trước`;
    if (s < 86400) return `${Math.floor(s / 3600)} giờ trước`;
    return dateTimeFmt.format(t);
  };

  const LV_LABEL = { ok: 'Ổn định', info: 'Thông tin', warning: 'Cảnh báo', critical: 'Nghiêm trọng', muted: '—' };
  const LV_ICON = { ok: '✓', info: 'i', warning: '!', critical: '‼', muted: '' };
  function pill(level, text) {
    return h('span', { class: `pill lv-${level}` }, h('span', { class: 'dot', 'aria-hidden': 'true' }), `${LV_ICON[level] ? LV_ICON[level] + ' ' : ''}${text || LV_LABEL[level]}`);
  }
  const lvlFor = (v, warn, crit) => (crit != null && v >= crit ? 'critical' : v >= warn ? 'warning' : 'ok');
  function meter(pctVal, level, small) {
    return h('div', { class: `meter${small ? ' sm' : ''} lv-${level}`, role: 'meter', 'aria-valuenow': Math.round(pctVal), 'aria-valuemin': 0, 'aria-valuemax': 100 },
      h('span', { style: { width: `${Math.max(0, Math.min(100, pctVal))}%` } }));
  }

  async function api(path, opts) {
    const r = await fetch(path, { cache: 'no-store', ...opts });
    if (!r.ok) throw new Error(`${r.status}`);
    return r.json();
  }

  // ---------- biểu đồ đường (crosshair + tooltip) ----------
  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw)));
    const n = raw / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
  }

  function lineChart(el, o) {
    const prevHeight = el.offsetHeight;
    el.textContent = '';
    if (o.series.length >= 2) {
      el.append(h('div', { class: 'legend' }, o.series.map(sr => h('span', {}, h('span', { class: 'key', style: { '--k': sr.color } }), sr.name))));
    }
    const box = h('div', { class: 'chart' });
    el.append(box);
    const W = box.clientWidth || 400, H = box.clientHeight || 200;
    const pad = { l: 46, r: 58, t: 10, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const t = o.times;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': o.label });
    box.append(svg);

    if (!t.length) {
      svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'Đang thu thập dữ liệu…'));
      if (prevHeight) el.style.minHeight = prevHeight + 'px';
      return;
    }
    let max = 0;
    for (const sr of o.series) for (const v of sr.values) if (v != null && v > max) max = v;
    if (o.ref) max = Math.max(max, o.ref.value);
    let yMax = o.yMax != null ? Math.max(o.yMax, max) : max || 1;
    const step = niceStep(yMax / 4);
    yMax = Math.ceil(yMax / step) * step || step;
    const t0 = t[0], t1 = t[t.length - 1] === t0 ? t0 + 1 : t[t.length - 1];
    const x = v => pad.l + ((v - t0) / (t1 - t0)) * iw;
    const y = v => pad.t + ih - (v / yMax) * ih;

    // lưới + trục Y
    for (let v = 0; v <= yMax + 1e-9; v += step) {
      svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: pad.l, x2: pad.l + iw, y1: y(v), y2: y(v) }));
      svg.append(s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, o.fmtAxis(v)));
    }
    // trục X: ~5 nhãn thời gian
    const nX = Math.max(2, Math.min(6, Math.floor(iw / 80)));
    for (let i = 0; i <= nX; i++) {
      const tv = t0 + ((t1 - t0) * i) / nX;
      svg.append(s('text', { x: x(tv), y: H - 5, 'text-anchor': i === 0 ? 'start' : i === nX ? 'end' : 'middle' }, timeFmt.format(tv)));
    }
    if (o.ref) {
      svg.append(s('line', { class: 'ref', x1: pad.l, x2: pad.l + iw, y1: y(o.ref.value), y2: y(o.ref.value) }));
      svg.append(s('text', { x: pad.l + 4, y: y(o.ref.value) - 4 }, o.ref.label));
    }

    // đường dữ liệu (ngắt đoạn nếu thiếu mẫu)
    const gap = o.gapMs || Infinity;
    for (const sr of o.series) {
      let d = '', area = '', segStart = null, lastX = null;
      for (let i = 0; i < t.length; i++) {
        const v = sr.values[i];
        if (v == null) continue;
        const brk = i === 0 || sr.values[i - 1] == null || t[i] - t[i - 1] > gap;
        if (brk) {
          if (segStart != null && o.series.length === 1) area += `L${lastX},${y(0)}L${segStart},${y(0)}Z`;
          d += `M${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
          area += `M${x(t[i]).toFixed(1)},${y(0)}L${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
          segStart = x(t[i]).toFixed(1);
        } else {
          d += `L${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
          area += `L${x(t[i]).toFixed(1)},${y(v).toFixed(1)}`;
        }
        lastX = x(t[i]).toFixed(1);
      }
      if (o.series.length === 1 && segStart != null) {
        area += `L${lastX},${y(0)}L${segStart},${y(0)}Z`;
        svg.append(s('path', { d: area, fill: sr.color, 'fill-opacity': 0.1, stroke: 'none' }));
      }
      svg.append(s('path', { d, fill: 'none', stroke: sr.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
    }

    // nhãn giá trị cuối (bỏ nếu chồng nhau — legend + tooltip gánh)
    const ends = o.series.map(sr => {
      let i = sr.values.length - 1;
      while (i >= 0 && sr.values[i] == null) i--;
      return i >= 0 ? { sr, v: sr.values[i], yy: y(sr.values[i]), xx: x(t[i]) } : null;
    }).filter(Boolean);
    const collide = ends.length === 2 && Math.abs(ends[0].yy - ends[1].yy) < 14;
    for (const e of ends) {
      svg.append(s('circle', { cx: e.xx, cy: e.yy, r: 4, fill: e.sr.color, stroke: 'var(--surface-1)', 'stroke-width': 2 }));
      if (!collide) svg.append(s('text', { class: 'endlbl', x: e.xx + 8, y: e.yy + 4 }, o.fmt(e.v)));
    }

    // hover: crosshair + tooltip liệt kê mọi series
    const cross = s('line', { class: 'cross', y1: pad.t, y2: pad.t + ih, visibility: 'hidden' });
    const dots = o.series.map(sr => s('circle', { r: 4, fill: sr.color, stroke: 'var(--surface-1)', 'stroke-width': 2, visibility: 'hidden' }));
    svg.append(cross, ...dots);
    const tip = h('div', { class: 'tooltip', role: 'status' });
    box.append(tip);
    const hit = s('rect', { x: pad.l, y: 0, width: iw, height: H, fill: 'transparent', tabindex: 0 });
    svg.append(hit);
    let idx = t.length - 1;
    const show = i => {
      idx = Math.max(0, Math.min(t.length - 1, i));
      const xx = x(t[idx]);
      cross.setAttribute('x1', xx); cross.setAttribute('x2', xx); cross.setAttribute('visibility', 'visible');
      tip.textContent = '';
      tip.append(h('div', { class: 'tt-time' }, (o.longTime ? dateTimeFmt : timeSecFmt).format(t[idx])));
      o.series.forEach((sr, k) => {
        const v = sr.values[idx];
        if (v == null) { dots[k].setAttribute('visibility', 'hidden'); return; }
        dots[k].setAttribute('cx', xx); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible');
        tip.append(h('div', { class: 'tt-row' }, h('span', { class: 'lk', style: { '--k': sr.color } }), h('b', {}, o.fmt(v)), h('span', { class: 'n' }, sr.name)));
      });
      tip.style.display = 'block';
      const tw = tip.offsetWidth;
      tip.style.left = `${xx + 12 + tw > W ? xx - tw - 12 : xx + 12}px`;
      tip.style.top = `${pad.t}px`;
    };
    const hide = () => { tip.style.display = 'none'; cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); };
    const nearest = clientX => {
      const r = svg.getBoundingClientRect();
      const px = ((clientX - r.left) / r.width) * W;
      const tv = t0 + ((px - pad.l) / iw) * (t1 - t0);
      let lo = 0, hi = t.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (t[m] < tv) lo = m; else hi = m; }
      return Math.abs(t[lo] - tv) < Math.abs(t[hi] - tv) ? lo : hi;
    };
    hit.addEventListener('pointermove', e => show(nearest(e.clientX)));
    hit.addEventListener('pointerdown', e => show(nearest(e.clientX)));
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('focus', () => show(idx));
    hit.addEventListener('blur', hide);
    hit.addEventListener('keydown', e => {
      if (e.key === 'ArrowLeft') { show(idx - 1); e.preventDefault(); }
      if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
    });

    // bảng thay thế (truy cập không cần hover)
    const tbl = h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Chuỗi'), h('th', { class: 'num' }, 'Hiện tại'), h('th', { class: 'num' }, 'Thấp nhất'), h('th', { class: 'num' }, 'Trung bình'), h('th', { class: 'num' }, 'Cao nhất'))),
      h('tbody', {}, o.series.map(sr => {
        const vals = sr.values.filter(v => v != null);
        const avg = vals.reduce((a, b) => a + b, 0) / (vals.length || 1);
        return h('tr', {}, h('td', {}, sr.name), h('td', { class: 'num' }, o.fmt(vals[vals.length - 1])), h('td', { class: 'num' }, o.fmt(Math.min(...vals))), h('td', { class: 'num' }, o.fmt(avg)), h('td', { class: 'num' }, o.fmt(Math.max(...vals))));
      })));
    el.append(h('details', { class: 'tbl' }, h('summary', {}, 'Xem dạng bảng'), h('div', { class: 'tablewrap' }, tbl)));
  }

  // ---------- biểu đồ cột (SSH theo giờ) ----------
  function columnChart(el, values, labels, fmt) {
    el.textContent = '';
    const box = h('div', { class: 'chart', style: { height: '170px' } });
    el.append(box);
    const W = box.clientWidth || 400, H = 170;
    const pad = { l: 36, r: 8, t: 16, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Số lần SSH đăng nhập sai theo giờ' });
    box.append(svg);
    const max = Math.max(1, ...values);
    const step = niceStep(max / 3);
    const yMax = Math.ceil(max / step) * step;
    const y = v => pad.t + ih - (v / yMax) * ih;
    for (let v = 0; v <= yMax; v += step) {
      svg.append(s('line', { class: v === 0 ? 'baseline' : 'gridline', x1: pad.l, x2: pad.l + iw, y1: y(v), y2: y(v) }));
      svg.append(s('text', { x: pad.l - 6, y: y(v) + 4, 'text-anchor': 'end' }, fmtNum(v)));
    }
    const band = iw / values.length;
    const bw = Math.min(24, Math.max(2, band - 2));
    const tip = h('div', { class: 'tooltip' });
    box.append(tip);
    const maxI = values.indexOf(Math.max(...values));
    values.forEach((v, i) => {
      const bx = pad.l + i * band + (band - bw) / 2;
      const top = y(v), bh = Math.max(0, y(0) - top);
      const r = Math.min(4, bh, bw / 2);
      const d = bh > 0 ? `M${bx},${y(0)}V${top + r}Q${bx},${top} ${bx + r},${top}H${bx + bw - r}Q${bx + bw},${top} ${bx + bw},${top + r}V${y(0)}Z` : '';
      if (d) svg.append(s('path', { d, fill: 'var(--series-1)', class: 'bar' }));
      if (i === maxI && v > 0) svg.append(s('text', { class: 'endlbl', x: bx + bw / 2, y: top - 4, 'text-anchor': 'middle' }, fmtNum(v)));
      if (i % 6 === 0 || i === values.length - 1) svg.append(s('text', { x: bx + bw / 2, y: H - 5, 'text-anchor': 'middle' }, labels[i]));
      const hit = s('rect', { x: pad.l + i * band, y: pad.t, width: band, height: ih, fill: 'transparent', tabindex: 0 });
      const showTip = () => {
        tip.textContent = '';
        tip.append(h('div', { class: 'tt-time' }, labels[i] === 'Giờ này' ? 'Giờ hiện tại' : `${labels[i]} – ${i < values.length - 1 ? labels[i + 1] || '' : ''}`), h('div', { class: 'tt-row' }, h('b', {}, fmt(v)), h('span', { class: 'n' }, 'lần sai')));
        tip.style.display = 'block';
        const xx = pad.l + i * band;
        tip.style.left = `${xx + tip.offsetWidth + 20 > W ? xx - tip.offsetWidth - 4 : xx + band + 4}px`;
        tip.style.top = '0px';
      };
      hit.addEventListener('pointerenter', showTip);
      hit.addEventListener('pointerdown', showTip);
      hit.addEventListener('focus', showTip);
      hit.addEventListener('pointerleave', () => { tip.style.display = 'none'; });
      hit.addEventListener('blur', () => { tip.style.display = 'none'; });
      svg.append(hit);
    });
  }

  function hbars(el, rows, fmtV, sub) {
    el.textContent = '';
    if (!rows.length) { el.append(h('div', { class: 'empty' }, 'Không có dữ liệu')); return; }
    const max = Math.max(...rows.map(r => r.value));
    el.append(h('div', { class: 'hbars' }, rows.map(r => h('div', { class: 'hbar', title: r.title || '' },
      h('span', { class: 'ip mono' }, r.label, sub && r.sub ? h('span', { class: 'sub' }, ` ${r.sub}`) : null),
      h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(r.value / max) * 100}%` } })),
      h('span', { class: 'v' }, fmtV(r.value))))));
  }

  function table(el, headers, rows, emptyText) {
    el.textContent = '';
    if (!rows.length) { el.append(h('div', { class: 'empty' }, emptyText || 'Không có dữ liệu')); return; }
    el.append(h('table', {},
      h('thead', {}, h('tr', {}, headers.map(hd => h('th', { class: hd.num ? 'num' : hd.cls || null }, hd.t)))),
      h('tbody', {}, rows.map(r => h('tr', {}, r.map((c, i) => h('td', { class: headers[i].num ? 'num' : headers[i].cls || null }, c)))))));
  }

  // ---------- render ----------
  let snap = null;
  let range = localStorage.getItem('range') || '1h';
  let histPoints = [];

  function renderHeader(d) {
    $('srvName').textContent = d.server.name;
    document.title = `${d.status === 'ok' ? '🟢' : d.status === 'critical' ? '🔴' : '🟡'} ${d.server.name} · VPS Health`;
    const ov = $('overall');
    ov.replaceWith(Object.assign(pill(d.status, d.status === 'ok' ? 'Ổn định' : `${LV_LABEL[d.status]} · ${d.alerts.length + d.recent.length} vấn đề`), { id: 'overall' }));
    const sy = d.system;
    $('srvInfo').textContent = [d.server.os, `kernel ${d.server.kernel}`, sy ? `${sy.cpu.count} nhân` : '', sy ? fmtBytes(sy.mem.total) + ' RAM' : '', sy ? `chạy ${fmtDur(sy.uptime)}` : ''].filter(Boolean).join(' · ');
    $('updated').textContent = `Cập nhật ${timeSecFmt.format(d.now)}`;

    const b = $('banners');
    b.textContent = '';
    if (!d.telegram.enabled) b.append(h('div', { class: 'banner' }, 'Chưa cấu hình Telegram (TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID) — cảnh báo chỉ hiện trên dashboard.'));
    else if (d.telegram.dryRun) b.append(h('div', { class: 'banner' }, 'Telegram đang ở chế độ thử (TELEGRAM_DRY_RUN=1) — tin nhắn chỉ ghi ra log.'));
    if (d.alertSettings && d.alertSettings.snoozeUntil) b.append(h('div', { class: 'banner' }, `🔕 Đang tạm tắt mọi cảnh báo Telegram đến ${dateTimeFmt.format(d.alertSettings.snoozeUntil)}.`));
    if (d.telegram.lastError) b.append(h('div', { class: 'banner' }, `Lỗi gửi Telegram: ${d.telegram.lastError}`));
    if (!d.docker.available) b.append(h('div', { class: 'banner' }, `Không đọc được Docker: ${d.docker.error}`));
    if (d.security.source === 'none') b.append(h('div', { class: 'banner' }, 'Không tìm thấy log SSH (/var/log/auth.log hoặc /var/log/secure) — chưa phát hiện được brute-force SSH. Cài rsyslog để bật.'));
  }

  function tile(label, value, unit, note, meterPct, level) {
    return h('div', { class: 'card tile' },
      h('div', { class: 'label' }, label),
      h('div', { class: 'value' }, value, unit ? h('small', {}, unit) : null),
      h('div', { class: 'note', title: note || '' }, note || ''),
      meterPct != null ? meter(meterPct, level) : null);
  }

  function renderTiles(d) {
    const el = $('tiles');
    const sy = d.system, th = d.thresholds;
    if (!sy) return;
    const root = sy.fs.find(f => f.mount === '/') || sy.fs.slice().sort((a, b) => b.pct - a.pct)[0];
    const running = d.docker.containers.filter(c => c.state === 'running').length;
    const badC = d.docker.containers.filter(c => c.state === 'restarting' || c.health === 'unhealthy').length;
    const loadPct = (sy.load[0] / sy.cpu.count) * 100 / th.loadPerCore;
    const syn = sy.tcp.states.SYN_RECV || 0;
    el.textContent = '';
    el.append(
      tile('CPU', fmtPct(sy.cpu.usage), '', `${sy.cpu.count} nhân · iowait ${fmtPct(sy.cpu.iowait)} · steal ${fmtPct(sy.cpu.steal)}`, sy.cpu.usage, lvlFor(sy.cpu.usage, th.cpuWarn)),
      tile('RAM', fmtPct(sy.mem.pct), '', `${fmtBytes(sy.mem.used)} / ${fmtBytes(sy.mem.total)}`, sy.mem.pct, lvlFor(sy.mem.pct, th.ramWarn, th.ramCrit)),
      sy.mem.swapTotal ? tile('Swap', fmtPct(sy.mem.swapPct), '', `${fmtBytes(sy.mem.swapUsed)} / ${fmtBytes(sy.mem.swapTotal)}`, sy.mem.swapPct, lvlFor(sy.mem.swapPct, th.swapWarn))
        : tile('Swap', 'Không có', '', 'Nên tạo swap nếu RAM nhỏ', null),
      root ? tile(`Ổ đĩa ${root.mount}`, fmtPct(root.pct), '', `còn ${fmtBytes(root.avail)} / ${fmtBytes(root.total)}`, root.pct, lvlFor(root.pct, th.diskWarn, th.diskCrit)) : null,
      tile('Load', sy.load[0].toFixed(2), '', `5m ${sy.load[1].toFixed(2)} · 15m ${sy.load[2].toFixed(2)}`, Math.min(100, loadPct), lvlFor(loadPct, 100)),
      tile('Mạng vào', fmtRate(sy.net.rx), '', `ra ${fmtRate(sy.net.tx)}`, null),
      d.docker.available ? tile('Container', `${running}`, `/ ${d.docker.containers.length}`, badC ? `${badC} đang lỗi` : `${d.docker.containers.length - running} đã dừng`, d.docker.containers.length ? (running / d.docker.containers.length) * 100 : 0, badC ? 'critical' : 'ok') : null,
      tile(`SSH sai (${th.sshWindowMin} phút)`, fmtNum(d.security.failsWindow), '', `24h: ${fmtNum(d.security.fails24h)} lần · ${d.security.uniqueIps24h} IP`, Math.min(100, (d.security.failsWindow / th.sshFailTotal) * 100), lvlFor(d.security.failsWindow, th.sshFailTotal / 2, th.sshFailTotal)),
      tile('Kết nối TCP', fmtNum(sy.tcp.states.ESTABLISHED || 0), '', `SYN_RECV ${syn} · ${sy.procs.count} tiến trình`, Math.min(100, (syn / th.synRecv) * 100), lvlFor(syn, th.synRecv / 2, th.synRecv)),
    );
  }

  function renderAlerts(d) {
    const el = $('alerts');
    el.textContent = '';
    const muted = (d.alertSettings && d.alertSettings.muted) || {};
    const item = (a, when) => h('li', { class: `lv-${a.level}` },
      pill(a.level),
      h('div', { class: 'body' }, h('div', { class: 't' }, a.title, a.sent === false || muted[a.type] ? h('span', { class: 'muted-tag' }, '🔕 không gửi Telegram') : null), a.detail ? h('div', { class: 'd' }, a.detail) : null, h('div', { class: 'when' }, when)));
    if (!d.alerts.length) el.append(h('div', { class: 'hero-ok' }, pill('ok', 'Không có cảnh báo'), 'Các chỉ số tài nguyên đang trong ngưỡng an toàn.'));
    else el.append(h('ul', { class: 'alert-list' }, d.alerts.map(a => item(a, `từ ${ago(a.since)}`))));
    if (d.recent.length) {
      el.append(h('h2', { style: { fontSize: '13.5px', margin: '14px 0 8px' } }, `Sự cố trong 1 giờ qua (${d.recent.length})`),
        h('ul', { class: 'alert-list' }, d.recent.slice(0, 6).map(e => item(e, ago(e.t)))));
      if (d.recent.length > 6) el.append(h('div', { class: 'desc', style: { marginTop: '6px' } }, 'Xem đầy đủ ở Nhật ký sự kiện bên dưới.'));
    }
  }

  function renderCharts() {
    const p = histPoints;
    const t = p.map(x => x.t);
    const long = range === '24h';
    const gapMs = long ? 3 * 60000 : 30000;
    const pct = v => fmtPct(v);
    lineChart($('chCpuMem'), { label: 'CPU và RAM theo thời gian', times: t, gapMs, longTime: long, yMax: 100, fmt: pct, fmtAxis: v => `${v}%`,
      series: [{ name: 'CPU', color: 'var(--series-1)', values: p.map(x => x.cpu) }, { name: 'RAM', color: 'var(--series-2)', values: p.map(x => x.mem) }] });
    lineChart($('chNet'), { label: 'Băng thông mạng', times: t, gapMs, longTime: long, fmt: fmtRate, fmtAxis: v => fmtBytes(v).replace(' ', ''),
      series: [{ name: 'Vào (↓)', color: 'var(--series-1)', values: p.map(x => x.rx) }, { name: 'Ra (↑)', color: 'var(--series-2)', values: p.map(x => x.tx) }] });
    lineChart($('chIo'), { label: 'Đọc ghi ổ đĩa', times: t, gapMs, longTime: long, fmt: fmtRate, fmtAxis: v => fmtBytes(v).replace(' ', ''),
      series: [{ name: 'Đọc', color: 'var(--series-1)', values: p.map(x => x.rd) }, { name: 'Ghi', color: 'var(--series-2)', values: p.map(x => x.wr) }] });
    const cores = snap && snap.system ? snap.system.cpu.count : null;
    lineChart($('chLoad'), { label: 'Load average', times: t, gapMs, longTime: long, fmt: v => v.toFixed(2), fmtAxis: v => fmtNum(v),
      ref: cores ? { value: cores, label: `${cores} nhân` } : null,
      series: [{ name: 'Load 1 phút', color: 'var(--series-1)', values: p.map(x => x.load) }] });
  }

  function renderDocker(d) {
    const el = $('containers');
    const cs = d.docker.containers;
    $('dockerSum').textContent = d.docker.available ? `${cs.filter(c => c.state === 'running').length}/${cs.length} đang chạy` : '';
    if (!d.docker.available) { el.textContent = ''; el.append(h('div', { class: 'empty' }, d.docker.error)); return; }
    const stateOf = c => {
      if (c.state === 'restarting') return pill('critical', 'Restart liên tục');
      if (c.health === 'unhealthy') return pill('critical', 'Unhealthy');
      if (c.state === 'running') return pill('ok', c.health === 'healthy' ? 'Healthy' : 'Đang chạy');
      if (c.state === 'exited' && c.exitCode !== 0) return pill('warning', `Dừng (lỗi ${c.exitCode})`);
      return pill('muted', c.state === 'exited' ? 'Đã dừng' : c.state);
    };
    const sorted = [...cs].sort((a, b) => (a.state === 'running') - (b.state === 'running') || a.name.localeCompare(b.name)).reverse();
    table(el, [{ t: 'Container' }, { t: 'Trạng thái' }, { t: 'CPU', num: true }, { t: 'RAM', num: true }, { t: 'Cổng', cls: 'hide-sm' }, { t: 'Restart', num: true }],
      sorted.map(c => [
        h('div', {}, h('div', {}, c.name), h('div', { class: 'sub mono' }, c.image)),
        h('div', {}, stateOf(c), h('div', { class: 'sub' }, c.status)),
        c.cpu != null ? fmtPct(c.cpu) : '–',
        c.memUsage != null ? h('div', {}, fmtBytes(c.memUsage), c.memPct != null && c.memLimit < 1e15 ? h('div', { class: 'sub' }, `/${fmtBytes(c.memLimit)}`) : null) : '–',
        h('span', { class: 'mono' }, c.ports.join(', ') || '–'),
        String(c.restartCount || 0),
      ]), 'Không có container nào');
  }

  function renderDisks(d) {
    const th = d.thresholds;
    table($('disks'), [{ t: 'Phân vùng' }, { t: 'Đã dùng' }, { t: 'Còn trống', num: true }, { t: 'Tổng', num: true }, { t: 'Inode', num: true }],
      d.system.fs.map(f => [
        h('div', {}, h('div', { class: 'mono' }, f.mount), h('div', { class: 'sub' }, `${f.device} · ${f.fstype}`)),
        h('div', { style: { minWidth: '110px' } }, fmtPct(f.pct), meter(f.pct, lvlFor(f.pct, th.diskWarn, th.diskCrit), true)),
        fmtBytes(f.avail), fmtBytes(f.total), fmtPct(f.inodePct),
      ]));
  }

  function renderSecurity(d) {
    const sec = d.security, sy = d.system, th = d.thresholds;
    $('secSource').textContent = sec.source === 'none' ? 'Không có log SSH' : `Nguồn: ${sec.source}`;
    const kv = $('secKv');
    kv.textContent = '';
    const item = (k, v, lvl) => h('div', {}, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v), lvl && lvl !== 'ok' ? pill(lvl) : null);
    kv.append(
      item(`SSH sai ${th.sshWindowMin} phút`, fmtNum(sec.failsWindow), lvlFor(sec.failsWindow, th.sshFailTotal / 2, th.sshFailTotal)),
      item('SSH sai 24h', fmtNum(sec.fails24h)),
      item('IP tấn công 24h', fmtNum(sec.uniqueIps24h)),
      item('SYN_RECV', fmtNum(sy.tcp.states.SYN_RECV || 0), lvlFor(sy.tcp.states.SYN_RECV || 0, th.synRecv / 2, th.synRecv)),
      item('Cổng mở ra ngoài', String(sy.tcp.listening.filter(l => !l.local).length)),
    );
    const now = new Date();
    const labels = sec.hourly.map((_, i) => {
      if (i === 23) return 'Giờ này';
      const dt = new Date(now.getTime() - (23 - i) * 3600000);
      return `${String(dt.getHours()).padStart(2, '0')}h`;
    });
    columnChart($('chSsh'), sec.hourly, labels, fmtNum);
    hbars($('topIps'), sec.topIps.slice(0, 10).map(x => ({ label: x.ip, value: x.count, sub: x.recent ? `· ${x.recent} gần đây` : '', title: `User thử: ${x.users.join(', ')} · lần cuối ${ago(x.last)}` })), fmtNum, true);
    table($('logins'), [{ t: 'Lúc' }, { t: 'User' }, { t: 'Từ IP' }, { t: 'Cách', cls: 'hide-sm' }],
      sec.logins.map(l => [ago(l.t), l.user, h('span', { class: 'mono' }, l.ip), l.method]), 'Chưa thấy lần đăng nhập nào');
    table($('ports'), [{ t: 'Cổng', num: true }, { t: 'Phạm vi' }, { t: 'Tiến trình' }, { t: 'Địa chỉ', cls: 'hide-sm' }],
      sy.tcp.listening.map(l => [String(l.port), l.local ? pill('muted', 'Chỉ nội bộ') : pill('info', 'Internet'), l.process || '–', h('span', { class: 'mono' }, l.addrs.join(', '))]));
    hbars($('connIps'), sy.tcp.topIps.slice(0, 8).map(x => ({ label: x.ip, value: x.count })), v => `${v}`);
  }

  function renderProcs(d) {
    const p = d.system.procs;
    const rows = list => list.map(x => [h('div', {}, h('div', {}, x.name), h('div', { class: 'sub' }, `PID ${x.pid} · ${x.user}`)), fmtPct(x.cpu), fmtBytes(x.rss), h('div', { class: 'cmd mono', title: x.cmd }, x.cmd)]);
    const hd = [{ t: 'Tiến trình' }, { t: 'CPU', num: true }, { t: 'RAM', num: true }, { t: 'Lệnh', cls: 'hide-sm' }];
    table($('procCpu'), hd, rows(p.byCpu.slice(0, 8)));
    table($('procMem'), hd, rows(p.byMem.slice(0, 8)));
  }

  async function renderEvents() {
    try {
      const ev = await api('api/events');
      const el = $('events');
      el.textContent = '';
      if (!ev.length) { el.append(h('li', { class: 'empty' }, 'Chưa có sự kiện nào')); return; }
      el.append(...ev.slice(0, 100).map(e => h('li', {}, pill(e.level), h('b', {}, e.title, e.sent === false ? h('span', { class: 'muted-tag' }, '🔕 không gửi Telegram') : null), h('span', { class: 'when' }, `${dateTimeFmt.format(e.t)} · ${ago(e.t)}`), e.detail ? h('span', { class: 'd' }, e.detail) : null)));
    } catch { /* bỏ qua */ }
  }

  async function loadSnapshot() {
    try {
      snap = await api('api/snapshot');
      renderHeader(snap);
      renderTiles(snap);
      renderAlerts(snap);
      if (snap.system) { renderDisks(snap); renderSecurity(snap); renderProcs(snap); }
      renderDocker(snap);
    } catch (e) {
      $('updated').textContent = `Mất kết nối (${e.message}) — thử lại…`;
    }
  }

  async function loadHistory() {
    document.querySelectorAll('.chart').forEach(c => c.classList.add('loading'));
    try {
      const r = await api(`api/history?range=${range}`);
      histPoints = r.points;
    } catch { /* giữ dữ liệu cũ */ }
    renderCharts();
  }

  // ---------- cài đặt cảnh báo ----------
  let settings = null;
  function renderSettings() {
    if (!settings) return;
    const st = $('snoozeState');
    st.textContent = settings.snoozeUntil ? `— đang tắt đến ${dateTimeFmt.format(settings.snoozeUntil)}` : '— đang bật';
    document.querySelectorAll('#snoozeBtns button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === '0' ? !settings.snoozeUntil : false)));
    const groups = {};
    for (const t of settings.types) (groups[t.group] = groups[t.group] || []).push(t);
    const el = $('typeGroups');
    el.textContent = '';
    for (const [g, types] of Object.entries(groups)) {
      el.append(h('div', {}, h('h3', {}, g), types.map(t => {
        const on = !settings.muted[t.id];
        const input = h('input', { type: 'checkbox', role: 'switch', 'aria-label': t.label, checked: on });
        input.addEventListener('change', () => saveSettings({ muted: { [t.id]: !input.checked } }));
        return h('label', { class: 'toggle' }, h('span', {}, t.label),
          h('span', { style: { display: 'flex', alignItems: 'center', gap: '8px' } }, h('span', { class: 'state' }, on ? 'Bật' : 'Tắt'), h('span', { class: 'switch' }, input, h('span', { class: 'track' }))));
      })));
    }
  }
  async function loadSettings() {
    try { settings = await api('api/settings'); renderSettings(); } catch { /* bỏ qua */ }
  }
  async function saveSettings(patch) {
    try {
      settings = await api('api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      renderSettings();
      loadSnapshot();
    } catch (e) { alert(`Không lưu được cài đặt: ${e.message}`); loadSettings(); }
  }
  const toggleSettings = open => {
    $('settingsCard').hidden = !open;
    $('settingsBtn').setAttribute('aria-expanded', String(open));
    if (open) { loadSettings(); $('settingsCard').scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };
  $('settingsBtn').addEventListener('click', () => toggleSettings($('settingsCard').hidden));
  $('settingsClose').addEventListener('click', () => toggleSettings(false));
  document.querySelectorAll('#snoozeBtns button').forEach(b => b.addEventListener('click', () => saveSettings({ snoozeMinutes: Number(b.dataset.m) })));

  // ---------- sự kiện UI ----------
  document.querySelectorAll('#range button').forEach(b => {
    b.setAttribute('aria-pressed', String(b.dataset.r === range));
    b.addEventListener('click', () => {
      range = b.dataset.r;
      localStorage.setItem('range', range);
      document.querySelectorAll('#range button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
      loadHistory();
    });
  });
  $('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('theme', next);
  });
  $('testAlert').addEventListener('click', async e => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try { const r = await api('api/test-alert', { method: 'POST' }); btn.textContent = r.ok ? 'Đã gửi ✓' : 'Chưa cấu hình'; }
    catch { btn.textContent = 'Lỗi'; }
    setTimeout(() => { btn.textContent = 'Thử Telegram'; btn.disabled = false; }, 3000);
  });
  let rz;
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(() => { renderCharts(); if (snap) renderSecurity(snap); }, 200); });

  loadSnapshot().then(loadHistory);
  renderEvents();
  setInterval(loadSnapshot, 5000);
  setInterval(() => { if (range !== '24h') loadHistory(); }, 10000);
  setInterval(() => { if (range === '24h') loadHistory(); }, 60000);
  setInterval(renderEvents, 15000);
})();
