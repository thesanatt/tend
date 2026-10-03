"""Input validation (SPEC v1.2 point 4, engine/FORMAT.md section 5): first problem in document order.

Each case runs through the reference and, when engine/build/libtend is built, through the C++
engine too: well-formed JSON must give byte-identical results, and text that is not JSON must
be refused by both with bad_input.
"""

import ctypes
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from claims import FIXTURES, REPO, law, rule
from tend_ref import EngineInputError, Law, evaluate, evaluate_json, load_law

CTX = '"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03"}'


def with_item(fields: str) -> str:
    return "{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01",' + fields + "}]}"


CASES = [
    ("{" + CTX + "}", "ok"),
    ("{" + CTX + ',"items":null}', "ok"),
    ('{"items":[]}', "bad_input: context is required"),
    ('{"context":{"as_of_date":"2026-10-03"}}', "bad_input: context.incident_date is required"),
    ('{"context":{"incident_date":"2026-06-14"}}', "bad_input: context.as_of_date is required"),
    ('{"context":{"incident_date":"2026-6-14","as_of_date":"2026-10-03"}}',
     "bad_input: context.incident_date: expected a date as YYYY-MM-DD"),
    ('{"context":{"incident_date":"2026-02-29","as_of_date":"2026-10-03"}}',
     "bad_input: context.incident_date: expected a date as YYYY-MM-DD"),
    ('{"context":{"incident_date":"0000-01-01","as_of_date":"2026-10-03"}}',
     "bad_input: context.incident_date: expected a date as YYYY-MM-DD"),
    ('{"context":{"incident_date":20260614,"as_of_date":"2026-10-03"}}',
     "bad_input: context.incident_date: expected a date as YYYY-MM-DD"),
    ('{"context":null}', "bad_input: context: expected an object"),
    ("{" + CTX + "," + CTX + "}", "bad_input: context: appears twice"),
    ('{"context":{"incident_date":"2026-06-14","incident_date":"2026-06-15","as_of_date":"2026-10-03"}}',
     "bad_input: context.incident_date: appears twice"),
    ('{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","forensic_exam":"yes"}}',
     "bad_input: context.forensic_exam: expected true or false"),
    ('{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","police_report":"maybe"}}',
     "bad_input: context.police_report: expected yes, no, or unknown"),
    ('{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","police_report":true}}',
     "bad_input: context.police_report: expected yes, no, or unknown"),
    ('{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03","police_report":null,"forensic_exam":null}}', "ok"),
    ("{" + CTX + ',"jurisdiction":"MI"}', "jurisdiction_mismatch: input is for MI but the law image is ZZ"),
    ("{" + CTX + ',"jurisdiction":null}', "ok"),
    ("{" + CTX + ',"jurisdiction":5}', "bad_input: jurisdiction: expected a string"),
    ("{" + CTX + ',"items":{}}', "bad_input: items: expected an array"),
    ("{" + CTX + ',"items":[7]}', "bad_input: items[0]: expected an object"),
    (with_item('"amount_cents":-1'), "bad_input: items[0].amount_cents: must not be negative"),
    (with_item('"amount_cents":1.5'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":1e2'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":-0.0'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":"5"'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":null'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":true'), "bad_input: items[0].amount_cents: expected an integer"),
    (with_item('"amount_cents":-0'), "ok"),
    (with_item('"amount_cents":9007199254740991'), "ok"),
    (with_item('"amount_cents":9007199254740992'), "bad_input: items[0].amount_cents: integer out of range"),
    (with_item('"amount_cents":-9007199254740991'), "bad_input: items[0].amount_cents: must not be negative"),
    (with_item('"amount_cents":-9007199254740992'), "bad_input: items[0].amount_cents: integer out of range"),
    (with_item('"amount_cents":9223372036854775808'), "bad_input: items[0].amount_cents: integer out of range"),
    (with_item('"amount_cents":' + "9" * 40), "bad_input: items[0].amount_cents: integer out of range"),
    (with_item('"amount_cents":1,"amount_cents":2'), "bad_input: items[0].amount_cents: appears twice"),
    (with_item('"amount_cents":1,"insurance_paid_cents":-1'), "bad_input: items[0].insurance_paid_cents: must not be negative"),
    (with_item('"amount_cents":1,"insurance_paid_cents":null,"units":null,"unit":null,"expense":null,"tags":null'), "ok"),
    (with_item('"amount_cents":1,"units":-2'), "bad_input: items[0].units: must not be negative"),
    (with_item('"amount_cents":1,"units":9007199254740992'), "bad_input: items[0].units: integer out of range"),
    (with_item('"amount_cents":1,"confirmed":"yes"'), "bad_input: items[0].confirmed: expected true or false"),
    (with_item('"amount_cents":1,"is_bill":0'), "bad_input: items[0].is_bill: expected true or false"),
    (with_item('"amount_cents":1,"expense":"groceries"'), "bad_input: items[0].expense: not a known expense"),
    (with_item('"amount_cents":1,"expense":"Medical"'), "bad_input: items[0].expense: not a known expense"),
    (with_item('"amount_cents":1,"expense":3'), "bad_input: items[0].expense: expected a string"),
    (with_item('"amount_cents":1,"expense":"unknown"'), "ok"),
    (with_item('"amount_cents":1,"unit":"fortnight"'), "bad_input: items[0].unit: not a known unit"),
    (with_item('"amount_cents":1,"unit":""'), "bad_input: items[0].unit: not a known unit"),
    (with_item('"amount_cents":1,"unit":["week"]'), "bad_input: items[0].unit: expected a string"),
    (with_item('"amount_cents":1,"unit":"month"'), "ok"),
    (with_item('"amount_cents":1,"tags":"phone"'), "bad_input: items[0].tags: expected a list of strings"),
    (with_item('"amount_cents":1,"tags":[1]'), "bad_input: items[0].tags: expected a list of strings"),
    (with_item('"amount_cents":1,"tags":["phone",null]'), "bad_input: items[0].tags: expected a list of strings"),
    (with_item('"units":-1,"amount_cents":-1'), "bad_input: items[0].units: must not be negative"),
    ('{"items":[{"item_id":"a","date":"2026-07-01","amount_cents":-1}]}',
     "bad_input: items[0].amount_cents: must not be negative"),
    ("{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01"}]}', "bad_input: items[0].amount_cents is required"),
    ("{" + CTX + ',"items":[{"date":"2026-07-01"}]}', "bad_input: items[0].item_id is required"),
    ("{" + CTX + ',"items":[{"item_id":"","date":"2026-07-01","amount_cents":1}]}', "bad_input: items[0].item_id: must not be empty"),
    ("{" + CTX + ',"items":[{"item_id":7,"date":"2026-07-01","amount_cents":1}]}', "bad_input: items[0].item_id: expected a string"),
    ("{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01","amount_cents":1},{"item_id":"a","date":"2026-08-01","amount_cents":1}]}',
     "bad_input: items[1].item_id: duplicate of items[0]"),
    ("{" + CTX + ',"items":[{"item_id":"é","date":"2026-07-01","amount_cents":1},{"item_id":"\\u00e9","date":"2026-08-01","amount_cents":1}]}',
     "bad_input: items[1].item_id: duplicate of items[0]"),
    ("{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01","amount_cents":-1},{"item_id":"a","date":"2026-08-01","amount_cents":1}]}',
     "bad_input: items[0].amount_cents: must not be negative"),
    ('{"jurisdiction":"MI","items":[{"item_id":"a"}]}', "bad_input: items[0].date is required"),
    ('{"jurisdiction":"MI",' + CTX + "}", "jurisdiction_mismatch: input is for MI but the law image is ZZ"),
    ("[]", "bad_input: input: expected an object"),
    ("5", "bad_input: input: expected an object"),
    ('"text"', "bad_input: input: expected an object"),
    ("{" + CTX + ',"note":1e999,"other":[1,{"a":[]}],"z":' + "9" * 30 + "}", "ok"),
]

MALFORMED = [
    "", " ", "{", "{" + CTX + "} trailing", "{" + CTX + ',"extra":NaN}', "{" + CTX + ',"x":Infinity}',
    "{" + CTX + ',"items":[{"item_id":"\\ud800","date":"2026-07-01","amount_cents":1}]}',
    "{" + CTX + ',"extra":"\\udc00"}', "{" + CTX + ',"extra":' + "[" * 70 + "]" * 70 + "}",
    "﻿{" + CTX + "}", "{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01","amount_cents":01}]}',
    "{" + CTX + ',"items":[{"item_id":"a","date":"2026-07-01","amount_cents":+1}]}', "{'context':{}}",
    "{" + CTX + ',"x":"tab\there"}', "{" + CTX + ",}",
]


def zz_law() -> Law:
    return load_law(FIXTURES / "ir" / "ZZ.json")


def summary(text: str) -> str:
    doc = json.loads(text)
    return "ok" if "lines" in doc else f"{doc['error']['code']}: {doc['error']['message']}"


@pytest.mark.parametrize("raw,expected", CASES)
def test_reference_messages(raw, expected):
    assert summary(evaluate_json(zz_law(), raw.encode())) == expected


@pytest.mark.parametrize("raw", MALFORMED)
def test_text_that_is_not_json_is_bad_input(raw):
    assert summary(evaluate_json(zz_law(), raw.encode())).startswith("bad_input: invalid JSON")


def test_deepest_allowed_nesting():
    ok = "{" + CTX + ',"x":' + "[" * 62 + "]" * 62 + "}"  # 63 levels with the outer object
    deep = "{" + CTX + ',"x":' + "[" * 64 + "]" * 64 + "}"  # 65 levels
    assert summary(evaluate_json(zz_law(), ok.encode())) == "ok"
    assert summary(evaluate_json(zz_law(), deep.encode())) == "bad_input: invalid JSON: nesting too deep"


def test_text_after_a_nul_byte_is_never_seen():
    # The C ABI takes a C string.
    assert summary(evaluate_json(zz_law(), ("{" + CTX + "}").encode() + b"\0 garbage")) == "ok"


def test_invalid_utf8_is_bad_input():
    assert summary(evaluate_json(zz_law(), b'{"context":{"incident_date":"2026-06-14","as_of_date":"2026-10-03"},"x":"\xff"}')) \
        == "bad_input: invalid JSON: invalid UTF-8"


def test_description_and_other_fields_are_never_echoed():
    raw = with_item('"amount_cents":1,"description":"SECRET-TEXT","note":{"x":"SECRET-TEXT"}')
    assert "SECRET-TEXT" not in evaluate_json(zz_law(), raw.encode())


def test_evaluate_on_a_dict_raises_with_the_same_message():
    with pytest.raises(EngineInputError) as e:
        evaluate(law([rule("T", "covered", expense="medical")]),
                 {"context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"},
                  "items": [{"item_id": "a", "date": "2026-07-01", "amount_cents": 1, "unit": "fortnight"}]})
    assert (e.value.code, e.value.message) == ("bad_input", "items[0].unit: not a known unit")
    with pytest.raises(EngineInputError, match="unpaired surrogate"):
        evaluate(law([]), {"context": {"incident_date": "2026-06-14", "as_of_date": "2026-10-03"}, "x": "\ud800"})


# The same cases through the C++ engine, when it is built.

def _native():
    build = REPO / "engine" / "build"
    lib = next((build / n for n in ("libtend.dylib", "libtend.so") if (build / n).is_file()), None)
    tendc = build / "tendc"
    if lib is None or not tendc.is_file():
        return None
    image_path = Path(__file__).parent / ".zz_test.tlaw"
    ir = FIXTURES / "ir" / "ZZ.json"
    subprocess.run([str(tendc), "--quiet", str(ir), "--verified", str(FIXTURES / "verified" / "ZZ.json"), "-o",
                    str(image_path)], check=True)
    image = image_path.read_bytes()
    image_path.unlink()
    cdll = ctypes.CDLL(str(lib))
    cdll.tend_eval_json.argtypes = [ctypes.c_char_p, ctypes.c_size_t, ctypes.c_char_p]
    cdll.tend_eval_json.restype = ctypes.c_void_p
    cdll.tend_free.argtypes = [ctypes.c_void_p]

    def run(raw: bytes) -> bytes:
        ptr = cdll.tend_eval_json(image, len(image), raw)
        try:
            return ctypes.string_at(ptr)
        finally:
            cdll.tend_free(ptr)

    return run, load_law(ir, law_sha256=hashlib.sha256(image).hexdigest())


NATIVE = _native()
needs_native = pytest.mark.skipif(NATIVE is None, reason="engine/build/libtend and tendc are not built")


@needs_native
@pytest.mark.parametrize("raw,expected", CASES)
def test_cpp_engine_gives_the_same_bytes(raw, expected):
    run, ref_law = NATIVE
    assert run(raw.encode()).decode() == evaluate_json(ref_law, raw.encode())


@needs_native
@pytest.mark.parametrize("raw", MALFORMED)
def test_cpp_engine_also_refuses_text_that_is_not_json(raw):
    run, _ = NATIVE
    doc = json.loads(run(raw.encode()))
    assert doc["error"]["code"] == "bad_input"
