# RISK_POLICY.md

Đây là phần quyết định hệ thống sống hay chết. Một takedown hoặc account strike làm mất
nhiều tiền hơn toàn bộ giá trị mà scanner tạo ra trong nhiều tháng.

## Nguyên tắc: fail-closed

Mặc định là **chặn**. Term chỉ đi tiếp khi đã qua đủ các lớp kiểm tra và có kết quả `pass`
rõ ràng. Kiểm tra không chạy được (API down, timeout) là `review`, không phải `pass`.

Không được viết code kiểu `if risk == "blocked": skip`. Phải là
`if risk != "pass": skip`.

## Bốn lớp

### Lớp 1 — Blocklist regex

Load từ `data/blocklist.yaml`, phân nhóm:

```yaml
franchises:      [danh sách studio, series, nhân vật]
music:           [tên bài hát và cụm lời phổ biến trên hàng POD]
people:          [nghệ sĩ, vận động viên, chính khách]
sports:          [tên giải, tên đội]
registered_marks: [cụm đã biết là nhãn hiệu đã đăng ký]
political:       [tên đảng, tên chiến dịch, khẩu hiệu vận động]
```

Rẻ, nhanh, chặn phần lớn trường hợp rõ ràng. Chạy trên cả `term` và trên `headline`
mà LLM sinh ra — LLM có thể tự đưa vào một cụm dính bản quyền mà term gốc không có.

### Lớp 2 — USPTO

- Tra exact phrase và bản đã chuẩn hoá — **tra local index** (bảng `uspto_trademarks`,
  xem `pipeline/uspto_index.py`), KHÔNG gọi live API. Live API (`api.uspto.gov`) và cả
  trang browse bulk data (`data.uspto.gov`) đòi tài khoản USPTO.gov + MFA kể từ
  2026-06-18 — xác nhận thật, không phải đoán. Local index nạp từ file bulk XML chính
  thức ("Trademark Full Text XML Data") tự tải không cần tài khoản, qua lệnh
  `scanner uspto-index --file ...`.
- Lọc theo class 25 (hàng may mặc); thêm class 21 và 20 nếu bán mug và đồ gỗ
- Cache kết quả 30 ngày (dùng `risk_flags`, xem ghi chú trong `pipeline/risk.py`)
- Trạng thái LIVE → `block`. Trạng thái DEAD → `info`, vẫn cho qua nhưng ghi log.
- Lỗi tra cứu (DB lỗi) → `review`. **Không tìm thấy match trong index cũng phải
  `review`, KHÔNG được coi là DEAD/pass**, trừ khi operator tự xác nhận đã nạp đủ toàn
  bộ bulk data (`USPTO_INDEX_COVERAGE_COMPLETE=true`) — index mới nạp một phần thì
  "không tìm thấy" không phải bằng chứng nhãn hiệu không tồn tại.

### Lớp 3 — LLM phân loại nguồn gốc

Câu hỏi duy nhất: cụm này xuất phát từ phim, nhạc, người thật, thương hiệu, hay là
ngôn ngữ generic?

Output: `generic` | `derived_from_media` | `proper_noun` | `unknown`

Chỉ `generic` mới đi tiếp tự động. Ba loại còn lại chuyển sang người duyệt.
Đây không phải kết luận pháp lý, chỉ là bộ lọc. Prompt phải yêu cầu LLM nghiêng về
báo động nhầm hơn là bỏ sót.

### Lớp 4 — Người duyệt

Bắt buộc với T2 và T3. Không có đường tắt, không có chế độ auto cho hai tier này.
`candidates.approved_by` không được null trước khi export.

## Bảng tier

| Tier | Nội dung | Lớp bắt buộc | Auto-approve |
|---|---|---|---|
| T0 | Generic + cá nhân hoá (wedding, birthday, custom photo) | 1 | Có, nếu không có danh từ riêng |
| T1 | Humor theo nghề nghiệp / sở thích | 1, 2 | Có |
| T2 | Liên quan pop culture, thẩm mỹ đang thịnh | 1, 2, 3, 4 | Không |
| T3 | Chính trị, sự kiện thời sự, người nổi tiếng, lời bài hát, franchise | 1, 2, 3, 4 | Không |

## Quy tắc riêng cho T3

Mảng rủi ro cao nhất trong hệ thống. Ba lý do cụ thể:

1. Khẩu hiệu chiến dịch thường được chính campaign và PAC đăng ký làm nhãn hiệu
2. Các marketplace có chính sách riêng hạn chế merchandise chính trị
3. Vòng đời thương mại của một slogan cụ thể chỉ khoảng 8-12 tuần

Chặn cứng, không có ngoại lệ:
- Tên ứng viên hoặc người đang giữ chức vụ
- Tên đảng và logo đảng
- Mọi khẩu hiệu vận động, cũ hay mới
- Tên PAC hoặc phong trào đã đăng ký
- Hình ảnh người thật nhận diện được

Nội dung T3 duy nhất được phép là evergreen phi đảng phái: veteran, first responder,
patriotic chung, americana. Những thứ này bán quanh năm và không phụ thuộc vào ứng viên,
đảng, hay kết quả bầu cử nào.

## Tách biệt vận hành

Đây là khuyến nghị ngoài phạm vi code nhưng cần ghi lại vì nó ảnh hưởng tới thiết kế
export: **nhóm mở rộng (funny tee, pop culture, political) không được chạy chung store,
chung brand, chung tài khoản thanh toán với ba niche core.**

Một strike bên funny hoặc political không được phép chạm tới mảng wedding/photo đang
nuôi cả business. Vì vậy export phải gắn `target_store` theo tier, và dashboard phải
hiển thị rõ brief này sẽ đi về store nào.

## Test bắt buộc

- Bộ 20 cụm đã biết là dính nhãn hiệu: hệ thống bắt được ≥ 18
- Bộ 20 cụm generic vô hại: false positive ≤ 4
- USPTO không tìm thấy match trong local index và index chưa xác nhận phủ đủ → term
  rơi vào `review`, khẳng định không có đường nào ra `pass`
- Term T3 → không tồn tại code path nào cho phép export mà `approved_by IS NULL`
