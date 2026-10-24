import base64
import json
from pathlib import Path
from types import SimpleNamespace

import httpx
from PIL import Image
import pytest

import local_runtime as local
from service import SCHEMA, create_app
from fastapi.testclient import TestClient

@pytest.fixture
def setup(tmp_path, monkeypatch):
    model, projector = tmp_path / "model.gguf", tmp_path / "vision.gguf"
    model.write_bytes(b"synthetic-model")
    projector.write_bytes(b"synthetic-vision")
    manifest = {"version": 1, "sourceModel": local.MODEL_ID, "sourceRevision": "a" * 40,
                "runtimeRevision": "b" * 40, "converterRevision": "c" * 40, "quantization": "Q4_K_M",
                "modelFile": model.name, "projectorFile": projector.name,
                "modelSha256": local.sha256_file(model), "projectorSha256": local.sha256_file(projector)}
    path = tmp_path / "manifest.json"
    path.write_text(json.dumps(manifest))
    binary = tmp_path / "llama-server"
    binary.touch()
    monkeypatch.setenv("MEDGEMMA_GGUF_MANIFEST", str(path))
    monkeypatch.setenv("MEDGEMMA_LLAMA_BINARY", str(binary))
    monkeypatch.setenv("HF_TOKEN", "synthetic-secret-must-not-reach-child")
    state = SimpleNamespace(command=None, child_env=None, terminated=False, client_closed=False)
    class Process:
        def poll(self): return 0 if state.terminated else None
        def terminate(self): state.terminated = True
        def wait(self, timeout): return 0
    def popen(command, **kwargs):
        state.command, state.child_env = command, kwargs["env"]
        return Process()
    monkeypatch.setattr(local.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="version (commit bbbbbbb)", stderr=""))
    monkeypatch.setattr(local.subprocess, "Popen", popen)
    class Client:
        def __init__(self, **kwargs): state.client_options = kwargs
        def get(self, *args, **kwargs):
            alias = state.command[state.command.index("--alias") + 1]
            return httpx.Response(200, json={"data": [{"id": alias}]})
        def post(self, path, json):
            state.payload = json
            return httpx.Response(200, request=httpx.Request("POST", "http://127.0.0.1/"),
                                  json={"choices": [{"finish_reason": state.finish, "message": {"content": "{}"}}], "usage": {"prompt_tokens": 7, "completion_tokens": 3}})
        def close(self): state.client_closed = True
    state.finish = "stop"
    monkeypatch.setattr(local.httpx, "Client", Client)
    return path, manifest, state

def test_owned_loopback_runtime_and_cleanup(setup):
    _, manifest, state = setup
    runtime = local.LlamaCpp(SCHEMA)
    keyfile = Path(state.command[state.command.index("--api-key-file") + 1])
    assert keyfile.stat().st_mode & 0o777 == 0o600
    assert "HF_TOKEN" not in state.child_env
    assert state.command[state.command.index("--host") + 1] == "127.0.0.1"
    assert state.command[state.command.index("--n-gpu-layers") + 1] == "0"
    assert "--no-mmproj-offload" in state.command
    assert "--no-context-shift" in state.command and "--log-disable" in state.command
    assert state.client_options["trust_env"] is False
    assert state.client_options["follow_redirects"] is False
    assert runtime.revision == manifest["sourceRevision"]
    assert runtime.runtime["modelSha256"] == manifest["modelSha256"]
    bound_schema = {**SCHEMA, "title": "request-bound"}
    assert runtime(Image.new("RGB", (16, 16)), "synthetic context only", bound_schema) == "{}"
    parts = state.payload["messages"][0]["content"]
    assert parts[1]["text"] == "synthetic context only"
    assert base64.b64decode(parts[0]["image_url"]["url"].split(",")[1]).startswith(b"\x89PNG")
    assert state.payload["response_format"] == {"type": "json_schema", "json_schema": {
        "name": "image_analysis", "strict": True, "schema": bound_schema}}
    assert state.payload["cache_prompt"] is False
    runtime.close()
    assert state.terminated and state.client_closed and not keyfile.exists()

def test_explicit_hybrid_gpu_configuration(setup, monkeypatch):
    _, manifest, state = setup
    manifest["quantization"] = "Q8_0"
    setup[0].write_text(json.dumps(manifest))
    monkeypatch.setenv("MEDGEMMA_GPU_LAYERS", "20")
    monkeypatch.setenv("MEDGEMMA_THREADS", "10")
    monkeypatch.setenv("MEDGEMMA_MM_PROJ_OFFLOAD", "true")
    monkeypatch.setenv("MEDGEMMA_KV_OFFLOAD", "false")
    monkeypatch.setenv("LD_LIBRARY_PATH", "/synthetic/cuda")
    runtime = local.LlamaCpp(SCHEMA)
    try:
        assert state.command[state.command.index("--n-gpu-layers") + 1] == "20"
        assert state.command[state.command.index("--threads") + 1] == "10"
        assert "--no-mmproj-offload" not in state.command
        assert "--no-kv-offload" in state.command
        assert state.child_env["LD_LIBRARY_PATH"] == "/synthetic/cuda"
        assert runtime.runtime["quantization"] == "Q8_0"
    finally:
        runtime.close()

@pytest.mark.parametrize("change", ["tampered_file", "wrong_model", "unknown_quantization", "invalid_revision"])
def test_invalid_manifest_never_launches(setup, change):
    path, manifest, state = setup
    if change == "tampered_file": (path.parent / manifest["modelFile"]).write_bytes(b"tampered")
    if change == "wrong_model": manifest["sourceModel"] = "other/model"
    if change == "unknown_quantization": manifest["quantization"] = "unknown"
    if change == "invalid_revision": manifest["sourceRevision"] = "main"
    path.write_text(json.dumps(manifest))
    with pytest.raises(RuntimeError, match="Local MedGemma startup failed"):
        local.LlamaCpp(SCHEMA)
    assert state.command is None

def test_wrong_binary_revision_never_launches(setup, monkeypatch):
    _, _, state = setup
    monkeypatch.setattr(local.subprocess, "run", lambda *a, **k: SimpleNamespace(stdout="version (commit ddddddd)", stderr=""))
    with pytest.raises(RuntimeError): local.LlamaCpp(SCHEMA)
    assert state.command is None

def test_bad_startup_response_cleans_up_child(setup, monkeypatch):
    _, _, state = setup
    monkeypatch.setattr(local.httpx.Client, "get", lambda *a, **k: httpx.Response(200, json={"data": [{"id": "wrong-model"}]}))
    with pytest.raises(RuntimeError): local.LlamaCpp(SCHEMA)
    assert state.terminated and state.client_closed
    assert not Path(state.command[state.command.index("--api-key-file") + 1]).exists()

def test_truncated_generation_rejected(setup):
    _, _, state = setup
    runtime = local.LlamaCpp(SCHEMA)
    try:
        state.finish = "length"
        with pytest.raises(ValueError, match="Incomplete"):
            runtime(Image.new("RGB", (16, 16)), "synthetic")
        assert runtime.last_diagnostics == {"finishReason": "length", "promptTokens": 7, "completionTokens": 3}
    finally: runtime.close()

def test_unknown_backend_fails_without_fallback(monkeypatch):
    monkeypatch.setenv("MEDGEMMA_API_KEY", "synthetic-test-key-only")
    monkeypatch.setenv("MEDGEMMA_BACKEND", "unknown")
    with pytest.raises(RuntimeError, match="no fallback"):
        with TestClient(create_app()): pass
