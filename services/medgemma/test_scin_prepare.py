import importlib.util
from io import BytesIO
from pathlib import Path

from PIL import Image
import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "prepare_scin.py"
spec = importlib.util.spec_from_file_location("prepare_scin", SCRIPT)
scin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scin)


def case(case_id, image, **fields):
    return {"case_id": case_id, "image_1_path": image, "image_2_path": "", "image_3_path": "",
            "body_parts_arm": "True", "condition_duration": "LESS_THAN_ONE_WEEK", **fields}


def test_deterministic_selection_excludes_known_missing_and_unsafe_paths():
    rows = [
        case("1", next(iter(scin.KNOWN_MISSING))),
        case("2", "https://example.com/private.jpg"),
        case("3", "dataset/images/valid-a"),
        case("4", "dataset/images/valid-b"),
    ]
    labels = {"3": {"monk_skin_tone_label_us": "[2]"}, "4": {"monk_skin_tone_label_us": "[8]"}}
    first = [(item[0]["case_id"], item[1]) for item in scin.candidate_order(rows, labels)]
    second = [(item[0]["case_id"], item[1]) for item in scin.candidate_order(rows, labels)]
    assert first == second
    assert {case_id for case_id, _ in first} == {"3", "4"}
    with pytest.raises(ValueError):
        scin.clean_object_path("dataset/images/../labels.csv")


def test_context_uses_only_self_report_fields():
    row = case("1", "dataset/images/a", textures_rough_or_flaky="true", condition_symptoms_itching="TRUE",
               dermatologist_skin_condition_on_label_name="PRIVATE DIAGNOSIS")
    transcript, metadata = scin.transcript_for(row)
    assert "arm" in transcript and "rough or flaky" in transcript and "itching" in transcript
    assert "less than one week" in transcript
    assert "PRIVATE" not in transcript and "dermatologist" not in transcript.lower()
    assert metadata["bodyLocations"] == ["arm"]


def test_supported_image_is_decoded():
    output = BytesIO()
    Image.new("RGB", (32, 24), (100, 80, 70)).save(output, format="JPEG")
    assert scin.inspect_image(output.getvalue()) == {"format": "JPEG", "width": 32, "height": 24}
