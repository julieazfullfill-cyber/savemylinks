"""Chuẩn hoá term: text_norm để lookup chính xác, text_key để fuzzy dedupe."""

import re
import unicodedata

STOPWORDS = {"for", "the", "a", "an", "with", "and", "to", "of", "in", "on", "my", "your"}

_PUNCT = re.compile(r"[^\w\s]")
_SPACE = re.compile(r"\s+")


def normalize(text: str) -> tuple[str, str]:
    """Trả về (text_norm, text_key)."""
    s = unicodedata.normalize("NFKC", text).lower()
    s = _PUNCT.sub(" ", s)
    s = _SPACE.sub(" ", s).strip()
    text_norm = s
    tokens = sorted(t for t in s.split() if t not in STOPWORDS)
    text_key = " ".join(tokens)
    return text_norm, text_key


def clean_display(text: str) -> str:
    """Bản hiển thị: giữ nguyên chữ gốc, chỉ gọn khoảng trắng."""
    return _SPACE.sub(" ", unicodedata.normalize("NFKC", text)).strip()


def better_display(current: str, candidate: str, current_rank: int | None, candidate_rank: int | None) -> str:
    """Giữ text_display của bản có rank tốt nhất từng thấy (rank nhỏ hơn là tốt hơn)."""
    if candidate_rank is None:
        return current
    if current_rank is None or candidate_rank < current_rank:
        return candidate
    return current
