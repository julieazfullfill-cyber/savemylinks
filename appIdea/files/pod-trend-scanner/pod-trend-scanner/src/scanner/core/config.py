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
    uspto_api_key: str | None = None
    log_level: str = "INFO"
    collect_country: str = "US"
    http_timeout_seconds: float = 15.0
    http_user_agent: str = BROWSER_USER_AGENT


@lru_cache
def get_settings() -> Settings:
    return Settings()
