import asyncio
import bisect

import pytest

from scanner.core.ratelimit import RateLimitConfig, RateLimiter


class VirtualClock:
    """Đồng hồ ảo: acquire() được test đẩy thời gian thay vì chờ thật.

    Cho phép mô phỏng cửa sổ dài (ví dụ 100 request Pinterest trong 1 phút) tức thời
    thay vì tốn hàng chục giây chờ thật.
    """

    def __init__(self) -> None:
        self.now = 0.0

    def time(self) -> float:
        return self.now

    async def sleep(self, seconds: float) -> None:
        self.now += seconds


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


async def test_pinterest_config_never_exceeds_cap_in_any_60s_window() -> None:
    """Mô phỏng 100 request Pinterest trong ~1 phút bằng đồng hồ ảo.

    Cấu hình lấy đúng từ docs/SOURCES.md: trần thực tế ~57 req/cửa sổ trượt, token
    bucket đặt an toàn ở 45 req/60s, burst 5.
    """
    clock = VirtualClock()
    limiter = RateLimiter(
        RateLimitConfig(requests=45, per_seconds=60.0, burst=5),
        name="pinterest_trends",
        now_fn=clock.time,
        sleep_fn=clock.sleep,
    )

    granted_at: list[float] = []
    for _ in range(100):
        granted_at.append(await limiter.acquire())

    assert granted_at == sorted(granted_at)

    # Cận đúng của token bucket cho một cửa sổ trượt độ dài T là burst + rate*T, không
    # phải chỉ "requests" — burst cho phép dồn 5 request liền nhau ở đầu cửa sổ, sau
    # đó chảy đều theo rate. Với burst=5, requests=45/60s: cận = 5 + 45 = 50 trong bất
    # kỳ cửa sổ 60s nào. Đây vẫn an toàn so với trần thực tế ~57 req của Pinterest.
    window = 60.0
    bound = 45 + 5
    assert bound <= 57, "cấu hình đã chọn phải còn margin so với trần thực tế 57"
    for i, t in enumerate(granted_at):
        lo = bisect.bisect_left(granted_at, t - window)
        in_window = i - lo + 1
        assert in_window <= bound, f"vượt trần tại request {i}: {in_window} request trong 60s"

    # 100 request ở 45/60s (burst 5) tối thiểu mất (100-5)/45*60 giây thật (mô phỏng).
    assert clock.now >= (100 - 5) / 45 * 60 * 0.99
