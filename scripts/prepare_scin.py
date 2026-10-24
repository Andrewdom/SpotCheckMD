#!/usr/bin/env python3
"""Prepare a small, private SCIN manifest for local MedGemma integration tests."""

import argparse
import csv
import hashlib
from io import BytesIO
import json
from pathlib import Path, PurePosixPath
import re
import stat
import urllib.parse
import warnings

import httpx
from PIL import Image

BUCKET = "https://storage.googleapis.com/dx-scin-public-data/"
CASES_OBJECT = "dataset/scin_cases.csv"
LABELS_OBJECT = "dataset/scin_labels.csv"
# Pin the official objects used during development. A changed release must be reviewed explicitly.
CASES_GENERATION = "1709616753207855"
LABELS_GENERATION = "1709613940476179"
KNOWN_MISSING = {"dataset/images/-2243186711511406658"}
MAX_IMAGE_BYTES = 20 * 1024 * 1024
MAX_PIXELS = 40_000_000
LICENSE_URL = "https://github.com/google-research-datasets/scin/blob/main/LICENSE"
SOURCE_URL = "https://github.com/google-research-datasets/scin"

BODY_FIELDS = {
    "body_parts_head_or_neck": "head or neck",
    "body_parts_arm": "arm",
    "body_parts_palm": "palm",
    "body_parts_back_of_hand": "back of hand",
    "body_parts_torso_front": "front of torso",
    "body_parts_torso_back": "back of torso",
    "body_parts_leg": "leg",
    "body_parts_foot_top_or_side": "top or side of foot",
    "body_parts_foot_sole": "sole of foot",
    "body_parts_other": "other location",
}
TEXTURE_FIELDS = {
    "textures_raised_or_bumpy": "raised or bumpy",
    "textures_flat": "flat",
    "textures_rough_or_flaky": "rough or flaky",
    "textures_fluid_filled": "fluid filled",
}
CONDITION_FIELDS = {
    "condition_symptoms_bothersome_appearance": "bothersome appearance",
    "condition_symptoms_bleeding": "bleeding",
    "condition_symptoms_increasing_size": "increasing size",
    "condition_symptoms_darkening": "darkening",
    "condition_symptoms_itching": "itching",
    "condition_symptoms_burning": "burning",
    "condition_symptoms_pain": "pain",
    "condition_symptoms_no_relevant_experience": "no relevant condition-associated experience",
}
OTHER_FIELDS = {
    "other_symptoms_fever": "fever",
    "other_symptoms_chills": "chills",
    "other_symptoms_fatigue": "fatigue",
    "other_symptoms_joint_pain": "joint pain",
    "other_symptoms_mouth_sores": "mouth sores",
    "other_symptoms_shortness_of_breath": "shortness of breath",
    "other_symptoms_no_relevant_symptoms": "no relevant additional symptoms",
}


def truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes"}


def selected(row: dict[str, str], fields: dict[str, str]) -> list[str]:
    return [label for key, label in fields.items() if truthy(row.get(key))]


def clean_object_path(value: str) -> str:
    value = (value or "").strip()
    path = PurePosixPath(value)
    if not value.startswith("dataset/images/") or path.is_absolute() or ".." in path.parts:
        raise ValueError("SCIN image path is outside the official images directory")
    return str(path)


def object_url(object_path: str, generation: str | None = None) -> str:
    url = BUCKET + urllib.parse.quote(object_path, safe="/")
    return url + ("?generation=" + generation if generation else "")


def download(url: str, destination: Path, limit: int) -> dict[str, str]:
    try:
        with httpx.Client(follow_redirects=False, trust_env=False, timeout=60,
                          headers={"User-Agent": "SpotCheckMD-SCIN-preparation/1"}) as client:
            with client.stream("GET", url) as response:
                response.raise_for_status()
                if response.url.scheme != "https" or response.url.host != "storage.googleapis.com":
                    raise ValueError("Unexpected SCIN download host")
                length = response.headers.get("Content-Length")
                if length and int(length) > limit:
                    raise ValueError("SCIN download exceeds configured size limit")
                digest = hashlib.sha256()
                total = 0
                with destination.open("xb") as stream:
                    destination.chmod(stat.S_IRUSR | stat.S_IWUSR)
                    for chunk in response.iter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > limit:
                            raise ValueError("SCIN download exceeds configured size limit")
                        digest.update(chunk)
                        stream.write(chunk)
                return {"sha256": digest.hexdigest(), "bytes": total,
                        "etag": (response.headers.get("ETag") or "").strip('"')}
    except Exception:
        destination.unlink(missing_ok=True)
        raise


def tone_values(label: dict[str, str]) -> list[int]:
    values: list[int] = []
    for key in ("monk_skin_tone_label_india", "monk_skin_tone_label_us"):
        for match in re.findall(r"(?<!\d)(10|[1-9])(?!\d)", label.get(key, "") or ""):
            values.append(int(match))
    return values


def tone_bucket(label: dict[str, str]) -> str:
    values = tone_values(label)
    if not values:
        return "unknown"
    mean = sum(values) / len(values)
    return "lighter" if mean <= 3 else "middle" if mean <= 6 else "darker"


def transcript_for(row: dict[str, str]) -> tuple[str, dict[str, object]]:
    body = selected(row, BODY_FIELDS)
    textures = selected(row, TEXTURE_FIELDS)
    condition = selected(row, CONDITION_FIELDS)
    other = selected(row, OTHER_FIELDS)
    duration = (row.get("condition_duration") or "").strip()
    statements = ["Synthetic encounter context constructed only from SCIN contributor self-reports."]
    if body:
        statements.append("The contributor reported affected body location(s): " + ", ".join(body) + ".")
    if textures:
        statements.append("The contributor reported texture(s): " + ", ".join(textures) + ".")
    if condition:
        statements.append("The contributor reported condition-associated experience(s): " + ", ".join(condition) + ".")
    if other:
        statements.append("The contributor reported additional symptom(s): " + ", ".join(other) + ".")
    if duration:
        statements.append("The contributor reported duration: " + duration.lower().replace("_", " ") + ".")
    metadata = {"bodyLocations": body, "textures": textures, "conditionExperiences": condition,
                "otherSymptoms": other, "duration": duration or None}
    return " ".join(statements), metadata


def candidate_order(cases: list[dict[str, str]], labels: dict[str, dict[str, str]]) -> list[tuple[dict[str, str], str, int, str]]:
    buckets: dict[str, list[tuple[dict[str, str], str, int, str]]] = {key: [] for key in ("lighter", "middle", "darker", "unknown")}
    for row in cases:
        if not selected(row, BODY_FIELDS):
            continue
        case_id = (row.get("case_id") or "").strip()
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", case_id):
            continue
        bucket = tone_bucket(labels.get(case_id, {}))
        for index in range(1, 4):
            raw = row.get(f"image_{index}_path") or ""
            if not raw.strip():
                continue
            try:
                image_path = clean_object_path(raw)
            except ValueError:
                continue
            if image_path in KNOWN_MISSING:
                continue
            buckets[bucket].append((row, image_path, index, bucket))
    for values in buckets.values():
        values.sort(key=lambda item: hashlib.sha256(f"{item[0]['case_id']}:{item[1]}".encode()).hexdigest())
    ordered = []
    while any(buckets.values()):
        for bucket in ("lighter", "middle", "darker", "unknown"):
            if buckets[bucket]:
                ordered.append(buckets[bucket].pop(0))
    return ordered


def inspect_image(data: bytes) -> dict[str, object]:
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    with warnings.catch_warnings():
        warnings.simplefilter("error", Image.DecompressionBombWarning)
        with Image.open(BytesIO(data)) as image:
            image.verify()
        with Image.open(BytesIO(data)) as image:
            image.load()
            if image.format not in {"JPEG", "PNG"} or image.width * image.height > MAX_PIXELS:
                raise ValueError("SCIN image is not a supported JPEG/PNG")
            return {"format": image.format, "width": image.width, "height": image.height}


def read_csv(path: Path) -> list[dict[str, str]]:
    with path.open(newline="", encoding="utf-8-sig") as stream:
        return list(csv.DictReader(stream))


def prepare(output: Path, count: int) -> None:
    output.mkdir(mode=0o700)
    metadata_dir = output / "metadata"
    image_dir = output / "images"
    metadata_dir.mkdir(mode=0o700)
    image_dir.mkdir(mode=0o700)
    cases_path = metadata_dir / "scin_cases.csv"
    labels_path = metadata_dir / "scin_labels.csv"
    cases_meta = download(object_url(CASES_OBJECT, CASES_GENERATION), cases_path, 3 * 1024 * 1024)
    labels_meta = download(object_url(LABELS_OBJECT, LABELS_GENERATION), labels_path, 3 * 1024 * 1024)
    cases = read_csv(cases_path)
    labels = {row["case_id"]: row for row in read_csv(labels_path) if row.get("case_id")}

    manifest = []
    provenance = []
    hashes: set[str] = set()
    for row, image_object, image_index, bucket in candidate_order(cases, labels):
        if len(manifest) >= count:
            break
        temporary = image_dir / f"candidate-{len(manifest)}.download"
        try:
            image_meta = download(object_url(image_object), temporary, MAX_IMAGE_BYTES)
            data = temporary.read_bytes()
            decoded = inspect_image(data)
        except (OSError, ValueError, httpx.HTTPError):
            temporary.unlink(missing_ok=True)
            continue
        if image_meta["sha256"] in hashes:
            temporary.unlink(missing_ok=True)
            continue
        hashes.add(image_meta["sha256"])
        case_id = row["case_id"]
        extension = ".jpg" if decoded["format"] == "JPEG" else ".png"
        filename = f"scin-{case_id}-{image_index}{extension}"
        destination = image_dir / filename
        temporary.rename(destination)
        transcript, self_report = transcript_for(row)
        test_id = f"scin-{case_id}-{image_index}"
        manifest.append({
            "id": test_id,
            "authorizedForModelProcessing": True,
            "imagePath": f"images/{filename}",
            "transcript": transcript,
            "context": {
                "specialty": "dermatology",
                "imageType": "clinical_photo",
                "anatomicalLocation": "",
                "physicianContext": "SCIN research photograph. Describe visible characteristics only; do not diagnose or infer history.",
            },
        })
        provenance.append({
            "testId": test_id,
            "caseId": case_id,
            "source": "SCIN",
            "release": row.get("release"),
            "imageObject": image_object,
            "imageShotType": row.get(f"image_{image_index}_shot_type") or None,
            "imageSha256": image_meta["sha256"],
            "imageBytes": image_meta["bytes"],
            "decodedImage": decoded,
            "skinToneSelectionBucket": bucket,
            "selfReportUsedForSyntheticContext": self_report,
        })
    if len(manifest) != count:
        raise RuntimeError(f"Only {len(manifest)} valid, unique SCIN images were available")

    common = {"source": SOURCE_URL, "license": LICENSE_URL, "noReidentification": True,
              "dermatologistConditionLabelsIncludedInModelInput": False}
    (output / "comparison-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "scin-provenance.json").write_text(json.dumps({"version": 1, **common,
        "metadata": {"cases": {"object": CASES_OBJECT, "generation": CASES_GENERATION, **cases_meta},
                     "labels": {"object": LABELS_OBJECT, "generation": LABELS_GENERATION, **labels_meta}},
        "cases": provenance}, indent=2) + "\n")
    for path in (output / "comparison-manifest.json", output / "scin-provenance.json"):
        path.chmod(stat.S_IRUSR | stat.S_IWUSR)
    print(f"Prepared {count} private SCIN case(s) in {output}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new private output directory outside the repository")
    parser.add_argument("--count", type=int, default=1, choices=range(1, 11))
    parser.add_argument("--run-download", action="store_true", help="required acknowledgement that network downloads will occur")
    parser.add_argument("--accept-scin-license", action="store_true", help="required acknowledgement of the SCIN Data Use License")
    args = parser.parse_args()
    if not args.run_download or not args.accept_scin_license:
        parser.error("both --run-download and --accept-scin-license are required")
    if args.output.exists():
        parser.error("output directory must not already exist")
    prepare(args.output.resolve(), args.count)


if __name__ == "__main__":
    main()
