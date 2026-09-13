"""Google autocomplete — cross-check với amazon_suggest, tăng n_sources.

Endpoint: https://suggestqueries.google.com/complete/search
Response là JSON array thô, phần tử [1] là danh sách gợi ý (list[str]).
"""

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

ENDPOINT = "https://suggestqueries.google.com/complete/search"


class GoogleSuggestAdapter(SourceAdapter):
    name: ClassVar[str] = "google_suggest"
    kind: ClassVar[str] = "autocomplete"
    # 1 req/giây theo docs/SOURCES.md. Vượt bị 429 tạm thời, không ban vĩnh viễn.
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1, per_seconds=1.0, burst=1
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "client": "firefox",
        "hl": "en",
        "gl": "us",
        "max_requests_per_run": 200,
    }

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        params = {
            "client": self.config["client"],
            "q": seed,
            "hl": self.config["hl"],
            "gl": self.config["gl"],
        }
        payload = await self.get_json(endpoint, params)
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError(f"response không đúng dạng JSON array: {type(payload).__name__}")
        return [
            RawItem(
                external_id=daily_external_id(self.name, endpoint, seed),
                # Bọc lại thành object để nhất quán với các adapter khác; response gốc
                # là array, giữ nguyên trong payload["raw"] để không mất thông tin.
                payload={"query": payload[0], "suggestions": payload[1], "raw": payload},
                fetched_at=utcnow(),
                seed=seed,
            )
        ]

    def extract(self, raw: RawItem) -> list[Observation]:
        suggestions = raw.payload.get("suggestions")
        if not isinstance(suggestions, list):
            return []

        observations: list[Observation] = []
        rank = 0
        for value in suggestions:
            if not isinstance(value, str) or not value.strip():
                continue
            rank += 1
            observations.append(
                Observation(text=value.strip(), observed_at=raw.fetched_at, rank=rank)
            )
        return observations
