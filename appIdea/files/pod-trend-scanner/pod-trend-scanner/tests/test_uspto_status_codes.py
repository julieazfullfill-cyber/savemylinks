"""Test bảng mã trạng thái USPTO — xem nguồn ở docstring module
pipeline/uspto_status_codes.py (Table 1 Trademark Status Codes, tài liệu chính thức
USPTO, không phải suy đoán)."""

from scanner.pipeline.uspto_status_codes import STATUS_CODE_DESCRIPTIONS, classify_case_status


def test_registered_is_live() -> None:
    assert classify_case_status("700") == "live"


def test_registered_and_renewed_is_live() -> None:
    assert classify_case_status("800") == "live"


def test_new_application_pending_examiner_is_live() -> None:
    # Mẫu thật lấy từ file bulk XML người dùng cung cấp (serial 99698238, IBABY).
    assert classify_case_status("630") == "live"


def test_abandoned_no_statement_of_use_is_dead() -> None:
    assert classify_case_status("606") == "dead"


def test_abandoned_express_is_dead() -> None:
    assert classify_case_status("601") == "dead"


def test_cancelled_section_8_is_dead() -> None:
    assert classify_case_status("710") == "dead"


def test_expired_is_dead() -> None:
    assert classify_case_status("900") == "dead"


def test_revived_awaiting_further_action_is_live_not_dead() -> None:
    # 616 nghĩa là hồ sơ đã được khôi phục -- vẫn còn sống, không được coi là abandoned.
    assert classify_case_status("616") == "live"


def test_status_unclear_is_unknown_not_dead() -> None:
    # 625 tự mô tả là "STATUS UNCLEAR" -- không được tự suy diễn thành dead để cho qua.
    assert classify_case_status("625") == "unknown"


def test_misassigned_serial_number_is_unknown() -> None:
    assert classify_case_status("622") == "unknown"


def test_literal_unknown_code_000_is_unknown() -> None:
    assert classify_case_status("000") == "unknown"


def test_code_not_in_official_table_is_unknown_not_dead() -> None:
    # Mã lạ không có trong Table 1 -- fail-closed, không đoán là dead.
    assert classify_case_status("123") == "unknown"


def test_accepts_unpadded_numeric_code() -> None:
    assert classify_case_status("6") == classify_case_status("006")


def test_every_dead_and_unknown_code_exists_in_official_table() -> None:
    from scanner.pipeline.uspto_status_codes import _DEAD_CODES, _UNKNOWN_CODES

    for code in _DEAD_CODES | _UNKNOWN_CODES:
        assert code in STATUS_CODE_DESCRIPTIONS, f"{code} không có trong Table 1 thật"
