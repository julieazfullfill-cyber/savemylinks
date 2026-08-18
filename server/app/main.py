from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models, scheduler
from .config import settings
from .database import Base, SessionLocal, engine
from .fx import get_usd_rates
from .routers import admin, auth, shops
from .scrape_worker import pool as scrape_pool
from .security import hash_password

app = FastAPI(title="Etsy Shop Scraper API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router)
app.include_router(shops.router)
app.include_router(admin.router)


def _seed_admin():
    db = SessionLocal()
    try:
        exists = db.query(models.User).filter(models.User.role == models.UserRole.admin).first()
        if exists:
            return
        admin_user = models.User(
            email=settings.admin_email,
            password_hash=hash_password(settings.admin_password),
            role=models.UserRole.admin,
        )
        db.add(admin_user)
        db.commit()
    finally:
        db.close()


def _start_scrape_pool():
    db = SessionLocal()
    try:
        settings_row = db.query(models.ScraperSettings).filter(models.ScraperSettings.id == 1).first()
        if settings_row is None:
            settings_row = models.ScraperSettings(id=1, max_concurrent=1, proxies=[None])
            db.add(settings_row)
            db.commit()
            db.refresh(settings_row)
        scrape_pool.configure(settings_row.max_concurrent, settings_row.proxies)
    finally:
        db.close()


@app.on_event("startup")
def on_startup():
    Base.metadata.create_all(bind=engine)
    _seed_admin()
    _start_scrape_pool()
    scheduler.start()


@app.get("/health")
def health():
    return {"status": "ok"}


@app.get("/api/fx-rates")
def fx_rates():
    return {"base": "USD", "rates": get_usd_rates()}
