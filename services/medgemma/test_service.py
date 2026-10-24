import base64
from copy import deepcopy
from io import BytesIO
import json
import pytest
from fastapi.testclient import TestClient
from PIL import Image
from service import create_app, MODEL_ID

@pytest.fixture
def payload():
    image = Image.new("RGB", (64, 64), (135, 115, 100))
    encoded = BytesIO()
    image.save(encoded, format="JPEG")
    return {"imageSourceId": "image-1", "imageBase64": base64.b64encode(encoded.getvalue()).decode(), "mime": "image/jpeg", "quality": {"status": "limited", "reasons": ["Low detail"], "guidance": ["Retake"]}, "context": {"specialty": "urgent_care", "imageType": "clinical_photo", "anatomicalLocation": "", "physicianContext": "Synthetic only"}, "transcript": {"id": "transcript-1", "text": "Patient reports no pain. Clinician says no swelling.", "start": 0, "end": 50}}

def response():
    return {"imageSourceId": "image-1", "imageType": "clinical photograph", "specialty": "urgent_care", "anatomicalRegion": {"value": "", "source": "unknown", "visuallyConfirmed": False, "transcriptQuote": None}, "characteristics": [{"id": "c1", "category": "Appearance", "description": "Possible swelling", "certainty": "uncertain", "limitations": "Limited view", "evidence": {"imageSourceId": "image-1", "visibleRegion": "central region", "transcriptSourceId": "transcript-1", "transcriptQuote": "Clinician says no swelling."}}], "reportedHistory": [], "conflicts": [], "limitations": [], "requiresPhysicianReview": True}

class FakeModel:
    revision = "mock-revision"
    def __init__(self, result=None):
        self.result = response() if result is None else result
        self.prompts = []
    def __call__(self, image, prompt):
        assert image.mode == "RGB"
        self.prompts.append(prompt)
        return self.result if isinstance(self.result, str) else json.dumps(self.result)

@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("MEDGEMMA_API_KEY", "synthetic-test-key-only")
    model = FakeModel()
    with TestClient(create_app(model), headers={"Authorization": "Bearer synthetic-test-key-only"}) as c:
        yield c, model

def test_context_and_image_reach_model(client, payload):
    c, model = client
    result = c.post("/analyze", json=payload)
    assert result.status_code == 200, result.text
    assert result.json()["model"] == MODEL_ID
    assert "Patient reports no pain" in model.prompts[0]
    assert "urgent_care" in model.prompts[0]
    assert "image-1" in model.prompts[0]
    assert "NEVER proof of visibility" in model.prompts[0]
    assert result.headers["cache-control"] == "no-store"

def test_auth_before_inference(client, payload):
    c, model = client
    assert c.post("/analyze", json=payload, headers={"Authorization": "Bearer wrong"}).status_code == 401
    assert not model.prompts

def test_image_only(client, payload):
    c, model = client
    payload["transcript"] = None
    model.result["characteristics"][0]["evidence"].update(transcriptSourceId=None, transcriptQuote=None)
    assert c.post("/analyze", json=payload).status_code == 200
    assert '"transcript": null' in model.prompts[0]

@pytest.mark.parametrize(("variant", "stage"), [
    ("malformed", "JSON parsing"),
    ("foreign_image", "evidence validation"),
    ("foreign_transcript", "evidence validation"),
    ("invented_quote", "evidence validation"),
    ("visual_history", "schema validation"),
    ("anatomical_inference", "evidence validation"),
    ("missing_limitation", "evidence validation"),
    ("extra_diagnosis", "schema validation"),
])
def test_invalid_output_is_redacted(client, payload, variant, stage):
    c, model = client
    if variant == "malformed": model.result = "private raw failure data"
    elif variant == "foreign_image": model.result["characteristics"][0]["evidence"]["imageSourceId"] = "wrong"
    elif variant == "foreign_transcript": model.result["characteristics"][0]["evidence"]["transcriptSourceId"] = "wrong"
    elif variant == "invented_quote": model.result["characteristics"][0]["evidence"]["transcriptQuote"] = "private invented quote"
    elif variant == "visual_history": model.result["reportedHistory"] = [{"description": "History", "attribution": "patient_report", "transcriptSourceId": "transcript-1", "transcriptQuote": "no pain", "verifiedByCurrentImage": True}]
    elif variant == "anatomical_inference": model.result["anatomicalRegion"].update(source="transcript", value="arm", visuallyConfirmed=True, transcriptQuote="no pain")
    elif variant == "missing_limitation": model.result["characteristics"][0]["limitations"] = ""
    else: model.result["diagnosis"] = "private diagnosis"
    result = c.post("/analyze", json=payload)
    assert result.status_code == 502
    assert "private" not in result.text
    assert "no fallback" in result.text
    assert f"{stage} failed" in result.text
    assert result.headers["x-spotcheckmd-failure-stage"] == stage

def test_unconfirmed_image_anatomy_is_discarded_not_rejected(client, payload):
    c, model = client
    model.result["anatomicalRegion"] = {"value": "circle", "source": "image", "visuallyConfirmed": False, "transcriptQuote": None}
    result = c.post("/analyze", json=payload)
    assert result.status_code == 200, result.text
    analysis = result.json()["analysis"]
    assert analysis["anatomicalRegion"] == {"value": "", "source": "unknown", "visuallyConfirmed": False, "transcriptQuote": None}
    assert "discarded" in analysis["limitations"][-1]
    model.result["anatomicalRegion"] = {"value": "forearm", "source": "image", "visuallyConfirmed": True, "transcriptQuote": None}
    assert c.post("/analyze", json=payload).json()["analysis"]["anatomicalRegion"]["value"] == "forearm"

def test_failure_diagnostics_name_the_stage_without_content(client, payload, caplog):
    c, model = client
    model.last_diagnostics = {"finishReason": "stop", "promptTokens": 10, "completionTokens": 5}
    model.result["characteristics"][0]["evidence"]["transcriptQuote"] = "private invented quote"
    model.result["characteristics"][0]["description"] = "private description"
    with caplog.at_level("WARNING", logger="medgemma.diagnostics"):
        assert c.post("/analyze", json=payload).status_code == 502
        model.result = "private raw failure data"
        assert c.post("/analyze", json=payload).status_code == 502
    text = caplog.text
    assert "stage=evidence validation" in text and "Invalid quote" in text
    assert "invalid JSON at character" in text and "completionTokens" in text
    assert "private" not in text

def test_request_and_media_validation_are_redacted(client, payload):
    c, _ = client
    payload["context"]["specialty"] = "PRIVATE-INVALID"
    result = c.post("/analyze", json=payload)
    assert result.status_code == 422 and "PRIVATE" not in result.text
    payload["context"]["specialty"] = "general"
    payload["imageBase64"] = "not an image"
    result = c.post("/analyze", json=payload)
    assert result.status_code == 502 and "image decoding failed" in result.text

def test_model_exception_has_no_details(client, payload):
    c, model = client
    model.result = None
    assert c.post("/analyze", json=payload).status_code == 502

def test_characteristics_conflict_is_preserved(client, payload):
    c, model = client
    model.result["conflicts"] = [{"description": "Visual/spoken discrepancy", "characteristicIds": ["c1"], "transcriptSourceId": "transcript-1", "transcriptQuote": "no swelling"}]
    result = c.post("/analyze", json=payload)
    assert result.status_code == 200
    assert len(result.json()["analysis"]["conflicts"]) == 1

def test_runtime_provenance_is_preserved(client, payload):
    c, model = client
    model.runtime = {"engine": "llama.cpp", "engineRevision": "a" * 40, "converterRevision": "b" * 40,
                     "quantization": "Q4_K_M", "modelSha256": "c" * 64, "projectorSha256": "d" * 64}
    result = c.post("/analyze", json=payload)
    assert result.status_code == 200
    assert result.json()["runtime"] == model.runtime
