'use strict';

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

  api(method, body, timeoutMs = 15000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    return fetch(`https://api.telegram.org/bot${this.cfg.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: ctrl.signal,
    }).then(r => r.json()).finally(() => clearTimeout(timer));
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
