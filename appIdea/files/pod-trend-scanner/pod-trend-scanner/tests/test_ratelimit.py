import asyncio

import pytest

from scanner.core.ratelimit import RateLimitConfig, RateLimiter


def test_config_from_sources_config() -> None:
    default = RateLimitConfig(requests=1, per_seconds=1.0, burst=1)
    cfg = RateLimitConfig.from_config(
        {"rate_limit": {"requests": 45, "per_seconds": 60, "burst": 5}}, default
    )
    assert (cfg.requests, cfg.per_seconds, cfg.burst) == (45, 60.0, 5)
    assert RateLimitConfig.from_config({}, default) == default
    assert RateLimitConfig.from_config(None, default) == default


def test_config_rejects_nonsense() -> None:
    with pytest.raises(ValueError):
        RateLimiter(RateLimitConfig(requests=0, per_seconds=1.0))


async def test_bucket_spreads_requests_over_time() -> None:
    # 50 req/giây, burst 1 -> 10 request cần ít nhất ~0.18s.
    limiter = RateLimiter(RateLimitConfig(requests=50, per_seconds=1.0, burst=1), name="test")
    loop = asyncio.get_running_loop()
    start = loop.time()
    for _ in range(10):
        async with limiter:
            pass
    elapsed = loop.time() - start
    assert elapsed >= 9 / 50 * 0.9


async def test_burst_is_capped() -> None:
    """Không request nào vượt trần: 20 request qua bucket 10/giây burst 5 mất >= ~1.4s."""
    limiter = RateLimiter(RateLimitConfig(requests=10, per_seconds=1.0, burst=5), name="test")
    loop = asyncio.get_running_loop()
    start = loop.time()
    await asyncio.gather(*(limiter.acquire() for _ in range(20)))
    elapsed = loop.time() - start
    assert elapsed >= (20 - 5) / 10 * 0.9
