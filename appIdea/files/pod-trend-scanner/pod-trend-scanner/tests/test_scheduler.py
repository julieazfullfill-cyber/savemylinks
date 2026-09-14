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


def test_build_scheduler_registers_all_pipeline_jobs() -> None:
    sched = scheduler_module.build_scheduler()
    jobs = {job.id: job for job in sched.get_jobs()}

    assert set(jobs) == {"collect_daily", "metrics_daily", "enrich_daily", "score_daily"}
    assert all(isinstance(job.trigger, CronTrigger) for job in jobs.values())
    assert all(str(job.trigger.timezone) == "UTC" for job in jobs.values())

    def field_value(trigger: CronTrigger, name: str) -> str:
        return str(next(f for f in trigger.fields if f.name == name))

    assert field_value(jobs["collect_daily"].trigger, "hour") == str(
        scheduler_module.COLLECT_HOUR_UTC
    )
    assert field_value(jobs["metrics_daily"].trigger, "hour") == str(
        scheduler_module.METRICS_HOUR_UTC
    )
    assert field_value(jobs["enrich_daily"].trigger, "hour") == str(
        scheduler_module.ENRICH_HOUR_UTC
    )
    assert field_value(jobs["score_daily"].trigger, "hour") == str(scheduler_module.SCORE_HOUR_UTC)

    # Thứ tự trong ngày: collect < metrics < enrich < score, đúng pipeline diagram.
    hours = [
        (
            int(field_value(jobs[job_id].trigger, "hour")),
            int(field_value(jobs[job_id].trigger, "minute")),
        )
        for job_id in ("collect_daily", "metrics_daily", "enrich_daily", "score_daily")
    ]
    assert hours == sorted(hours)


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


async def test_daily_enrich_failure_is_caught_and_logged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("network down")

    @asynccontextmanager
    async def fake_session_scope() -> AsyncIterator[None]:
        yield None

    monkeypatch.setattr(scheduler_module, "session_scope", fake_session_scope)
    monkeypatch.setattr(scheduler_module, "enrich_top_terms", boom)

    await scheduler_module.run_daily_enrich()  # không được raise ra ngoài


async def test_daily_score_failure_is_caught_and_logged(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def boom(*args: Any, **kwargs: Any) -> Any:
        raise RuntimeError("bad data")

    @asynccontextmanager
    async def fake_session_scope() -> AsyncIterator[None]:
        yield None

    monkeypatch.setattr(scheduler_module, "session_scope", fake_session_scope)
    monkeypatch.setattr(scheduler_module, "score_candidates", boom)

    await scheduler_module.run_daily_score()  # không được raise ra ngoài
