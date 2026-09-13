"""Token bucket theo từng source.

Bị chặn IP là mất nguồn dữ liệu nhiều tuần, đắt hơn nhiều so với chạy chậm.
Mọi adapter phải `async with self.rate_limit:` trước mỗi request.
"""

import asyncio
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self

from scanner.core.log import get_logger

log = get_logger(__name__)


@dataclass(frozen=True)
class RateLimitConfig:
    requests: int
    per_seconds: float
    burst: int = 1

    @classmethod
    def from_config(cls, config: dict[str, Any] | None, default: "RateLimitConfig") -> "RateLimitConfig":
        """Đọc `sources.config.rate_limit`, thiếu field nào thì lấy của default."""
        raw = (config or {}).get("rate_limit") or {}
        if not isinstance(raw, dict):
            return default
        return cls(
            requests=int(raw.get("requests", default.requests)),
            per_seconds=float(raw.get("per_seconds", default.per_seconds)),
            burst=int(raw.get("burst", default.burst)),
        )


class RateLimiter:
    """Token bucket. Refill liên tục với tốc độ requests/per_seconds."""

    def __init__(self, config: RateLimitConfig, name: str = "") -> None:
        if config.requests <= 0 or config.per_seconds <= 0:
            raise ValueError("requests và per_seconds phải > 0")
        self.name = name
        self.config = config
        self._capacity = float(max(config.burst, 1))
        self._tokens = self._capacity
        self._rate = config.requests / config.per_seconds
        self._lock = asyncio.Lock()
        self._updated_at: float | None = None

    def _now(self) -> float:
        return asyncio.get_running_loop().time()

    async def acquire(self) -> None:
        while True:
            async with self._lock:
                now = self._now()
                if self._updated_at is None:
                    self._updated_at = now
                elapsed = now - self._updated_at
                self._updated_at = now
                self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / self._rate
            log.debug("ratelimit.wait", source=self.name, seconds=round(wait, 3))
            await asyncio.sleep(wait)

    async def __aenter__(self) -> Self:
        await self.acquire()
        return self

    async def __aexit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        tb: TracebackType | None,
    ) -> None:
        return None
