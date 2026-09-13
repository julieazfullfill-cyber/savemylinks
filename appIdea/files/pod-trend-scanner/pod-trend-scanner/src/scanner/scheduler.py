"""APScheduler: collect 02:00 UTC, metrics 03:00 UTC.

Chạy: `scanner schedule`. Đây là một trong sáu tiến trình độc lập của hệ thống —
giao tiếp qua Postgres, không gọi trực tiếp dashboard hay pipeline khác. Một job lỗi
được log và bỏ qua, không làm crash tiến trình scheduler.

Giờ chạy chốt là UTC (nhất quán với toàn bộ timestamp trong hệ thống), không phải
giờ server — xem ghi chú trong README.
"""

import asyncio
import signal

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger

from scanner.adapters import REGISTRY
from scanner.core.db import dispose_engine, session_scope
from scanner.core.log import get_logger
from scanner.pipeline.collect import collect_source
from scanner.pipeline.metrics import run_metrics

log = get_logger(__name__)

COLLECT_HOUR_UTC = 2
METRICS_HOUR_UTC = 3
# Job trễ tối đa 1 giờ so với giờ chốt vẫn được chạy (máy ngủ, restart, v.v.).
MISFIRE_GRACE_SECONDS = 3600


async def run_collect_all_sources() -> None:
    """Chạy lần lượt từng nguồn đã đăng ký. Một nguồn lỗi không chặn nguồn còn lại."""
    for source_name in sorted(REGISTRY):
        try:
            stats = await collect_source(source_name)
            log.info("scheduler.collect_done", **stats.as_dict())
        except Exception as exc:  # noqa: BLE001 - lỗi 1 nguồn không được chặn nguồn khác
            log.error("scheduler.collect_failed", source=source_name, error=str(exc))


async def run_daily_metrics() -> None:
    try:
        async with session_scope() as session:
            stats = await run_metrics(session)
        log.info("scheduler.metrics_done", **stats.as_dict())
    except Exception as exc:  # noqa: BLE001 - metrics lỗi không được làm crash scheduler
        log.error("scheduler.metrics_failed", error=str(exc))


def build_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone="UTC")
    scheduler.add_job(
        run_collect_all_sources,
        CronTrigger(hour=COLLECT_HOUR_UTC, minute=0, timezone="UTC"),
        id="collect_daily",
        misfire_grace_time=MISFIRE_GRACE_SECONDS,
    )
    scheduler.add_job(
        run_daily_metrics,
        CronTrigger(hour=METRICS_HOUR_UTC, minute=0, timezone="UTC"),
        id="metrics_daily",
        misfire_grace_time=MISFIRE_GRACE_SECONDS,
    )
    return scheduler


async def run_forever() -> None:
    """Khởi động scheduler và chờ tín hiệu dừng (Ctrl+C / SIGTERM)."""
    scheduler = build_scheduler()
    scheduler.start()
    log.info(
        "scheduler.started",
        collect_hour_utc=COLLECT_HOUR_UTC,
        metrics_hour_utc=METRICS_HOUR_UTC,
    )

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop_event.set)
        except NotImplementedError:
            # Windows (ProactorEventLoop) không hỗ trợ add_signal_handler cho mọi
            # signal; Ctrl+C vẫn hoạt động qua KeyboardInterrupt, dọn ở finally bên dưới.
            pass

    try:
        await stop_event.wait()
    finally:
        scheduler.shutdown(wait=False)
        await dispose_engine()
        log.info("scheduler.stopped")


if __name__ == "__main__":
    asyncio.run(run_forever())
