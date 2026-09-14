"""Google Trends "Trending Now" — danh sách chủ đề đang trend, public, không cần key.

Endpoint bắt được THẬT (curl thuần, không cần Playwright/cookie, 2026-09-14):

    GET https://trends.google.com/trending?geo=US

API cũ (`trends.google.com/trends/api/dailytrends`, `.../realtimetrends`, thứ
`pytrends` vẫn bọc) đã bị gỡ — xác nhận thật, cả hai trả 404. Google Trends đổi hẳn
sang trang mới "Trending Now" (`trends.google.com/trending`), không còn REST API JSON
riêng công khai. Trang mới render server-side và nhúng thẳng dữ liệu vào HTML qua khối
JS chuẩn của nhiều sản phẩm Google khác (Gmail, Maps) để bootstrap dữ liệu ban đầu:

    AF_initDataCallback({key: 'ds:0', hash: '...', data: [...], sideChannel: {}});

Không cần cookie, không cần JS thật thực thi — chỉ cần GET trang rồi regex + json.loads
khối `data`. Đã xác nhận thật: 653 chủ đề cho geo=US lúc test, mỗi phần tử là một mảng
cố định (thứ tự phần tử trong mảng CHÍNH LÀ rank — mục đầu tiên là chủ đề đang hot
nhất):
    [0]  term chính (string)
    [2]  geo ("US")
    [3]  [unix_timestamp bắt đầu trend]
    [6]  ước lượng search volume (số nguyên đã làm tròn bậc, vd 2000000/500000/1000000)
    [9]  mảng cụm từ liên quan (breakdown queries, có thể tới 100+ phần tử)
    [12] term chính (lặp lại, dạng chuẩn hoá)
Chỉ lưu vài cụm liên quan đầu vào `meta` của observation chính, KHÔNG tách breakdown
queries thành observation riêng — 653 chủ đề × tới 100+ liên quan/chủ đề sẽ ngập bảng
`terms` với phần lớn là noise (tên cầu thủ, số liệu trận đấu...) không liên quan POD.

**Không seed nào cả — per_seed=False**, dùng đúng cơ chế snapshot-theo-quốc-gia đã có
sẵn trong framework (`adapters/base.py` + `pipeline/collect.py`, trước đây định hình
cho pinterest_trends nhưng adapter đó cuối cùng lại theo seed — đây là nguồn ĐẦU TIÊN
thật sự dùng nhánh per_seed=False). Term thu được ở đây KHÔNG gắn niche nào — đúng
thiết kế fail-closed sẵn có: `risk.py.determine_risk_tier` coi term không gắn seed là
T2, bắt buộc qua đủ 4 lớp + người duyệt trước khi export. Đây là nguồn phát hiện chủ đề
MỚI ngoài phạm vi seed list; người vận hành xem ở dashboard rồi tự quyết định có thêm
seed theo hướng đó không (`/seeds`) — không có gì tự động publish.

Phần lớn "Trending Now" là tin thời sự/thể thao/người nổi tiếng (tên riêng dày đặc —
"cowboys", "dallas cowboys", tên nghệ sĩ...) — CHÍNH XÁC loại nội dung Lớp 1 blocklist
+ Lớp 3 LLM origin classification được thiết kế để bắt. Không tắt bớt lọc cho nguồn này.

**TikTok Creative Center — KHÔNG làm được trong lần build này.** Xem
docs/SOURCES.md phần tiktok_creative_center để biết chi tiết: trang chặn cả Playwright
headless thật (403, Chromium thật không phải giả lập), API nội bộ đoán được
(`creative_radar_api/v1/popular_trend/hashtag/list`) trả "no permission" — cần token
chống-bot sinh bằng JS phía client, không có cookie nào server set sẵn để dùng làm
điểm khởi đầu. Bot-detection thật (đã thử thật, không phải đoán) — không cố vượt qua
bằng kỹ thuật giả lập fingerprint trình duyệt.
"""

import json
import re
from datetime import datetime
from decimal import Decimal
from typing import Any, ClassVar

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

ENDPOINT = "https://trends.google.com/trending"

# Khối JS bootstrap dữ liệu ds:0 — xem docstring module.
_DS0_RE = re.compile(r"AF_initDataCallback\(\{key: 'ds:0'.*?data:(\[.*?\]), sideChannel", re.S)


class GoogleTrendingNowAdapter(SourceAdapter):
    name: ClassVar[str] = "google_trending_now"
    kind: ClassVar[str] = "trending"
    per_seed: ClassVar[bool] = False
    # Chỉ gọi tối đa 1 lần/lượt collect (per_seed=False) -- giới hạn rộng rãi, không
    # có ý nghĩa thực tế bảo vệ gì nhiều, chỉ để nhất quán interface RateLimiter.
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=5, per_seconds=60.0, burst=2
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "geo": "US",
        # Chặn bớt số Term mới tạo ra mỗi ngày -- 653 chủ đề/lượt test thật là quá
        # nhiều để đưa hết vào review queue mỗi ngày; giữ top N theo rank (đã hot nhất).
        "max_terms_per_run": 150,
    }

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        geo = str(self.config["geo"])
        async with self.rate_limit:
            response = await self.client.get(endpoint, params={"geo": geo})
        response.raise_for_status()
        entries = _parse_trending_entries(response.text)
        if not entries:
            raise ValueError(
                "không tìm thấy khối dữ liệu ds:0 trong trang -- Google có thể đã đổi cấu trúc"
            )
        return [
            RawItem(
                external_id=daily_external_id(self.name, endpoint, geo),
                payload={"entries": entries},
                fetched_at=utcnow(),
                seed=None,
            )
        ]

    def extract(self, raw: RawItem) -> list[Observation]:
        entries = raw.payload.get("entries")
        if not isinstance(entries, list):
            return []
        max_terms = int(self.config.get("max_terms_per_run", 150) or 150)
        now = utcnow()
        observations: list[Observation] = []
        for rank, entry in enumerate(entries[:max_terms], start=1):
            obs = _entry_to_observation(entry, rank, now)
            if obs is not None:
                observations.append(obs)
        return observations


def _parse_trending_entries(html: str) -> list[Any]:
    """Thuần, test được offline với HTML fixture thật trích từ response thật."""
    match = _DS0_RE.search(html)
    if not match:
        return []
    try:
        parsed = json.loads(match.group(1))
    except json.JSONDecodeError:
        return []
    if not isinstance(parsed, list) or len(parsed) < 2 or not isinstance(parsed[1], list):
        return []
    return parsed[1]


def _entry_to_observation(entry: Any, rank: int, observed_at: datetime) -> Observation | None:
    if not isinstance(entry, list) or len(entry) < 7:
        return None
    term = entry[0]
    if not isinstance(term, str) or not term.strip():
        return None
    volume = entry[6]
    value = Decimal(str(volume)) if isinstance(volume, int | float) else None
    related_raw = entry[9] if len(entry) > 9 and isinstance(entry[9], list) else []
    related = [r for r in related_raw[:5] if isinstance(r, str)]
    return Observation(
        text=term.strip(),
        observed_at=observed_at,
        rank=rank,
        value=value,
        meta={"related": related} if related else {},
    )
