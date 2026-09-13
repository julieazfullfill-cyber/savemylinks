"""CLI: scanner seed / collect / metrics / sources."""

import asyncio
import json
import sys
from datetime import date as date_t
from pathlib import Path
from typing import Annotated

import typer

from scanner.adapters import REGISTRY
from scanner.core.config import get_settings
from scanner.core.db import dispose_engine, session_scope
from scanner.core.log import configure_logging, get_logger
from scanner.core.seeds import CORE_NICHES, parse_seed_file, sync_seeds
from scanner.pipeline.collect import collect_source
from scanner.pipeline.metrics import recompute_history, run_metrics

# Console Windows mặc định là cp1252, help và log tiếng Việt sẽ vỡ nếu không ép UTF-8.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

app = typer.Typer(no_args_is_help=True, add_completion=False, help="POD Trend Scanner")
log = get_logger(__name__)

DEFAULT_SEED_FILE = Path("data/seed_keywords.json")


def _setup() -> None:
    configure_logging(get_settings().log_level)


@app.command()
def seed(
    file: Annotated[Path, typer.Option("--file", help="đường dẫn seed_keywords.json")] = DEFAULT_SEED_FILE,
) -> None:
    """Nạp seed từ JSON vào bảng `seeds` (idempotent)."""
    _setup()
    rows = parse_seed_file(file)
    core = sum(1 for r in rows if r.is_core)

    async def run() -> dict[str, int]:
        try:
            async with session_scope() as session:
                return await sync_seeds(session, rows)
        finally:
            await dispose_engine()

    stats = asyncio.run(run())
    typer.echo(
        json.dumps(
            {"parsed": len(rows), "core": core, "expansion": len(rows) - core, **stats},
            ensure_ascii=False,
        )
    )


@app.command()
def collect(
    source: Annotated[str, typer.Option("--source", help=f"một trong: {sorted(REGISTRY)}")],
    niche: Annotated[
        list[str] | None,
        typer.Option("--niche", help="lặp lại được. Mặc định: ba niche core"),
    ] = None,
    risk_tier: Annotated[
        list[str] | None, typer.Option("--risk-tier", help="lọc theo tier, ví dụ T0")
    ] = None,
    limit: Annotated[int | None, typer.Option("--limit", help="giới hạn số seed")] = None,
    include_expansion: Annotated[
        bool, typer.Option("--include-expansion", help="chạy cả nhóm mở rộng")
    ] = False,
) -> None:
    """Chạy một nguồn qua danh sách seed, ghi raw_items + term_observations."""
    _setup()
    # None = mặc định ba niche core, [] = không lọc niche nào.
    niches: list[str] | None = list(niche) if niche else ([] if include_expansion else None)

    async def run() -> dict[str, int | str | bool]:
        try:
            stats = await collect_source(
                source,
                niches=niches,
                risk_tiers=list(risk_tier) if risk_tier else None,
                limit=limit,
            )
            return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def metrics(
    for_date: Annotated[
        str | None, typer.Option("--date", help="YYYY-MM-DD, mặc định hôm nay (UTC)")
    ] = None,
    recompute: Annotated[
        bool,
        typer.Option("--recompute", help="tính lại toàn bộ lịch sử từ term_observations"),
    ] = False,
) -> None:
    """Tính value_norm/velocity/accel, ghi term_metrics_daily."""
    _setup()
    target = date_t.fromisoformat(for_date) if for_date else None

    async def run() -> dict[str, int | str] | list[dict[str, int | str]]:
        try:
            async with session_scope() as session:
                if recompute:
                    results = await recompute_history(session)
                    return [r.as_dict() for r in results]
                stats = await run_metrics(session, target)
                return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def schedule() -> None:
    """Chạy job nền: collect 02:00 UTC + metrics 03:00 UTC. Ctrl+C để dừng."""
    _setup()
    from scanner.scheduler import run_forever  # import trễ, module này kéo theo apscheduler

    asyncio.run(run_forever())


@app.command("sources")
def list_sources() -> None:
    """Liệt kê adapter đã đăng ký và rate limit mặc định của chúng."""
    _setup()
    rows = [cls(config=None).source_row() for cls in REGISTRY.values()]
    typer.echo(json.dumps(rows, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    app()
