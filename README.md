# LingoPlay Production

## Chạy trên Windows
1. Cài Python 3.11 hoặc mới hơn.
2. Giải nén toàn bộ thư mục.
3. Bấm `START-WEB.bat`.
4. Lần đầu cần Internet để cài thư viện; chờ cửa sổ tự mở `http://localhost:3000`.

Tài khoản thử:
- Admin: `admin@lingoplay.local` / `Admin@123`
- User: `user@lingoplay.local` / `User@123`

## Triển khai Render
- Đưa thư mục lên GitHub.
- Trong Render chọn **Blueprint** và chọn repository.
- Render đọc `render.yaml`, tạo web service và PostgreSQL tự động.
- Sau khi tạo xong, đổi `ADMIN_EMAIL` và `ADMIN_PASSWORD` trong Environment.

## Nâng cấp đã có
- PostgreSQL khi deploy; SQLite khi chạy máy cá nhân.
- Mật khẩu mã hóa bằng Werkzeug PBKDF2/scrypt.
- Cookie HttpOnly, SameSite và Secure trên HTTPS.
- Rate limit đăng nhập, đăng ký, tra từ, gợi ý và dịch.
- Cache kết quả API trong database.
- API Free Dictionary, Datamuse, MyMemory có timeout và fallback.
- Phân quyền backend, khóa tài khoản, đổi vai trò qua API admin.
- Cấu hình Render, Docker, `.env.example`, health check.

Lưu ý: API miễn phí có thể chậm hoặc giới hạn tạm thời. Kho học, đăng nhập và trò chơi nội bộ vẫn hoạt động.
