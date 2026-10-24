import importlib.util
from io import BytesIO
from pathlib import Path

from PIL import Image
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "prepare_scin.py"
spec = importlib.util.spec_from_file_location("prepare_scin", SCRIPT)
scin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scin)


def jpeg(width: int, height: int) -> bytes:
    output = BytesIO()
    Image.new("RGB", (width, height), (100, 80, 70)).save(output, format="JPEG")
    return output.getvalue()


def test_images_over_the_pixel_budget_are_skipped():
    original_limit = scin.MAX_PIXELS
    original_pillow_limit = Image.MAX_IMAGE_PIXELS
    data = jpeg(32, 24)
    try:
        scin.MAX_PIXELS = 40_000_000
        assert scin.decode_supported_image(data) == {"format": "JPEG", "width": 32, "height": 24}

        # 768 pixels sits between the budget and twice the budget, so Pillow warns.
        scin.MAX_PIXELS = 500
        assert scin.decode_supported_image(data) is None

        # 768 pixels is more than twice this budget, so Pillow raises DecompressionBombError.
        scin.MAX_PIXELS = 100
        assert scin.decode_supported_image(data) is None

        assert scin.decode_supported_image(b"not an image") is None
    finally:
        scin.MAX_PIXELS = original_limit
        Image.MAX_IMAGE_PIXELS = original_pillow_limit


def test_direct_inspection_still_reports_bomb_errors():
    original_limit = scin.MAX_PIXELS
    original_pillow_limit = Image.MAX_IMAGE_PIXELS
    try:
        scin.MAX_PIXELS = 500
        with pytest.raises((Image.DecompressionBombError, Image.DecompressionBombWarning)):
            scin.inspect_image(jpeg(32, 24))
    finally:
        scin.MAX_PIXELS = original_limit
        Image.MAX_IMAGE_PIXELS = original_pillow_limit
