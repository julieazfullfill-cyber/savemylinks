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
from scanner.core.occasions import parse_occasion_file, sync_occasions
from scanner.core.seeds import CORE_NICHES, parse_seed_file, sync_seeds
from scanner.pipeline.calendar import production_calendar
from scanner.pipeline.collect import collect_source
from scanner.pipeline.enrich import DEFAULT_TOP_N, enrich_top_terms
from scanner.pipeline.brief import (
    DEFAULT_PRODUCT_PRESET,
    PRODUCT_PRESETS,
    BriefBlockedError,
    BriefExportBlockedError,
    BriefLLMFailedError,
    export_brief,
    generate_brief,
)
from scanner.pipeline.import_etsy import import_etsy_csv
from scanner.pipeline.risk import (
    ApprovalRequiredError,
    approve_candidate,
    determine_risk_tier,
    reject_candidate,
    run_risk_gate_for_pending_candidates,
)
from scanner.pipeline.metrics import recompute_history, run_metrics
from scanner.pipeline.score import DEFAULT_TOP_N as SCORE_DEFAULT_TOP_N
from scanner.pipeline.score import score_candidates
from scanner.pipeline.uspto_index import discover_bulk_paths, index_status, load_path

# Console Windows mặc định là cp1252, help và log tiếng Việt sẽ vỡ nếu không ép UTF-8.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]

app = typer.Typer(no_args_is_help=True, add_completion=False, help="POD Trend Scanner")
log = get_logger(__name__)

DEFAULT_SEED_FILE = Path("data/seed_keywords.json")
DEFAULT_OCCASIONS_FILE = Path("data/occasions.json")


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


@app.command("seed-occasions")
def seed_occasions(
    file: Annotated[
        Path, typer.Option("--file", help="đường dẫn occasions.json")
    ] = DEFAULT_OCCASIONS_FILE,
) -> None:
    """Nạp dịp lễ/mùa vụ từ JSON vào bảng `occasions` (idempotent)."""
    _setup()
    rows = parse_occasion_file(file)

    async def run() -> dict[str, int]:
        try:
            async with session_scope() as session:
                return await sync_occasions(session, rows)
        finally:
            await dispose_engine()

    stats = asyncio.run(run())
    typer.echo(json.dumps({"parsed": len(rows), **stats}, ensure_ascii=False))


@app.command()
def calendar(
    niche: Annotated[str | None, typer.Option("--niche", help="lọc theo niche")] = None,
    for_date: Annotated[
        str | None, typer.Option("--date", help="YYYY-MM-DD, mặc định hôm nay")
    ] = None,
) -> None:
    """Hôm nay (hoặc --date) nên sản xuất seed nào, cho dịp nào."""
    _setup()
    target = date_t.fromisoformat(for_date) if for_date else None

    async def run() -> list[dict[str, object]]:
        try:
            async with session_scope() as session:
                items = await production_calendar(session, niche=niche, today=target)
                return [
                    {
                        "occasion": it.occasion,
                        "seed": it.seed,
                        "niche": it.niche,
                        "sub_niche": it.sub_niche,
                        "risk_tier": it.risk_tier,
                        "peak_months": list(it.peak_months),
                        "lead_weeks": it.lead_weeks,
                        "window_start": it.window_start.isoformat(),
                        "window_end": it.window_end.isoformat(),
                    }
                    for it in items
                ]
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))


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
def enrich(
    top_n: Annotated[
        int, typer.Option("--top-n", help="số term tối đa mỗi lượt")
    ] = DEFAULT_TOP_N,
    cache_days: Annotated[
        int, typer.Option("--cache-days", help="bỏ qua term đã check trong N ngày")
    ] = 7,
) -> None:
    """Đếm listing cạnh tranh cho top term theo accel, ghi term_enrichment."""
    _setup()

    async def run() -> dict[str, int]:
        try:
            async with session_scope() as session:
                stats = await enrich_top_terms(session, top_n=top_n, cache_days=cache_days)
                return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def score(
    top_n: Annotated[
        int, typer.Option("--top-n", help="số term tối đa mỗi lượt")
    ] = SCORE_DEFAULT_TOP_N,
) -> None:
    """Tính momentum/opportunity cho term đạt điều kiện vào hàng đợi, ghi candidates."""
    _setup()

    async def run() -> dict[str, int]:
        try:
            async with session_scope() as session:
                stats = await score_candidates(session, top_n=top_n)
                return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command("import-etsy")
def import_etsy(
    file: Annotated[Path, typer.Option("--file", help="CSV export từ eRank/Everbee/Alura")],
    term_column: Annotated[
        str | None, typer.Option("--term-column", help="ép tên cột keyword nếu tự nhận diện sai")
    ] = None,
    value_column: Annotated[
        str | None, typer.Option("--value-column", help="ép tên cột search volume")
    ] = None,
) -> None:
    """Nạp CSV export Etsy (KHÔNG scrape) vào raw_items + term_observations."""
    _setup()

    async def run() -> dict[str, int | str | bool]:
        try:
            async with session_scope() as session:
                stats = await import_etsy_csv(
                    session, file, term_column=term_column, value_column=value_column
                )
                return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def risk(
    limit: Annotated[int, typer.Option("--limit", help="số candidate tối đa mỗi lượt")] = 100,
) -> None:
    """Chạy risk gate (4 lớp) cho candidate pending chưa có risk_level, ghi risk_flags."""
    _setup()

    async def run() -> dict[str, int]:
        try:
            async with session_scope() as session:
                stats = await run_risk_gate_for_pending_candidates(session, limit=limit)
                return stats.as_dict()
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def approve(
    candidate_id: Annotated[int, typer.Option("--candidate-id", help="id trong bảng candidates")],
    by: Annotated[str, typer.Option("--by", help="tên/email người duyệt")],
) -> None:
    """Duyệt một candidate. T2/T3 bắt buộc --by, không có đường tắt."""
    _setup()

    async def run() -> dict[str, str]:
        from scanner.core.models import Candidate

        try:
            async with session_scope() as session:
                candidate = await session.get(Candidate, candidate_id)
                if candidate is None:
                    return {"error": f"không có candidate id={candidate_id}"}
                tier = await determine_risk_tier(session, candidate.term_id)
                try:
                    await approve_candidate(session, candidate, tier, approved_by=by)
                except ApprovalRequiredError as exc:
                    return {"error": str(exc)}
                return {
                    "candidate_id": str(candidate_id),
                    "risk_tier": tier,
                    "status": candidate.status,
                    "approved_by": candidate.approved_by or "",
                }
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def reject(
    candidate_id: Annotated[int, typer.Option("--candidate-id", help="id trong bảng candidates")],
    by: Annotated[str | None, typer.Option("--by", help="tên/email người từ chối")] = None,
) -> None:
    """Từ chối một candidate — không xuất hiện lại trong hàng đợi duyệt mặc định."""
    _setup()

    async def run() -> dict[str, str]:
        from scanner.core.models import Candidate

        try:
            async with session_scope() as session:
                candidate = await session.get(Candidate, candidate_id)
                if candidate is None:
                    return {"error": f"không có candidate id={candidate_id}"}
                await reject_candidate(session, candidate, rejected_by=by)
                return {"candidate_id": str(candidate_id), "status": candidate.status}
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False))


@app.command()
def brief(
    candidate_id: Annotated[int, typer.Option("--candidate-id", help="id trong bảng candidates")],
    product: Annotated[
        str, typer.Option("--product", help=f"một trong: {sorted(PRODUCT_PRESETS)}")
    ] = DEFAULT_PRODUCT_PRESET,
) -> None:
    """Sinh design_brief qua LLM cho một candidate + render image prompt (Phase 4)."""
    _setup()

    async def run() -> dict[str, object]:
        from scanner.core.models import Candidate

        try:
            async with session_scope() as session:
                candidate = await session.get(Candidate, candidate_id)
                if candidate is None:
                    return {"error": f"không có candidate id={candidate_id}"}
                try:
                    row = await generate_brief(session, candidate, product_preset=product)
                except (BriefBlockedError, BriefLLMFailedError) as exc:
                    return {"error": str(exc)}
                await session.commit()
                return {
                    "brief_id": row.id,
                    "candidate_id": candidate_id,
                    "image_prompt": row.image_prompt,
                    "payload": row.payload,
                }
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))


@app.command("brief-export")
def brief_export(
    candidate_id: Annotated[int, typer.Option("--candidate-id", help="id trong bảng candidates")],
) -> None:
    """Xuất design_brief đã sinh — chỉ thành công nếu candidate đã approved (T2/T3
    bắt buộc approved_by, RISK_POLICY.md)."""
    _setup()

    async def run() -> dict[str, object]:
        from scanner.core.models import Candidate

        try:
            async with session_scope() as session:
                candidate = await session.get(Candidate, candidate_id)
                if candidate is None:
                    return {"error": f"không có candidate id={candidate_id}"}
                tier = await determine_risk_tier(session, candidate.term_id)
                try:
                    payload = await export_brief(session, candidate, tier)
                except BriefExportBlockedError as exc:
                    return {"error": str(exc)}
                await session.commit()
                return payload
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))


@app.command("uspto-index")
def uspto_index(
    path: Annotated[
        list[Path],
        typer.Option(
            "--path", help="file .xml/.zip hoặc thư mục chứa nhiều file, lặp lại được"
        ),
    ],
    force: Annotated[
        bool, typer.Option("--force", help="nạp lại cả file đã có trong manifest")
    ] = False,
) -> None:
    """Nạp file/thư mục bulk XML hoặc ZIP USPTO vào uspto_trademarks — thay live API
    (docs/RISK_POLICY.md Lớp 2). Trỏ --path thẳng vào thư mục chứa nhiều file (bộ dữ
    liệu đầy đủ có 91 file) để nạp hết trong một lệnh; không cần tự giải nén .zip;
    file đã nạp trước đó tự động bỏ qua (dùng --force để nạp lại). Chạy lại an toàn
    khi có thêm file mới trong cùng thư mục. Tải file từ
    https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data
    """
    _setup()

    async def run() -> list[dict[str, int | str]]:
        try:
            async with session_scope() as session:
                results: list[dict[str, int | str]] = []
                for p in discover_bulk_paths(path):
                    for stats in await load_path(session, p, force=force):
                        results.append(stats.as_dict())
                return results
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))


@app.command("uspto-index-status")
def uspto_index_status_cmd() -> None:
    """Tóm tắt local USPTO index: số file đã nạp, tổng record, breakdown LIVE/DEAD/
    UNKNOWN — dùng để biết đã nạp đủ chưa trước khi set USPTO_INDEX_COVERAGE_COMPLETE."""
    _setup()

    async def run() -> dict[str, object]:
        try:
            async with session_scope() as session:
                return await index_status(session)
        finally:
            await dispose_engine()

    typer.echo(json.dumps(asyncio.run(run()), ensure_ascii=False, indent=2))


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
