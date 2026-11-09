# VPS Health Monitor

Giám sát sức khỏe VPS. Dashboard chạy ở cổng **3100**, cảnh báo gửi qua **Telegram**.
Viết bằng Node.js thuần, không dùng thư viện ngoài, đọc số liệu trực tiếp từ `/proc` và Docker socket.

## Cài đặt (1 lệnh)

```bash
git clone <repo-url> vps-health && cd vps-health && sudo bash install.sh
```

Script sẽ hỏi Telegram bot token, chat ID và mật khẩu dashboard, sau đó:
- chạy bằng **Docker Compose** nếu máy có Docker, nếu không thì chạy bằng **systemd** (cần Node.js 18 trở lên);
- cài `rsyslog` nếu máy chưa có `/var/log/auth.log`, để phát hiện được brute-force SSH;
- mở cổng 3100 trên `ufw` nếu firewall đang bật.

Mở `http://IP-VPS:3100` rồi đăng nhập bằng user `admin` và mật khẩu đã đặt.

## Các cảnh báo được gửi qua Telegram

| Nhóm | Phát hiện |
|---|---|
| RAM | RAM ≥ 85% (cảnh báo) hoặc ≥ 95% (nghiêm trọng), swap ≥ 80%, kernel OOM killer giết tiến trình |
| Ổ đĩa | Phân vùng ≥ 85% hoặc ≥ 95%, hết inode, I/O wait cao kéo dài |
| CPU | CPU ≥ 90% suốt 5 phút, load vượt 2 lần số nhân, CPU steal cao (VPS bị chia sẻ CPU) |
| Docker | Có container **mới**, container bị xóa, container dừng hoặc crash (kể cả do hết RAM), restart liên tục, `unhealthy`, gần chạm giới hạn RAM, image nghi đào coin |
| Tấn công | Brute-force SSH (theo từng IP và tổng thể), đăng nhập SSH thành công (cảnh báo mạnh hơn nếu IP lạ), **tài khoản mới được tạo**, user được thêm vào nhóm sudo/docker, nghi SYN flood, một IP mở quá nhiều kết nối, **cổng mới mở ra Internet**, tiến trình ngốn CPU lâu (nghi miner), có người dò mật khẩu dashboard |

Mỗi cảnh báo được gửi khi tình trạng xấu đi và gửi thêm tin "✅ đã trở lại bình thường" khi hồi phục.
Nếu sau 2 giờ vẫn chưa xử lý, hệ thống nhắc lại. Mọi ngưỡng đều chỉnh được trong `.env` (xem `.env.example`).

### Lệnh gõ cho bot

`/status` xem tình trạng · `/containers` xem danh sách container · `/security` xem tình hình bảo mật · `/alerts` xem cảnh báo đang mở

## Vận hành

```bash
docker logs -f vps-health                            # xem log (chế độ Docker)
docker compose up -d --build                         # cập nhật sau khi git pull
journalctl -u vps-health -f                          # xem log (chế độ systemd)
systemctl restart vps-health
```

Sau khi sửa `.env`: chạy `docker compose up -d` (Docker) hoặc `systemctl restart vps-health` (systemd).

## Bảo mật

- Dashboard bắt buộc đăng nhập. Một IP nhập sai 20 lần trong 15 phút sẽ bị chặn tạm thời.
- Container chỉ mount `/` của host ở chế độ **chỉ đọc**. Docker socket chỉ dùng cho các lệnh đọc.
- Dashboard dùng HTTP thường. Nên đặt sau reverse proxy có HTTPS, hoặc giới hạn IP được truy cập: `ufw allow from <IP-của-bạn> to any port 3100`.
