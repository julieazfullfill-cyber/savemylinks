"""Pinterest Trends — search volume theo từng seed, public, không cần đăng nhập.

Endpoint bắt được THẬT: dùng Playwright thật (không phải claude-in-chrome — UI
trends.pinterest.com không render trong môi trường đó, xem docs/SOURCES.md) để bắt
network request khi trang tự tải, phát hiện endpoint REST đơn giản
`https://trends.pinterest.com/metrics/` (khác hẳn các endpoint nội bộ
`resource/ApiResource/get/` bị CSRF chặn). Xác nhận lại bằng cách gọi trực tiếp qua
httpx thuần — KHÔNG cookie, KHÔNG browser, KHÔNG CSRF token — vẫn trả 200 với seed
tự chọn (đã thử "bridesmaid proposal box", không nằm trong bất kỳ danh sách nào
Pinterest tự gợi ý). 2026-09-13.

    GET https://trends.pinterest.com/metrics/
        ?terms=<seed>            (nhiều seed: nối bằng dấu phẩy, url-encode)
        &country=US
        &end_date=<YYYY-MM-DD>   (hôm nay, UTC)
        &days=365                 (-> 52-53 tuần lịch sử thật, đã xác nhận thật sự
                                    nhận được 53 điểm, vượt yêu cầu 52 tuần)
        &aggregation=2
        &normalize_against_group=false
        &predicted_days=0

    Response: JSON array — MỘT PHẦN TỬ MỖI TERM CÓ ĐỦ DỮ LIỆU. Term quá ít volume bị
    bỏ khỏi response lặng lẽ, không phải lỗi (đã xác nhận: gửi 20 seed thật, chỉ 11
    seed có mặt trong response — extract() phải chịu được việc "seed gửi lên nhưng
    không có trong response", không coi đó là lỗi).

    Mỗi phần tử:
        - term: đúng chuỗi seed đã gửi
        - has_prediction: bool
        - growth_rates: {wow_change, mom_change, yoy_change} — momentum tuần/tháng/năm,
          đúng mô tả trong docs/DATA_MODEL.md (hiện chưa dùng field này, xem TODO dưới)
        - counts: list các điểm TUẦN {date, count, normalizedCount,
          predictedUpperBoundNormalizedCount, predictedLowerBoundNormalizedCount}.
          predictedUpperBound/LowerBound khác null nghĩa là điểm dự đoán tương lai —
          extract() loại các điểm này dù `predicted_days=0` trong query lẽ ra đã loại
          từ phía server (phòng trường hợp Pinterest đổi hành vi).

TODO (chưa làm trong lần build này): `growth_rates.wow_change/mom_change` là tín hiệu
momentum có sẵn, có thể dùng bổ sung cho velocity thay vì chỉ dựa vào hồi quy tuyến
tính trong pipeline/metrics.py — để dành xem xét khi có dữ liệu thật chạy vài tuần.

**`end_date` phải là một ngày Thứ Sáu đã "publish" xong (xác nhận thật, không đoán):**
Pinterest tổng hợp dữ liệu theo tuần, mốc tuần là Thứ Sáu, và có độ trễ publish — thử
trực tiếp `end_date=` hôm nay (Chủ Nhật) và cả Thứ Sáu gần nhất (2 ngày trước) đều trả
`400`, trong khi Thứ Sáu tuần trước đó (9 ngày trước) trả `200`. Độ trễ chính xác không
cố định nên KHÔNG hardcode số ngày — `fetch()` thử lùi dần từng tuần (tối đa 4 tuần)
cho tới khi có `200`, dừng ngay khi thành công.
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any, ClassVar

import httpx

from scanner.adapters.base import (
    Observation,
    RawItem,
    SourceAdapter,
    daily_external_id,
    utcnow,
)
from scanner.core.log import get_logger
from scanner.core.ratelimit import RateLimitConfig

log = get_logger(__name__)

ENDPOINT = "https://trends.pinterest.com/metrics/"
MAX_END_DATE_LOOKBACK_WEEKS = 4


class PinterestTrendsAdapter(SourceAdapter):
    name: ClassVar[str] = "pinterest_trends"
    kind: ClassVar[str] = "trends"
    # Rate limit thực tế của trends.pinterest.com: khoảng 57 request/cửa sổ trượt theo
    # IP (docs/SOURCES.md, đo được khi khảo sát domain này nói chung). Đặt an toàn ở 45.
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=45, per_seconds=60.0, burst=5
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "country": "US",
        "days": 365,
        "aggregation": 2,
        "max_requests_per_run": 200,
    }

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        end_date = _latest_friday_on_or_before(utcnow().date())

        payload: Any = None
        last_error: httpx.HTTPStatusError | None = None
        for attempt in range(MAX_END_DATE_LOOKBACK_WEEKS):
            params = {
                "terms": seed,
                "country": self.config["country"],
                "end_date": end_date.isoformat(),
                "days": self.config["days"],
                "aggregation": self.config["aggregation"],
                "normalize_against_group": "false",
                "predicted_days": 0,
            }
            try:
                payload = await self.get_json(endpoint, params)
                break
            except httpx.HTTPStatusError as exc:
                if exc.response.status_code != 400 or attempt == MAX_END_DATE_LOOKBACK_WEEKS - 1:
                    raise
                # Tuần này Pinterest chưa publish xong -> lùi 1 tuần thử lại.
                last_error = exc
                log.debug(
                    "pinterest_trends.end_date_not_ready",
                    end_date=end_date.isoformat(),
                    attempt=attempt,
                )
                end_date -= timedelta(days=7)
        else:  # pragma: no cover - vòng for luôn break hoặc raise trước khi hết vòng
            if last_error is not None:
                raise last_error

        if not isinstance(payload, list):
            raise ValueError(f"response không phải JSON array: {type(payload).__name__}")
        return [
            RawItem(
                external_id=daily_external_id(self.name, endpoint, seed),
                payload={"items": payload},
                fetched_at=utcnow(),
                seed=seed,
            )
        ]

    def extract(self, raw: RawItem) -> list[Observation]:
        items = raw.payload.get("items")
        if not isinstance(items, list):
            return []

        observations: list[Observation] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            term = item.get("term")
            counts = item.get("counts")
            if not isinstance(term, str) or not term.strip() or not isinstance(counts, list):
                continue
            text = term.strip()

            for point in counts:
                obs_date, count = _history_point(point)
                if obs_date is None or count is None:
                    continue
                observed_at = datetime(
                    obs_date.year, obs_date.month, obs_date.day, 12, tzinfo=UTC
                )
                observations.append(
                    Observation(text=text, observed_at=observed_at, value=Decimal(str(count)))
                )
        return observations


def _latest_friday_on_or_before(d: date) -> date:
    """Thứ Sáu gần nhất tính tới ngày `d` (bao gồm chính `d` nếu `d` là Thứ Sáu).

    weekday(): Monday=0 .. Sunday=6, Friday=4.
    """
    offset = (d.weekday() - 4) % 7
    return d - timedelta(days=offset)


def _history_point(point: Any) -> tuple[date | None, float | None]:
    """(ngày, count) nếu là điểm lịch sử thật; (None, None) nếu là điểm dự đoán tương
    lai (predictedUpperBound/LowerBoundNormalizedCount khác null) hoặc thiếu dữ liệu."""
    if not isinstance(point, dict):
        return None, None
    if point.get("predictedUpperBoundNormalizedCount") is not None:
        return None, None
    if point.get("predictedLowerBoundNormalizedCount") is not None:
        return None, None
    count = point.get("count")
    raw_date = point.get("date")
    if not isinstance(count, int | float) or not isinstance(raw_date, str):
        return None, None
    try:
        return date.fromisoformat(raw_date), float(count)
    except ValueError:
        return None, None
