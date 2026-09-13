"""Interface chung cho mọi nguồn.

`fetch` chỉ lấy dữ liệu, `extract` chỉ parse. Adapter KHÔNG ghi DB, KHÔNG gọi adapter khác.
Adapter fail thì log và trả list rỗng — một nguồn chết không được làm hỏng cả lượt collect.
"""

import hashlib
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, ClassVar

import httpx
from tenacity import (
    AsyncRetrying,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from scanner.core.config import get_settings
from scanner.core.log import get_logger
from scanner.core.normalize import normalize
from scanner.core.ratelimit import RateLimitConfig, RateLimiter

log = get_logger(__name__)

RETRYABLE_STATUS = frozenset({429, 500, 502, 503, 504})


class RetryableHTTPError(Exception):
    """Lỗi tạm thời, đáng retry."""


@dataclass(frozen=True)
class RawItem:
    """Một response thô từ nguồn. Ghi thẳng vào `raw_items`, không chỉnh sửa."""

    external_id: str
    payload: dict[str, Any]
    fetched_at: datetime
    seed: str | None = None


@dataclass(frozen=True)
class Observation:
    """Một term quan sát được trong raw item."""

    text: str
    observed_at: datetime
    rank: int | None = None
    value: Decimal | None = None
    meta: dict[str, Any] = field(default_factory=dict)


def utcnow() -> datetime:
    return datetime.now(UTC)


def daily_external_id(source: str, endpoint: str, seed: str, day: date | None = None) -> str:
    """id ổn định theo ngày: chạy lại collector trong cùng ngày không sinh dòng trùng."""
    seed_norm, _ = normalize(seed)
    day = day or utcnow().date()
    payload = f"{source}|{endpoint}|{seed_norm}|{day.isoformat()}"
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_http_client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        timeout=settings.http_timeout_seconds,
        headers={
            "User-Agent": settings.http_user_agent,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-US,en;q=0.9",
        },
        follow_redirects=True,
    )


class SourceAdapter(ABC):
    name: ClassVar[str]
    kind: ClassVar[str]
    default_rate_limit: ClassVar[RateLimitConfig]
    default_config: ClassVar[dict[str, Any]] = {}

    def __init__(
        self,
        client: httpx.AsyncClient | None = None,
        config: dict[str, Any] | None = None,
    ) -> None:
        self.config: dict[str, Any] = {**self.default_config, **(config or {})}
        self.rate_limit = RateLimiter(
            RateLimitConfig.from_config(self.config, self.default_rate_limit), name=self.name
        )
        self._client = client
        self._owns_client = client is None

    @property
    def client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = build_http_client()
        return self._client

    async def aclose(self) -> None:
        if self._client is not None and self._owns_client:
            await self._client.aclose()
            self._client = None

    def source_row(self) -> dict[str, Any]:
        """Dòng tương ứng trong bảng `sources`."""
        rl = self.default_rate_limit
        config = dict(self.default_config)
        config.setdefault(
            "rate_limit",
            {"requests": rl.requests, "per_seconds": rl.per_seconds, "burst": rl.burst},
        )
        return {"name": self.name, "kind": self.kind, "config": config}

    @abstractmethod
    async def fetch(self, seed: str) -> list[RawItem]:
        """Gọi nguồn, trả raw item. Không parse, không ghi DB."""

    @abstractmethod
    def extract(self, raw: RawItem) -> list[Observation]:
        """Parse raw item thành observation. Thuần, không I/O."""

    async def fetch_safe(self, seed: str) -> list[RawItem]:
        try:
            return await self.fetch(seed)
        except Exception as exc:  # noqa: BLE001 - rule 8: không raise ra ngoài adapter
            log.warning("adapter.fetch_failed", source=self.name, seed=seed, error=str(exc))
            return []

    def extract_safe(self, raw: RawItem) -> list[Observation]:
        try:
            return self.extract(raw)
        except Exception as exc:  # noqa: BLE001
            log.warning(
                "adapter.extract_failed",
                source=self.name,
                external_id=raw.external_id,
                error=str(exc),
            )
            return []

    async def get_json(
        self, url: str, params: dict[str, Any], headers: dict[str, str] | None = None
    ) -> Any:
        """GET có rate limit + retry backoff. Dùng chung cho adapter HTTP.

        `headers` merge thêm vào header mặc định của client (không ghi đè User-Agent
        trừ khi tự truyền) — dùng khi một nguồn cần header riêng, ví dụ cookie phiên.
        """
        async for attempt in AsyncRetrying(
            stop=stop_after_attempt(3),
            wait=wait_exponential(multiplier=1, min=1, max=8),
            retry=retry_if_exception_type((httpx.TransportError, RetryableHTTPError)),
            reraise=True,
        ):
            with attempt:
                async with self.rate_limit:
                    response = await self.client.get(url, params=params, headers=headers)
                if response.status_code in RETRYABLE_STATUS:
                    raise RetryableHTTPError(f"{response.status_code} từ {url}")
                response.raise_for_status()
                return response.json()
        raise RetryableHTTPError(f"không lấy được {url}")
