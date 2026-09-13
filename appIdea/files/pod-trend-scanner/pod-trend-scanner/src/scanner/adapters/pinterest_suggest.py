"""Pinterest search typeahead — nguồn keyword free chính xác nhất cho wedding/birthday/gift.

Endpoint và schema response bắt được THẬT qua Chrome DevTools automation trên phiên
đã đăng nhập (không đoán cấu trúc — đúng yêu cầu docs/SOURCES.md):

    GET https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/
        ?source_url=<path hiện tại, "/" là đủ>
        &data={"options":{"pin_scope":"pins","autocomplete_request_surface":0,
                           "count":<n>,"term":"<seed>"},"context":{}}

    resource_response.data.items[]:
        - type: "query" (gợi ý cụm từ thật) hoặc "user" (khớp tên người dùng, bỏ qua)
        - query: cụm từ gợi ý (chỉ có ở type="query")
        - resultIndex: rank, đánh số từ 0
        - pin_count: LUÔN quan sát thấy bằng 0 trong mọi lần bắt thật — endpoint này
          không trả volume thật, khác với Pinterest Trends. Vì vậy value_norm vẫn tính
          theo rank như các adapter autocomplete khác, KHÔNG dùng pin_count.

    Endpoint để trong `default_config`, không hardcode trong logic parse — đúng rule 6.

**Giới hạn đã biết:** endpoint có CSRF/session check thật. Gọi không kèm cookie phiên
đăng nhập hợp lệ trả 403 "Invalid Resource Request" — đã xác nhận trực tiếp bằng cách
gọi lại đúng URL/tham số từ trong phiên browser đã đăng nhập nhưng thiếu CSRF header.
`fetch()` đọc cookie từ `PINTEREST_COOKIE` (env, không hardcode — rule 17) và tự suy ra
header `X-CSRFToken` từ cookie `csrftoken`. Chưa có cookie hợp lệ thì log và trả rỗng
(fetch_safe), không raise — đúng rule 8. Về lâu dài nên chuyển sang Playwright với
persistent context để không phải tự quản lý cookie hết hạn (khớp CLAUDE.md: "Playwright
CHỈ cho 2 adapter cần nó" — pinterest_suggest và pinterest_trends).
"""

import json
import re
from typing import Any, ClassVar

from scanner.adapters.base import (
    Observation,
    RawItem,
    SourceAdapter,
    daily_external_id,
    utcnow,
)
from scanner.core.config import get_settings
from scanner.core.log import get_logger
from scanner.core.ratelimit import RateLimitConfig

log = get_logger(__name__)

ENDPOINT = "https://www.pinterest.com/resource/AdvancedTypeaheadResource/get/"
CSRF_COOKIE_RE = re.compile(r"(?:^|;\s*)csrftoken=([^;]+)")


class PinterestNotAuthenticated(Exception):
    """Chưa có PINTEREST_COOKIE hợp lệ. Bắt ở fetch_safe, không rơi ra ngoài adapter."""


class PinterestSuggestAdapter(SourceAdapter):
    name: ClassVar[str] = "pinterest_suggest"
    kind: ClassVar[str] = "autocomplete"
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1, per_seconds=1.0, burst=1
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "source_url": "/",
        "pin_scope": "pins",
        "count": 10,
        "max_requests_per_run": 200,
    }

    def _auth_headers(self) -> dict[str, str]:
        cookie = get_settings().pinterest_cookie
        if not cookie:
            raise PinterestNotAuthenticated(
                "PINTEREST_COOKIE chưa được cấu hình — xem docstring module này"
            )
        headers = {"Cookie": cookie, "X-Requested-With": "XMLHttpRequest"}
        csrf = CSRF_COOKIE_RE.search(cookie)
        if csrf:
            headers["X-CSRFToken"] = csrf.group(1)
        return headers

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        headers = self._auth_headers()
        data = json.dumps(
            {
                "options": {
                    "pin_scope": self.config["pin_scope"],
                    "autocomplete_request_surface": 0,
                    "count": int(self.config["count"]),
                    "term": seed,
                },
                "context": {},
            }
        )
        params = {"source_url": self.config["source_url"], "data": data}
        payload = await self.get_json(endpoint, params, headers=headers)
        if not isinstance(payload, dict):
            raise ValueError(f"response không phải JSON object: {type(payload).__name__}")
        return [
            RawItem(
                external_id=daily_external_id(self.name, endpoint, seed),
                payload=payload,
                fetched_at=utcnow(),
                seed=seed,
            )
        ]

    def extract(self, raw: RawItem) -> list[Observation]:
        rr = raw.payload.get("resource_response")
        if not isinstance(rr, dict) or rr.get("status") != "success":
            return []
        items = (rr.get("data") or {}).get("items")
        if not isinstance(items, list):
            return []

        observations: list[Observation] = []
        for item in items:
            if not isinstance(item, dict) or item.get("type") != "query":
                continue
            query = item.get("query")
            if not isinstance(query, str) or not query.strip():
                continue
            result_index = item.get("resultIndex")
            rank = int(result_index) + 1 if isinstance(result_index, int) else None
            observations.append(
                Observation(text=query.strip(), observed_at=raw.fetched_at, rank=rank)
            )
        return observations
