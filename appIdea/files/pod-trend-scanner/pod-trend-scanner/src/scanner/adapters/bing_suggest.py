"""Bing autocomplete (OpenSearch JSON) — free, không key, cross-check google_suggest.

Endpoint: https://api.bing.com/osjson.aspx
Response: [query, [suggestions], [], [], {"google:suggestrelevance": [...]}]
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

ENDPOINT = "https://api.bing.com/osjson.aspx"


class BingSuggestAdapter(SourceAdapter):
    name: ClassVar[str] = "bing_suggest"
    kind: ClassVar[str] = "autocomplete"
    # Free, không tài liệu giới hạn chính thức — tự đặt an toàn 1 req/giây như các
    # nguồn autocomplete khác.
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1, per_seconds=1.0, burst=1
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "max_requests_per_run": 200,
    }

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        payload = await self.get_json(endpoint, {"query": seed})
        if not isinstance(payload, list) or len(payload) < 2:
            raise ValueError(f"response không đúng dạng JSON array: {type(payload).__name__}")
        return [
            RawItem(
                external_id=daily_external_id(self.name, endpoint, seed),
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
