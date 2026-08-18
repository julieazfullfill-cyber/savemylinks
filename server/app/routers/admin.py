import re

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import require_admin
from ..scrape_worker import pool as scrape_pool
from ..scrape_worker import save_scraped_data
from ..scraper import parse_shop_html

router = APIRouter(prefix="/api/admin", tags=["admin"])

_TIME_RE = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _get_or_create_settings(db: Session) -> models.ScraperSettings:
    settings_row = db.query(models.ScraperSettings).filter(models.ScraperSettings.id == 1).first()
    if settings_row is None:
        settings_row = models.ScraperSettings(id=1, max_concurrent=1, proxies=[None])
        db.add(settings_row)
        db.commit()
        db.refresh(settings_row)
    return settings_row


def _get_or_create_schedule(db: Session) -> models.ScheduleSettings:
    row = db.query(models.ScheduleSettings).filter(models.ScheduleSettings.id == 1).first()
    if row is None:
        row = models.ScheduleSettings(
            id=1,
            mode=models.ScheduleMode.off,
            fixed_time=None,
            review_mode=models.ScheduleMode.off,
            review_fixed_time=None,
        )
        db.add(row)
        db.commit()
        db.refresh(row)
    return row


def _get_any_shop(db: Session, shop_id: int) -> models.Shop:
    shop = db.query(models.Shop).filter(models.Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=404, detail="Shop not found")
    return shop


@router.get("/queue", response_model=list[schemas.AdminQueueItemOut])
def queue(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    rows = (
        db.query(models.Shop, models.User.email)
        .join(models.User, models.Shop.owner_id == models.User.id)
        .filter(
            models.Shop.status.in_(
                [models.ShopStatus.pending, models.ShopStatus.scraping, models.ShopStatus.failed]
            )
        )
        .order_by(models.Shop.requested_at.asc())
        .all()
    )
    return [
        schemas.AdminQueueItemOut(**schemas.ShopOut.model_validate(shop).model_dump(), owner_email=email)
        for shop, email in rows
    ]


@router.get("/shops", response_model=list[schemas.AdminQueueItemOut])
def all_shops(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    rows = (
        db.query(models.Shop, models.User.email)
        .join(models.User, models.Shop.owner_id == models.User.id)
        .order_by(models.Shop.requested_at.desc())
        .all()
    )
    return [
        schemas.AdminQueueItemOut(**schemas.ShopOut.model_validate(shop).model_dump(), owner_email=email)
        for shop, email in rows
    ]


@router.get("/report", response_model=list[schemas.AdminShopReportOut])
def all_shops_report(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    """Same change feed as /api/shops/report (new/removed listings since the
    last scrape, or currently unavailable) but across every user's shops
    instead of just the caller's, for the admin "Change report" tab.
    """
    rows = (
        db.query(models.Shop, models.User.email)
        .join(models.User, models.Shop.owner_id == models.User.id)
        .all()
    )
    return [
        schemas.AdminShopReportOut(
            id=shop.id,
            shop_name=shop.shop_name,
            shop_url=shop.shop_url,
            is_available=shop.is_available,
            unavailable_reason=shop.unavailable_reason,
            scraped_at=shop.scraped_at,
            added_listings=shop.last_added_listings or [],
            removed_listings=shop.last_removed_listings or [],
            owner_email=email,
        )
        for shop, email in rows
        if shop.last_added_listings or shop.last_removed_listings or not shop.is_available
    ]


@router.get("/users", response_model=list[schemas.UserOverviewOut])
def users_overview(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    """Per-user summary for the admin "Tất cả shop" tab: how many shops each
    regular user is tracking and when they last logged in, so admin can see
    usage at a glance instead of only a flat shop list.
    """
    rows = (
        db.query(models.User, func.count(models.Shop.id))
        .outerjoin(models.Shop, models.Shop.owner_id == models.User.id)
        .filter(models.User.role == models.UserRole.user)
        .group_by(models.User.id)
        .order_by(models.User.email.asc())
        .all()
    )
    return [
        schemas.UserOverviewOut(
            id=user.id,
            email=user.email,
            created_at=user.created_at,
            last_login=user.last_login,
            shop_count=count,
        )
        for user, count in rows
    ]


@router.get("/shops/{shop_id}", response_model=schemas.ShopDetailOut)
def get_shop(
    shop_id: int, db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    return _get_any_shop(db, shop_id)


@router.post("/shops/{shop_id}/import", response_model=schemas.ShopDetailOut)
def import_html(
    shop_id: int,
    request: schemas.ImportRequest,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    shop = _get_any_shop(db, shop_id)
    scraped = parse_shop_html(shop.shop_url, request.html)
    if not scraped.listings:
        raise HTTPException(
            status_code=422,
            detail=(
                "Không tìm thấy listing nào trong HTML đã dán. Kiểm tra lại đã copy "
                "đúng toàn bộ trang shop (sau khi trang tải xong hết) chưa."
            ),
        )
    return save_scraped_data(db, shop, scraped)


@router.post("/shops/{shop_id}/scrape", response_model=schemas.ShopOut)
def auto_scrape(
    shop_id: int,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    """Re-queues the shop on the same worker pool user-triggered scrapes use
    (so it respects the configured concurrency/proxy settings instead of
    running an extra, unbounded Chrome window outside the pool). Returns
    immediately with status=pending; the client polls for the result same
    as the user dashboard does.
    """
    shop = _get_any_shop(db, shop_id)
    shop.status = models.ShopStatus.pending
    shop.error_message = None
    db.commit()
    db.refresh(shop)
    scrape_pool.enqueue(shop.id)
    return shop


@router.get("/settings", response_model=schemas.ScraperSettingsOut)
def get_settings(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    return _get_or_create_settings(db)


@router.put("/settings", response_model=schemas.ScraperSettingsOut)
def update_settings(
    request: schemas.ScraperSettingsUpdate,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    # Normalize proxies to exactly max_concurrent entries -- pad with "no
    # proxy" (None) if the client sent fewer, drop extras if it sent more.
    proxies = [(p.strip() or None) if p else None for p in request.proxies]
    proxies = (proxies + [None] * request.max_concurrent)[: request.max_concurrent]

    settings_row = _get_or_create_settings(db)
    settings_row.max_concurrent = request.max_concurrent
    settings_row.proxies = proxies
    db.commit()
    db.refresh(settings_row)

    scrape_pool.configure(settings_row.max_concurrent, settings_row.proxies)
    return settings_row


@router.get("/schedule", response_model=schemas.ScheduleSettingsOut)
def get_schedule(
    db: Session = Depends(get_db), _admin: models.User = Depends(require_admin)
):
    return _get_or_create_schedule(db)


@router.put("/schedule", response_model=schemas.ScheduleSettingsOut)
def update_schedule(
    request: schemas.ScheduleSettingsUpdate,
    db: Session = Depends(get_db),
    _admin: models.User = Depends(require_admin),
):
    if request.mode == models.ScheduleMode.fixed_time:
        if not request.fixed_time or not _TIME_RE.match(request.fixed_time):
            raise HTTPException(
                status_code=422, detail="fixed_time phải theo định dạng HH:MM (24h), ví dụ 03:00"
            )
    if request.review_mode == models.ScheduleMode.fixed_time:
        if not request.review_fixed_time or not _TIME_RE.match(request.review_fixed_time):
            raise HTTPException(
                status_code=422, detail="review_fixed_time phải theo định dạng HH:MM (24h), ví dụ 03:00"
            )

    row = _get_or_create_schedule(db)
    row.mode = request.mode
    row.fixed_time = request.fixed_time if request.mode == models.ScheduleMode.fixed_time else None
    row.review_mode = request.review_mode
    row.review_fixed_time = (
        request.review_fixed_time if request.review_mode == models.ScheduleMode.fixed_time else None
    )
    db.commit()
    db.refresh(row)
    return row
