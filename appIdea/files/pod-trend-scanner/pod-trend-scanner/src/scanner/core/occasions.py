"""Đọc data/occasions.json và đồng bộ vào bảng `occasions`.

`parse_occasion_file` thuần, không I/O DB — test được offline. Cùng pattern với
`core/seeds.py`.
"""

import json
from dataclasses import dataclass
from pathlib import Path

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.log import get_logger
from scanner.core.models import Occasion

log = get_logger(__name__)


@dataclass(frozen=True)
class OccasionRow:
    name: str
    peak_months: tuple[int, ...]
    lead_weeks: int
    niches: tuple[str, ...]


def parse_occasion_file(path: str | Path) -> list[OccasionRow]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows: list[OccasionRow] = []
    for item in data.get("occasions", []):
        if not isinstance(item, dict):
            continue
        name = str(item["name"]).strip()
        peak_months = tuple(int(m) for m in item["peak_months"])
        lead_weeks = int(item["lead_weeks"])
        niches = tuple(str(n) for n in item["niches"])
        if not peak_months:
            raise ValueError(f"occasion '{name}' thiếu peak_months")
        if any(m < 1 or m > 12 for m in peak_months):
            raise ValueError(f"occasion '{name}' có peak_months ngoài khoảng 1-12")
        if lead_weeks <= 0:
            raise ValueError(f"occasion '{name}' phải có lead_weeks > 0")
        if not niches:
            raise ValueError(f"occasion '{name}' thiếu niches")
        rows.append(
            OccasionRow(name=name, peak_months=peak_months, lead_weeks=lead_weeks, niches=niches)
        )

    names = [r.name for r in rows]
    if len(names) != len(set(names)):
        dupes = {n for n in names if names.count(n) > 1}
        raise ValueError(f"occasions trùng tên: {sorted(dupes)}")
    return rows


async def sync_occasions(session: AsyncSession, rows: list[OccasionRow]) -> dict[str, int]:
    """Upsert theo `name`. Không xoá occasion cũ không còn trong file — chỉ thêm/cập nhật."""
    if not rows:
        return {"inserted": 0, "updated": 0, "total": 0}

    count_stmt = select(func.count()).select_from(Occasion)
    before = int(await session.scalar(count_stmt) or 0)

    stmt = pg_insert(Occasion).values(
        [
            {
                "name": r.name,
                "peak_months": list(r.peak_months),
                "lead_weeks": r.lead_weeks,
                "niches": list(r.niches),
            }
            for r in rows
        ]
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[Occasion.name],
        set_={
            "peak_months": stmt.excluded.peak_months,
            "lead_weeks": stmt.excluded.lead_weeks,
            "niches": stmt.excluded.niches,
        },
    )
    await session.execute(stmt)
    await session.flush()
    after = int(await session.scalar(count_stmt) or 0)

    inserted = after - before
    stats = {"inserted": inserted, "updated": len(rows) - inserted, "total": after}
    log.info("occasions.synced", **stats)
    return stats
