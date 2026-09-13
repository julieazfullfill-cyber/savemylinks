"""Đọc data/seed_keywords.json và đồng bộ vào bảng `seeds`.

`parse_seed_file` thuần, không I/O DB — test được offline.
"""

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from scanner.core.log import get_logger
from scanner.core.models import RISK_TIERS, Seed

log = get_logger(__name__)

CORE_NICHES: tuple[str, ...] = ("wedding", "birthday", "custom_photo")


@dataclass(frozen=True)
class SeedRow:
    seed: str
    niche: str
    risk_tier: str
    sub_niche: str | None = None
    personalized: bool = False
    intent: str | None = None
    peak_months: tuple[int, ...] = ()
    note: str | None = None

    @property
    def is_core(self) -> bool:
        return self.niche in CORE_NICHES


def _months(value: Any) -> tuple[int, ...]:
    if not isinstance(value, list):
        return ()
    return tuple(int(m) for m in value if isinstance(m, int | float | str) and str(m).isdigit())


def _core_row(niche: str, item: dict[str, Any]) -> SeedRow:
    risk = str(item.get("risk", "T0"))
    if risk not in RISK_TIERS:
        raise ValueError(f"risk_tier không hợp lệ cho seed '{item.get('seed')}': {risk}")
    return SeedRow(
        seed=str(item["seed"]).strip(),
        niche=niche,
        risk_tier=risk,
        sub_niche=(str(item["sub"]) if item.get("sub") else None),
        personalized=bool(item.get("personalized", False)),
        intent=(str(item["intent"]) if item.get("intent") else None),
        peak_months=_months(item.get("peak_months")),
        note=(str(item["note"]) if item.get("note") else None),
    )


def parse_seed_file(path: str | Path) -> list[SeedRow]:
    """Trả về seed core (có metadata đầy đủ) + seed nhóm mở rộng (chỉ có chuỗi + tier)."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    rows: list[SeedRow] = []

    for niche, items in (data.get("core_niches") or {}).items():
        if niche.startswith("_") or not isinstance(items, list):
            continue
        rows.extend(_core_row(niche, item) for item in items if isinstance(item, dict))

    for niche, group in (data.get("expansion_niches") or {}).items():
        if niche.startswith("_") or not isinstance(group, dict):
            continue
        risk = str(group.get("_risk", "T2"))
        if risk not in RISK_TIERS:
            raise ValueError(f"risk_tier không hợp lệ cho nhóm '{niche}': {risk}")
        note = group.get("_rule") or group.get("_pattern")
        for seed in group.get("seeds", []):
            if not isinstance(seed, str) or not seed.strip():
                continue
            rows.append(
                SeedRow(
                    seed=seed.strip(),
                    niche=niche,
                    risk_tier=risk,
                    note=(str(note) if note else None),
                )
            )

    seen: set[tuple[str, str]] = set()
    unique: list[SeedRow] = []
    for row in rows:
        key = (row.seed.lower(), row.niche)
        if key in seen:
            log.warning("seeds.duplicate_skipped", seed=row.seed, niche=row.niche)
            continue
        seen.add(key)
        unique.append(row)
    return unique


async def sync_seeds(session: AsyncSession, rows: list[SeedRow]) -> dict[str, int]:
    """Upsert theo (seed, niche). Seed đã có thì cập nhật metadata, không tạo bản trùng."""
    if not rows:
        return {"inserted": 0, "updated": 0, "total": 0}

    count_stmt = select(func.count()).select_from(Seed)
    before = int(await session.scalar(count_stmt) or 0)
    stmt = pg_insert(Seed).values(
        [
            {
                "seed": r.seed,
                "niche": r.niche,
                "sub_niche": r.sub_niche,
                "risk_tier": r.risk_tier,
                "personalized": r.personalized,
                "intent": r.intent,
                "peak_months": list(r.peak_months),
                "note": r.note,
                "enabled": True,
            }
            for r in rows
        ]
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[Seed.seed, Seed.niche],
        set_={
            "sub_niche": stmt.excluded.sub_niche,
            "risk_tier": stmt.excluded.risk_tier,
            "personalized": stmt.excluded.personalized,
            "intent": stmt.excluded.intent,
            "peak_months": stmt.excluded.peak_months,
            "note": stmt.excluded.note,
        },
    )
    await session.execute(stmt)
    await session.flush()
    after = int(await session.scalar(count_stmt) or 0)

    inserted = after - before
    stats = {"inserted": inserted, "updated": len(rows) - inserted, "total": after}
    log.info("seeds.synced", **stats)
    return stats
