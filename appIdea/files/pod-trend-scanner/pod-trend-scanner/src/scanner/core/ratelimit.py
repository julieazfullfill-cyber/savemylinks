"""Token bucket theo từng source.

Bị chặn IP là mất nguồn dữ liệu nhiều tuần, đắt hơn nhiều so với chạy chậm.
Mọi adapter phải `async with self.rate_limit:` trước mỗi request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from types import TracebackType
from typing import Any, Self

from scanner.core.log import get_logger

log = get_logger(__name__)

# Sai số làm tròn số thực có thể khiến tokens dừng ở kiểu 0.9999999999999998 mãi
# mãi không chạm 1.0 — không có ngưỡng này thì acquire() lặp vô hạn với wait ~ 0.
_TOKEN_EPSILON = 1e-9


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
    """Token bucket. Refill liên tục với tốc độ requests/per_seconds.

    `now_fn`/`sleep_fn` chỉ dùng cho test — mô phỏng đồng hồ ảo để kiểm tra hành vi
    trên cửa sổ dài (ví dụ 45 req/60s của Pinterest Trends) mà không phải chờ thật.
    Mặc định dùng đồng hồ event loop thật.
    """

    def __init__(
        self,
        config: RateLimitConfig,
        name: str = "",
        now_fn: Callable[[], float] | None = None,
        sleep_fn: Callable[[float], Awaitable[None]] | None = None,
    ) -> None:
        if config.requests <= 0 or config.per_seconds <= 0:
            raise ValueError("requests và per_seconds phải > 0")
        self.name = name
        self.config = config
        self._capacity = float(max(config.burst, 1))
        self._tokens = self._capacity
        self._rate = config.requests / config.per_seconds
        self._lock = asyncio.Lock()
        self._updated_at: float | None = None
        self._now_fn = now_fn or (lambda: asyncio.get_running_loop().time())
        self._sleep_fn = sleep_fn or asyncio.sleep

    def _now(self) -> float:
        return self._now_fn()

    async def acquire(self) -> float:
        """Chờ tới khi có token, trả về timestamp (theo `now_fn`) lúc được cấp."""
        while True:
            async with self._lock:
                now = self._now()
                if self._updated_at is None:
                    self._updated_at = now
                elapsed = now - self._updated_at
                self._updated_at = now
                self._tokens = min(self._capacity, self._tokens + elapsed * self._rate)
                if self._tokens >= 1.0 - _TOKEN_EPSILON:
                    self._tokens = max(0.0, self._tokens - 1.0)
                    return now
                wait = (1.0 - self._tokens) / self._rate
            log.debug("ratelimit.wait", source=self.name, seconds=round(wait, 3))
            await self._sleep_fn(wait)

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
