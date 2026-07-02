# LingoPlay Bilingual Pro

Bản tách riêng Tiếng Anh A1–C2 và Tiếng Trung HSK1–HSK6. Có 240 từ tích hợp, 24 cụm nói, tra từ, dịch, trò chơi, tài khoản và quản trị.

## Cập nhật GitHub nhanh
Upload và ghi đè 5 file ở thư mục gốc: `app.py`, `app.js`, `style.css`, `lingoplay-home.html`, `vocabulary_data.py`. Sau đó Render > Manual Deploy > Deploy latest commit.

## Lưu ý database
Lần deploy mới, hàm seed tự thêm các từ còn thiếu vào PostgreSQL, không xóa tài khoản hiện có.

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


## Nhập nhiều từ vựng bằng CSV

1. Đăng nhập tài khoản admin.
2. Mở **Quản trị**.
3. Ở mục **Nhập từ vựng hàng loạt**, chọn file CSV UTF-8.
4. Có thể dùng `vocabulary-starter-240.csv` hoặc `vocabulary-template.csv` trong bộ mã nguồn.
5. Hệ thống tự kiểm tra ngôn ngữ/cấp độ, bỏ qua từ trùng và báo dòng lỗi.
6. Có nút xuất toàn bộ kho từ ra CSV để sao lưu.

Cột CSV: `language,level,word,pronunciation,meaning,example,topic`.

Cấp hợp lệ:
- English: A1, A2, B1, B2, C1, C2
- Chinese: HSK1, HSK2, HSK3, HSK4, HSK5, HSK6
