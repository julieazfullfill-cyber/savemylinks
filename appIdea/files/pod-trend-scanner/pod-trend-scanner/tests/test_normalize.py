from scanner.core.normalize import better_display, clean_display, normalize


def test_punctuation_and_case_collapse_to_same_term() -> None:
    a_norm, a_key = normalize("Bridesmaid Proposal Box!")
    b_norm, b_key = normalize("bridesmaid proposal box")
    assert a_norm == b_norm == "bridesmaid proposal box"
    assert a_key == b_key


def test_word_order_and_stopwords_share_text_key() -> None:
    _, key_a = normalize("gift for bridesmaid")
    _, key_b = normalize("bridesmaid gift")
    assert key_a == key_b == "bridesmaid gift"


def test_text_norm_keeps_word_order() -> None:
    norm_a, _ = normalize("gift for bridesmaid")
    norm_b, _ = normalize("bridesmaid gift")
    assert norm_a != norm_b


def test_unicode_and_whitespace_are_normalized() -> None:
    norm, key = normalize("  Mr.  &  Mrs.   Tote Bag ")
    assert norm == "mr mrs tote bag"
    assert key == "bag mr mrs tote"


def test_clean_display_keeps_original_casing() -> None:
    assert clean_display("  Bridesmaid   Proposal Box! ") == "Bridesmaid Proposal Box!"


def test_better_display_prefers_best_rank() -> None:
    assert better_display("old", "new", 5, 2) == "new"
    assert better_display("old", "new", 2, 5) == "old"
    assert better_display("old", "new", None, 4) == "new"
    assert better_display("old", "new", 3, None) == "old"
