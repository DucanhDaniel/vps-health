'use strict';
const https = require('https');
const http = require('http');

const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

class Telegram {
  constructor(cfg) {
    this.cfg = cfg.telegram;
    this.queue = [];
    this.sending = false;
    this.offset = 0;
    this.handlers = {};
    this.lastError = '';
    this.sent = 0;
  }

  get enabled() { return !!(this.cfg.token && this.cfg.chatId) || this.cfg.dryRun; }

  // Dùng https.request thay vì fetch để ép họ địa chỉ IP (mặc định IPv4) — nhiều VPS có IPv6 tới Telegram bị chặn/hỏng
  api(method, body, timeoutMs = 15000) {
    const url = new URL(`${this.cfg.apiBase}/bot${this.cfg.token}/${method}`);
    const data = Buffer.from(JSON.stringify(body || {}));
    const lib = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = lib.request(url, {
        method: 'POST',
        family: this.cfg.ipFamily || undefined,
        headers: { 'content-type': 'application/json', 'content-length': data.length },
      }, res => {
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => { buf += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(buf)); } catch { reject(new Error(`HTTP ${res.statusCode}: phản hồi không hợp lệ`)); }
        });
      });
      req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs / 1000}s khi kết nối ${url.host}`)));
      req.on('error', e => reject(new Error(`${e.code || ''} ${e.message}`.trim())));
      req.end(data);
    });
  }

  send(html) {
    if (!this.enabled) return;
    this.queue.push(html);
    this.flush();
  }

  async flush() {
    if (this.sending) return;
    this.sending = true;
    while (this.queue.length) {
      const text = this.queue.shift();
      if (this.cfg.dryRun) {
        console.log('[telegram:dry-run]\n' + text.replace(/<[^>]+>/g, '') + '\n');
        this.sent++;
        continue;
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await this.api('sendMessage', { chat_id: this.cfg.chatId, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });
          if (r.ok) { this.sent++; this.lastError = ''; break; }
          this.lastError = r.description || 'unknown';
          if (r.parameters && r.parameters.retry_after) { await sleep(r.parameters.retry_after * 1000); continue; }
          console.error('[telegram] lỗi:', this.lastError);
          break;
        } catch (e) {
          this.lastError = e.message;
          if (attempt === 3) console.error('[telegram] lỗi gửi:', this.lastError);
          await sleep(2000 * (attempt + 1));
        }
      }
      await sleep(400); // tránh rate-limit
    }
    this.sending = false;
  }

  on(cmd, fn) { this.handlers[cmd] = fn; }

  // Long-polling nhận lệnh /status, /containers... chỉ từ chat được cấu hình
  async pollCommands() {
    if (!this.cfg.token || this.cfg.dryRun || !this.cfg.commands) return;
    try {
      await this.api('setMyCommands', { commands: [
        { command: 'status', description: 'Tình trạng VPS hiện tại' },
        { command: 'containers', description: 'Danh sách container' },
        { command: 'security', description: 'Tình hình bảo mật' },
        { command: 'alerts', description: 'Cảnh báo đang mở' },
        { command: 'help', description: 'Trợ giúp' },
      ] });
    } catch { /* không quan trọng */ }
    for (;;) {
      try {
        const r = await this.api('getUpdates', { offset: this.offset, timeout: 50, allowed_updates: ['message'] }, 60000);
        if (!r.ok) {
          this.lastError = r.description || 'getUpdates lỗi';
          await sleep(r.error_code === 409 ? 30000 : 5000);
          continue;
        }
        for (const u of r.result) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m || !m.text || String(m.chat.id) !== String(this.cfg.chatId)) continue;
          const cmd = m.text.trim().split(/[\s@]/)[0].toLowerCase().replace(/^\//, '');
          const fn = this.handlers[cmd] || this.handlers.help;
          if (fn) { try { this.send(await fn()); } catch (e) { this.send(`Lỗi: ${esc(e.message)}`); } }
        }
      } catch {
        await sleep(5000);
      }
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { Telegram, esc };
