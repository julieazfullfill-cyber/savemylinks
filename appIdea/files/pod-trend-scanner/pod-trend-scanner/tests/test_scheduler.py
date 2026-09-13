"""Test cho scheduler.py — không khởi động thật, chỉ kiểm tra cấu hình job và
hành vi chịu lỗi. Không gọi network hay DB thật."""

from contextlib import asynccontextmanager
from collections.abc import AsyncIterator
from typing import Any

import pytest
from apscheduler.triggers.cron import CronTrigger

from scanner import scheduler as scheduler_module
from scanner.adapters import REGISTRY
from scanner.pipeline.collect import CollectStats


def test_build_scheduler_registers_collect_and_metrics_jobs() -> None:
    sched = scheduler_module.build_scheduler()
    jobs = {job.id: job for job in sched.get_jobs()}

    assert set(jobs) == {"collect_daily", "metrics_daily"}

    collect_trigger = jobs["collect_daily"].trigger
    metrics_trigger = jobs["metrics_daily"].trigger
    assert isinstance(collect_trigger, CronTrigger)
    assert isinstance(metrics_trigger, CronTrigger)

    def field_value(trigger: CronTrigger, name: str) -> str:
        return str(next(f for f in trigger.fields if f.name == name))

    assert field_value(collect_trigger, "hour") == str(scheduler_module.COLLECT_HOUR_UTC)
    assert field_value(metrics_trigger, "hour") == str(scheduler_module.METRICS_HOUR_UTC)
    assert str(collect_trigger.timezone) == "UTC"
    assert str(metrics_trigger.timezone) == "UTC"


async def test_collect_all_sources_continues_when_one_source_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[str] = []

    async def fake_collect_source(source_name: str, **kwargs: Any) -> CollectStats:
        calls.append(source_name)
        if source_name == sorted(REGISTRY)[0]:
            raise RuntimeError("nguồn này chết hẳn, không phải lỗi từng seed")
        return CollectStats(source=source_name, seeds=1, fetched=1)

    monkeypatch.setattr(scheduler_module, "collect_source", fake_collect_source)

    await scheduler_module.run_collect_all_sources()

    assert calls == sorted(REGISTRY)  # mọi nguồn đều được thử, kể cả sau khi 1 nguồn raise


async def test_daily_metrics_failure_is_caught_and_logged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("DB down")

    @asynccontextmanager
    async def fake_session_scope() -> AsyncIterator[None]:
        yield None

    # Không dùng session_scope thật ở đây — test này chỉ kiểm tra run_daily_metrics
    # không để lỗi thoát ra ngoài, không cần một session/engine Postgres thật.
    monkeypatch.setattr(scheduler_module, "session_scope", fake_session_scope)
    monkeypatch.setattr(scheduler_module, "run_metrics", boom)

    # Không được raise ra ngoài — scheduler phải sống sót qua job lỗi.
    await scheduler_module.run_daily_metrics()
