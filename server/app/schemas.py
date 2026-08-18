from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from .models import ScheduleMode, ShopStatus, UserRole


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    role: UserRole


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    role: UserRole


class ImportRequest(BaseModel):
    html: str


class ShopCreate(BaseModel):
    shop_url: str
    niche: str | None = None


class ShopNicheUpdate(BaseModel):
    niche: str | None = None


class ListingOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    etsy_listing_id: str | None
    title: str | None
    url: str | None
    image_url: str | None
    price: str | None
    price_value: float | None
    currency: str | None
    rating: float | None
    num_reviews: int | None
    scraped_at: datetime


class ShopOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    shop_url: str
    niche: str | None
    status: ShopStatus
    shop_name: str | None
    location: str | None
    total_listings: int | None
    total_reviews: int | None
    total_sales: int | None
    rating: float | None
    requested_at: datetime
    scraped_at: datetime | None
    error_message: str | None
    is_available: bool
    unavailable_reason: str | None
    shop_tenure: str | None
    sales_delta: int | None
    reviews_delta: int | None
    sales_delta_week: int | None
    reviews_delta_week: int | None
    sales_delta_month: int | None
    reviews_delta_month: int | None


class ShopDetailOut(ShopOut):
    listings: list[ListingOut] = []


class AdminQueueItemOut(ShopOut):
    owner_email: str


class ListingSummary(BaseModel):
    etsy_listing_id: str | None
    title: str | None
    image_url: str | None
    url: str | None


class ShopReportOut(BaseModel):
    id: int
    shop_name: str | None
    shop_url: str
    is_available: bool
    unavailable_reason: str | None
    scraped_at: datetime | None
    added_listings: list[ListingSummary]
    removed_listings: list[ListingSummary]


class AdminShopReportOut(ShopReportOut):
    owner_email: str


class NicheCount(BaseModel):
    niche: str | None
    count: int


class ShopsOverviewOut(BaseModel):
    total_shops: int
    shops_by_niche: list[NicheCount]
    total_listings: int
    new_listings_today: int
    removed_listings_today: int


class UserOverviewOut(BaseModel):
    id: int
    email: str
    created_at: datetime
    last_login: datetime | None
    shop_count: int


class ScraperSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    max_concurrent: int
    proxies: list[str | None]


class ScraperSettingsUpdate(BaseModel):
    max_concurrent: int = Field(ge=1, le=100)
    proxies: list[str | None] = []


class ScheduleSettingsOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    mode: ScheduleMode
    fixed_time: str | None
    review_mode: ScheduleMode
    review_fixed_time: str | None


class ScheduleSettingsUpdate(BaseModel):
    mode: ScheduleMode
    fixed_time: str | None = None
    review_mode: ScheduleMode = ScheduleMode.off
    review_fixed_time: str | None = None
