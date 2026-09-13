"""Bước metrics: tính value_norm, velocity_7d/21d, accel, n_sources -> term_metrics_daily.

Chỉ đọc term_observations (bất biến) và ghi lại term_metrics_daily. Công thức nằm
trọn trong module này nên đổi công thức chỉ cần sửa ở đây rồi `recompute_history`,
không đụng tới dữ liệu nguồn.

value_norm:
  - Nguồn kind != 'trends' (autocomplete): 100 * (1 - (rank-1)/max_rank), max_rank là
    số gợi ý trong đúng raw_item đó.
  - Nguồn kind == 'trends' (Pinterest Trends): percentile của `value` trong cùng
    source + ngày, vì đây là volume thật chứ không phải vị trí trong danh sách.
  - Nhiều observation cùng term trong ngày -> lấy MAX (tín hiệu mạnh nhất từng thấy).

velocity_7d/21d: hệ số góc hồi quy tuyến tính trên chuỗi value_norm gần nhất.
accel = velocity_7d - velocity_21d.
"""

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import UTC, date, datetime

from sqlalchemy import Date, Numeric, cast, func, select
from sqlalchemy import update as sa_update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.log import get_logger
from scanner.core.models import Source, TermMetricsDaily, TermObservation

log = get_logger(__name__)

VELOCITY_WINDOW_SHORT = 7
VELOCITY_WINDOW_LONG = 21
TRENDS_KIND = "trends"


def utcnow_date() -> date:
    return datetime.now(UTC).date()


def linear_slope(values: Sequence[float]) -> float | None:
    """Hệ số góc hồi quy tuyến tính đơn giản, x = 0..n-1. None nếu < 2 điểm."""
    n = len(values)
    if n < 2:
        return None
    mean_x = (n - 1) / 2
    mean_y = sum(values) / n
    numerator = sum((i - mean_x) * (v - mean_y) for i, v in enumerate(values))
    denominator = sum((i - mean_x) ** 2 for i in range(n))
    if denominator == 0:
        return None
    return numerator / denominator


def compute_velocity(
    history: Sequence[float],
) -> tuple[float | None, float | None, float | None]:
    """`history` là value_norm sắp cũ -> mới, điểm cuối là ngày đang tính.

    Dùng tối đa 7 / 21 điểm gần nhất cho velocity_7d / velocity_21d.
    """
    v7 = linear_slope(history[-VELOCITY_WINDOW_SHORT:])
    v21 = linear_slope(history[-VELOCITY_WINDOW_LONG:])
    accel = (v7 - v21) if v7 is not None and v21 is not None else None
    return v7, v21, accel


@dataclass
class MetricsStats:
    date: date
    terms_scored: int = 0

    def as_dict(self) -> dict[str, int | str]:
        return {"date": self.date.isoformat(), "terms_scored": self.terms_scored}


async def _upsert_value_norm(session: AsyncSession, target_date: date) -> list[int]:
    """Tính value_norm + n_sources cho mọi term có observation trong target_date.

    Trả về danh sách term_id đã cập nhật, để bước velocity chỉ cần xử lý đúng
    các term đó thay vì quét toàn bảng.
    """
    obs_date = cast(TermObservation.observed_at, Date)

    base = (
        select(
            TermObservation.term_id,
            TermObservation.source_id,
            TermObservation.raw_item_id,
            TermObservation.rank,
            TermObservation.value,
            Source.kind,
        )
        .select_from(TermObservation)
        .join(Source, Source.id == TermObservation.source_id)
        .where(obs_date == target_date)
        .subquery("base")
    )

    max_rank_by_raw_item = (
        select(base.c.raw_item_id, func.max(base.c.rank).label("max_rank"))
        .where(base.c.kind != TRENDS_KIND, base.c.rank.is_not(None))
        .group_by(base.c.raw_item_id)
        .subquery("max_rank")
    )

    rank_based = (
        select(
            base.c.term_id,
            base.c.source_id,
            (
                100.0
                * (
                    1.0
                    - cast(base.c.rank - 1, Numeric)
                    / func.nullif(max_rank_by_raw_item.c.max_rank, 0)
                )
            ).label("value_norm"),
        )
        .select_from(base)
        .join(max_rank_by_raw_item, max_rank_by_raw_item.c.raw_item_id == base.c.raw_item_id)
        .where(base.c.kind != TRENDS_KIND, base.c.rank.is_not(None))
    )

    # Pinterest Trends: value là volume thật, không phải vị trí -> percentile trong
    # cùng source + ngày, không dùng công thức theo rank.
    trend_based = (
        select(
            base.c.term_id,
            base.c.source_id,
            (
                100.0
                * func.percent_rank().over(partition_by=base.c.source_id, order_by=base.c.value)
            ).label("value_norm"),
        )
        .select_from(base)
        .where(base.c.kind == TRENDS_KIND, base.c.value.is_not(None))
    )

    combined = rank_based.union_all(trend_based).subquery("combined")

    agg = select(
        combined.c.term_id,
        func.max(combined.c.value_norm).label("value_norm"),
        func.count(func.distinct(combined.c.source_id)).label("n_sources"),
    ).group_by(combined.c.term_id)

    rows = (await session.execute(agg)).all()
    if not rows:
        return []

    stmt = pg_insert(TermMetricsDaily).values(
        [
            {
                "term_id": row.term_id,
                "date": target_date,
                "value_norm": row.value_norm,
                "n_sources": row.n_sources,
            }
            for row in rows
        ]
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[TermMetricsDaily.term_id, TermMetricsDaily.date],
        set_={"value_norm": stmt.excluded.value_norm, "n_sources": stmt.excluded.n_sources},
    )
    await session.execute(stmt)
    return [int(row.term_id) for row in rows]


async def _history_value_norm(
    session: AsyncSession, term_id: int, through_date: date, limit: int
) -> list[float]:
    rows = (
        (
            await session.execute(
                select(TermMetricsDaily.value_norm)
                .where(TermMetricsDaily.term_id == term_id, TermMetricsDaily.date <= through_date)
                .order_by(TermMetricsDaily.date.desc())
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
    return [float(v) for v in reversed(rows)]  # cũ -> mới, khớp thứ tự compute_velocity


async def _upsert_velocity(session: AsyncSession, term_id: int, target_date: date) -> None:
    history = await _history_value_norm(session, term_id, target_date, VELOCITY_WINDOW_LONG)
    v7, v21, accel = compute_velocity(history)
    await session.execute(
        sa_update(TermMetricsDaily)
        .where(TermMetricsDaily.term_id == term_id, TermMetricsDaily.date == target_date)
        .values(velocity_7d=v7, velocity_21d=v21, accel=accel)
    )


async def run_metrics(session: AsyncSession, target_date: date | None = None) -> MetricsStats:
    """Tính metrics cho một ngày. Idempotent — chạy lại ghi đè cùng kết quả."""
    resolved_date = target_date or utcnow_date()
    term_ids = await _upsert_value_norm(session, resolved_date)
    for term_id in term_ids:
        await _upsert_velocity(session, term_id, resolved_date)
    stats = MetricsStats(date=resolved_date, terms_scored=len(term_ids))
    log.info("metrics.done", **stats.as_dict())
    return stats


async def list_observation_dates(session: AsyncSession) -> list[date]:
    """Mọi ngày (UTC) có observation, tăng dần."""
    obs_date = cast(TermObservation.observed_at, Date).label("d")
    rows = (await session.execute(select(obs_date).distinct().order_by("d"))).scalars().all()
    return list(rows)


async def recompute_history(session: AsyncSession) -> list[MetricsStats]:
    """Tính lại toàn bộ term_metrics_daily từ term_observations, theo thứ tự ngày.

    Dùng khi đổi công thức scoring: raw_items/term_observations bất biến nên replay
    lại toàn bộ lịch sử được, không mất dữ liệu.
    """
    dates = await list_observation_dates(session)
    return [await run_metrics(session, d) for d in dates]
