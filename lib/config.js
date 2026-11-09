'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

// Nạp file .env (nếu có) mà không cần thư viện dotenv.
function loadDotEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return; }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, ''); // bỏ chú thích cuối dòng
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadDotEnv(path.join(__dirname, '..', '.env'));

const env = process.env;
const num = (k, d) => (env[k] !== undefined && env[k] !== '' && !isNaN(Number(env[k])) ? Number(env[k]) : d);
const bool = (k, d) => (env[k] === undefined || env[k] === '' ? d : /^(1|true|yes|on)$/i.test(env[k]));

const hostRoot = (env.HOST_ROOT || '').replace(/\/+$/, '');

function readHostname() {
  try { return fs.readFileSync(path.join(hostRoot || '/', 'etc/hostname'), 'utf8').trim() || os.hostname(); }
  catch { return os.hostname(); }
}

module.exports = {
  port: num('PORT', 3100),
  bindHost: env.BIND_HOST || '127.0.0.1',
  serverName: env.SERVER_NAME || readHostname(),
  procPath: env.PROC_PATH || '/proc',
  hostRoot,
  dockerSocket: env.DOCKER_SOCKET || '/var/run/docker.sock',
  authLog: env.AUTH_LOG_PATH || '',
  dataDir: env.DATA_DIR || path.join(__dirname, '..', 'data'),
  tz: env.TZ || 'Asia/Ho_Chi_Minh',
  intervalSec: num('SAMPLE_INTERVAL', 5),

  dashboard: {
    user: env.DASHBOARD_USER || 'admin',
    pass: env.DASHBOARD_PASSWORD || '',
  },

  telegram: {
    token: env.TELEGRAM_BOT_TOKEN || '',
    chatId: env.TELEGRAM_CHAT_ID || '',
    dryRun: bool('TELEGRAM_DRY_RUN', false),
    commands: bool('TELEGRAM_COMMANDS', true),
    startupMessage: bool('TELEGRAM_STARTUP_MESSAGE', true),
  },

  // Ngưỡng cảnh báo — chỉnh trong .env
  th: {
    ramWarn: num('RAM_WARN', 85),
    ramCrit: num('RAM_CRIT', 95),
    swapWarn: num('SWAP_WARN', 80),
    diskWarn: num('DISK_WARN', 85),
    diskCrit: num('DISK_CRIT', 95),
    inodeWarn: num('INODE_WARN', 90),
    cpuWarn: num('CPU_WARN', 90),
    cpuSustainMin: num('CPU_SUSTAIN_MIN', 5),
    loadPerCore: num('LOAD_WARN_PER_CORE', 2),
    iowaitWarn: num('IOWAIT_WARN', 30),
    stealWarn: num('STEAL_WARN', 20),
    procCpuWarn: num('PROC_CPU_WARN', 90),
    procCpuSustainMin: num('PROC_CPU_SUSTAIN_MIN', 10),
    containerMemWarn: num('CONTAINER_MEM_WARN', 90),
    sshFailPerIp: num('SSH_FAIL_PER_IP', 10),
    sshFailTotal: num('SSH_FAIL_TOTAL', 50),
    sshWindowMin: num('SSH_WINDOW_MIN', 10),
    synRecv: num('SYN_RECV_WARN', 100),
    connPerIp: num('CONN_PER_IP_WARN', 150),
    dashAuthFail: num('DASH_AUTH_FAIL_WARN', 10),
  },

  notify: {
    sshLogin: bool('NOTIFY_SSH_LOGIN', true),
    newPort: bool('NOTIFY_NEW_PORT', true),
    containerStop: bool('NOTIFY_CONTAINER_STOP', true),
    repeatMin: num('ALERT_REPEAT_MIN', 120),
  },
};
