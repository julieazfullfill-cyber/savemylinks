"""Amazon autocomplete — nguồn đầu tiên, ý định mua thật, sát POD nhất.

Endpoint: https://completion.amazon.com/api/2017/suggestions
Cần User-Agent trình duyệt thật, mặc định của httpx bị chặn.
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

ENDPOINT = "https://completion.amazon.com/api/2017/suggestions"
US_MARKETPLACE_ID = "ATVPDKIKX0DER"


class AmazonSuggestAdapter(SourceAdapter):
    name: ClassVar[str] = "amazon_suggest"
    kind: ClassVar[str] = "autocomplete"
    # 1 req/giây theo docs/SOURCES.md, tối đa 200 req mỗi lượt collect.
    default_rate_limit: ClassVar[RateLimitConfig] = RateLimitConfig(
        requests=1, per_seconds=1.0, burst=1
    )
    default_config: ClassVar[dict[str, Any]] = {
        "endpoint": ENDPOINT,
        "mid": US_MARKETPLACE_ID,
        "alias": "aps",
        "limit": 11,
        "lop": "en_US",
        "max_requests_per_run": 200,
    }

    async def fetch(self, seed: str) -> list[RawItem]:
        endpoint = str(self.config["endpoint"])
        params = {
            "limit": self.config["limit"],
            "prefix": seed,
            "alias": self.config["alias"],
            "mid": self.config["mid"],
            "lop": self.config["lop"],
            "site-variant": "desktop",
            "client-info": "amazon-search-ui",
        }
        payload = await self.get_json(endpoint, params)
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
        suggestions = raw.payload.get("suggestions")
        if not isinstance(suggestions, list):
            return []

        observations: list[Observation] = []
        rank = 0
        for item in suggestions:
            if not isinstance(item, dict) or item.get("ghost") is True:
                continue
            if item.get("type") not in (None, "KEYWORD"):
                continue
            value = item.get("value")
            if not isinstance(value, str) or not value.strip():
                continue
            rank += 1
            observations.append(
                Observation(
                    text=value.strip(),
                    observed_at=raw.fetched_at,
                    rank=rank,
                    meta={"strategy_id": item.get("strategyId")},
                )
            )
        return observations
