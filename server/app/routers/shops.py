from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from .. import models, schemas
from ..database import get_db
from ..deps import get_current_user
from ..scrape_worker import pool as scrape_pool

router = APIRouter(prefix="/api/shops", tags=["shops"])


def _get_owned_shop(db: Session, shop_id: int, user: models.User) -> models.Shop:
    shop = db.query(models.Shop).filter(models.Shop.id == shop_id).first()
    if shop is None:
        raise HTTPException(status_code=404, detail="Shop not found")
    if shop.owner_id != user.id and user.role != models.UserRole.admin:
        raise HTTPException(status_code=403, detail="Not your shop")
    return shop


@router.post("", response_model=schemas.ShopOut)
def add_shop(
    request: schemas.ShopCreate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    existing = (
        db.query(models.Shop)
        .filter(models.Shop.owner_id == user.id, models.Shop.shop_url == request.shop_url)
        .first()
    )
    if existing:
        raise HTTPException(status_code=409, detail="Bạn đã thêm shop này rồi")

    shop = models.Shop(
        owner_id=user.id,
        shop_url=request.shop_url,
        niche=request.niche,
        status=models.ShopStatus.pending,
    )
    db.add(shop)
    db.commit()
    db.refresh(shop)

    scrape_pool.enqueue(shop.id)
    return shop


@router.post("/{shop_id}/retry", response_model=schemas.ShopOut)
def retry_shop(
    shop_id: int,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    shop = _get_owned_shop(db, shop_id, user)
    shop.status = models.ShopStatus.pending
    shop.error_message = None
    db.commit()
    db.refresh(shop)
    scrape_pool.enqueue(shop.id)
    return shop


@router.get("", response_model=list[schemas.ShopOut])
def list_my_shops(
    db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    return (
        db.query(models.Shop)
        .filter(models.Shop.owner_id == user.id)
        .order_by(models.Shop.requested_at.desc())
        .all()
    )


@router.get("/report", response_model=list[schemas.ShopReportOut])
def shops_report(
    db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Registered before /{shop_id} on purpose -- FastAPI matches routes in
    registration order, and /{shop_id} would otherwise greedily swallow
    "/report" as shop_id="report" (a 422, not a 404).

    Only returns shops with something to report: new listings, removed
    listings, or currently unavailable (vacation/closed/gone) -- not every
    shop, since this is a change feed, not another full listing.
    """
    shops = db.query(models.Shop).filter(models.Shop.owner_id == user.id).all()
    return [
        schemas.ShopReportOut(
            id=s.id,
            shop_name=s.shop_name,
            shop_url=s.shop_url,
            is_available=s.is_available,
            unavailable_reason=s.unavailable_reason,
            scraped_at=s.scraped_at,
            added_listings=s.last_added_listings or [],
            removed_listings=s.last_removed_listings or [],
        )
        for s in shops
        if s.last_added_listings or s.last_removed_listings or not s.is_available
    ]


@router.get("/overview", response_model=schemas.ShopsOverviewOut)
def shops_overview(
    db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    """Registered before /{shop_id} for the same reason /report is (see
    above). "Today" is a UTC calendar day, matching the naive UTC
    timestamps `datetime.utcnow()` writes everywhere else in this app
    (scraped_at, changed_at, ...) -- using the server process's local
    timezone here instead would silently disagree with those.
    """
    total_shops = db.query(models.Shop).filter(models.Shop.owner_id == user.id).count()

    niche_rows = (
        db.query(models.Shop.niche, func.count(models.Shop.id))
        .filter(models.Shop.owner_id == user.id)
        .group_by(models.Shop.niche)
        .order_by(func.count(models.Shop.id).desc())
        .all()
    )

    total_listings = (
        db.query(func.count(models.Listing.id))
        .join(models.Shop, models.Listing.shop_id == models.Shop.id)
        .filter(models.Shop.owner_id == user.id)
        .scalar()
    )

    today_start = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)

    def _count_changes(change_type: str) -> int:
        return (
            db.query(func.count(models.ListingChangeLog.id))
            .join(models.Shop, models.ListingChangeLog.shop_id == models.Shop.id)
            .filter(
                models.Shop.owner_id == user.id,
                models.ListingChangeLog.change_type == change_type,
                models.ListingChangeLog.changed_at >= today_start,
            )
            .scalar()
        )

    return schemas.ShopsOverviewOut(
        total_shops=total_shops,
        shops_by_niche=[schemas.NicheCount(niche=niche, count=count) for niche, count in niche_rows],
        total_listings=total_listings or 0,
        new_listings_today=_count_changes("added"),
        removed_listings_today=_count_changes("removed"),
    )


@router.get("/{shop_id}", response_model=schemas.ShopDetailOut)
def get_shop(
    shop_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    return _get_owned_shop(db, shop_id, user)


@router.patch("/{shop_id}", response_model=schemas.ShopOut)
def update_shop_niche(
    shop_id: int,
    request: schemas.ShopNicheUpdate,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    shop = _get_owned_shop(db, shop_id, user)
    shop.niche = request.niche
    db.commit()
    db.refresh(shop)
    return shop


@router.delete("/{shop_id}", status_code=204)
def delete_shop(
    shop_id: int, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)
):
    shop = _get_owned_shop(db, shop_id, user)
    db.delete(shop)
    db.commit()
