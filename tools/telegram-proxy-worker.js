// Cloudflare Worker chuyển tiếp request tới api.telegram.org
// Dùng khi VPS không kết nối được Telegram (bị nhà mạng chặn).
// Cách dùng: dash.cloudflare.com → Workers & Pages → Create → Hello World → Edit code → dán file này → Deploy.
// Sau đó đặt TELEGRAM_API_BASE=https://<ten-worker>.<tai-khoan>.workers.dev trong .env
export default {
  async fetch(request) {
    const url = new URL(request.url);
    // Chỉ cho phép gọi Bot API, không mở proxy tùy ý
    if (!url.pathname.startsWith('/bot')) return new Response('Not found', { status: 404 });
    const target = 'https://api.telegram.org' + url.pathname + url.search;
    return fetch(target, { method: request.method, headers: { 'content-type': request.headers.get('content-type') || 'application/json' }, body: request.method === 'GET' ? undefined : request.body });
  },
};
