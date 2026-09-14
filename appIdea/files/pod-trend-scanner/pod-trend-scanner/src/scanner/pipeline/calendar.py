"""Calendar engine: biết hôm nay nên sản xuất seed nào, cho occasion nào.

Định nghĩa cửa sổ "nên sản xuất ngay" cho một occasion:

    peak_start   = ngày 1 của tháng nhỏ nhất trong `peak_months` (năm gần nhất phía
                   trước sao cho cửa sổ chứa `today`, xử lý cả trường hợp vắt qua
                   ranh giới năm — ví dụ peak tháng 5 nhưng đang hỏi vào tháng 12
                   năm trước)
    window_start = peak_start - 2 * lead_weeks
    window_end   = peak_start - lead_weeks

`lead_weeks` là "phải xong trước peak bao nhiêu tuần" (hạn chót). Cửa sổ mở sớm gấp
đôi lead_weeks để có khoảng thời gian hợp lý để hành động, không phải một mốc duy nhất.
Seed nào rơi vào cửa sổ này ở MỘT peak sắp tới thì được coi là "nên sản xuất ngay".

Đây là suy luận nhất quán duy nhất khớp với ví dụ acceptance trong TASKS.md (hỏi
tháng 12 phải ra occasion peak tháng 5-8, lead 8-12 tuần) — dùng "trước peak N tuần"
theo nghĩa đen (một điểm duy nhất) thì tháng 12 không bao giờ khớp peak tháng 5-8.
"""

from dataclasses import dataclass
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.models import Occasion, Seed


@dataclass(frozen=True)
class ProductionItem:
    occasion: str
    seed: str
    niche: str
    sub_niche: str | None
    risk_tier: str
    peak_months: tuple[int, ...]
    lead_weeks: int
    window_start: date
    window_end: date


def _peak_start(peak_months: list[int], year: int) -> date:
    return date(year, min(peak_months), 1)


def _production_window(occasion: Occasion, today: date) -> tuple[date, date] | None:
    """Cửa sổ sản xuất chứa `today`, nếu có. Kiểm tra peak năm nay và năm sau để xử lý
    trường hợp cửa sổ vắt qua ranh giới năm (peak đầu năm sau, đang hỏi cuối năm nay)."""
    for year in (today.year, today.year + 1):
        peak_start = _peak_start(occasion.peak_months, year)
        window_end = peak_start - timedelta(weeks=occasion.lead_weeks)
        window_start = peak_start - timedelta(weeks=2 * occasion.lead_weeks)
        if window_start <= today <= window_end:
            return window_start, window_end
    return None


async def production_calendar(
    session: AsyncSession, niche: str | None = None, today: date | None = None
) -> list[ProductionItem]:
    """Seed nào nên sản xuất hôm nay, occasion nào — join occasions với seeds theo niche."""
    resolved_today = today or date.today()

    occasion_stmt = select(Occasion)
    if niche:
        occasion_stmt = occasion_stmt.where(Occasion.niches.contains([niche]))
    occasions = list((await session.scalars(occasion_stmt)).all())

    due: list[tuple[Occasion, date, date]] = []
    for occ in occasions:
        window = _production_window(occ, resolved_today)
        if window is not None:
            due.append((occ, window[0], window[1]))
    if not due:
        return []

    all_niches = sorted({n for occ, _, _ in due for n in occ.niches})
    seed_stmt = select(Seed).where(Seed.enabled.is_(True), Seed.niche.in_(all_niches))
    if niche:
        seed_stmt = seed_stmt.where(Seed.niche == niche)
    seeds = list((await session.scalars(seed_stmt)).all())

    items: list[ProductionItem] = []
    for occ, window_start, window_end in due:
        occasion_niches = set(occ.niches)
        for seed in seeds:
            if seed.niche not in occasion_niches:
                continue
            items.append(
                ProductionItem(
                    occasion=occ.name,
                    seed=seed.seed,
                    niche=seed.niche,
                    sub_niche=seed.sub_niche,
                    risk_tier=seed.risk_tier,
                    peak_months=tuple(occ.peak_months),
                    lead_weeks=occ.lead_weeks,
                    window_start=window_start,
                    window_end=window_end,
                )
            )
    return items
