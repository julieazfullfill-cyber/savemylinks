"""Cấu hình đọc từ env. Không hardcode secret ở bất kỳ đâu khác."""

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict

BROWSER_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore"
    )

    database_url: str = "postgresql+asyncpg://scanner:scanner@localhost:5432/scanner"
    anthropic_api_key: str | None = None
    # Local trademark index (pipeline/uspto_index.py) thay live API — xem
    # docs/RISK_POLICY.md Lớp 2. Set True chỉ khi đã tự xác nhận nạp ĐỦ toàn bộ bộ
    # bulk data ("Trademark Full Text XML Data") vào bảng uspto_trademarks; thiếu xác
    # nhận này, "không tìm thấy match" vẫn phải rơi vào "review" (fail-closed).
    uspto_index_coverage_complete: bool = False
    log_level: str = "INFO"
    collect_country: str = "US"
    http_timeout_seconds: float = 15.0
    http_user_agent: str = BROWSER_USER_AGENT
    # Endpoint nội bộ Pinterest chặn request không kèm cookie session + CSRF token
    # hợp lệ (xác nhận qua devtools thật: request giống hệt nhưng thiếu cookie -> 403
    # "Invalid Resource Request"). Tạm thời cần export cookie thủ công từ trình duyệt
    # đã đăng nhập; giải pháp lâu dài là chuyển sang Playwright với persistent context
    # (xem docs/SOURCES.md phần pinterest_suggest).
    pinterest_cookie: str | None = None


@lru_cache
def get_settings() -> Settings:
    return Settings()
