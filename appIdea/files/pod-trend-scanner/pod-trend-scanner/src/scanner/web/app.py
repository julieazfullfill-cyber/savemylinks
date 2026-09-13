"""Dashboard tối thiểu: trang HTML thô liệt kê top term theo accel.

Chỉ đọc dữ liệu có sẵn trong term_metrics_daily — không gọi LLM, không ghi DB
(rule 11 trong CLAUDE.md). Dashboard duyệt/từ chối đầy đủ là việc của Phase 2+.
"""

from pathlib import Path
from typing import Any

from fastapi import FastAPI, Query, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.db import get_sessionmaker
from scanner.core.models import Term, TermMetricsDaily

TEMPLATES_DIR = Path(__file__).parent / "templates"
templates = Jinja2Templates(directory=str(TEMPLATES_DIR))

app = FastAPI(title="POD Trend Scanner")


async def latest_metrics_date(session: AsyncSession) -> Any:
    """Ngày gần nhất đã có metrics — trang mặc định hiển thị ngày này."""
    return await session.scalar(select(func.max(TermMetricsDaily.date)))


async def top_terms_by_accel(
    session: AsyncSession, target_date: Any, limit: int
) -> list[dict[str, Any]]:
    """Top term theo accel giảm dần cho một ngày. accel NULL (chưa đủ lịch sử) xếp cuối."""
    stmt = (
        select(
            Term.text_display,
            Term.niche,
            TermMetricsDaily.value_norm,
            TermMetricsDaily.velocity_7d,
            TermMetricsDaily.velocity_21d,
            TermMetricsDaily.accel,
            TermMetricsDaily.n_sources,
        )
        .join(Term, Term.id == TermMetricsDaily.term_id)
        .where(TermMetricsDaily.date == target_date)
        .order_by(TermMetricsDaily.accel.desc().nulls_last(), TermMetricsDaily.value_norm.desc())
        .limit(limit)
    )
    rows = (await session.execute(stmt)).all()
    return [dict(row._mapping) for row in rows]


@app.get("/", response_class=HTMLResponse)
async def top_terms_page(
    request: Request, limit: int = Query(100, ge=1, le=500)
) -> HTMLResponse:
    async with get_sessionmaker()() as session:
        target_date = await latest_metrics_date(session)
        rows = (
            await top_terms_by_accel(session, target_date, limit)
            if target_date is not None
            else []
        )
    return templates.TemplateResponse(
        request, "top_terms.html", {"rows": rows, "date": target_date, "limit": limit}
    )
