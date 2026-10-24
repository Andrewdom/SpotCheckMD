"""Explicit experimental CPU runtime; owns an authenticated loopback llama.cpp process."""
import base64
import hashlib
from io import BytesIO
import json
import os
from pathlib import Path
import re
import secrets
import socket
import subprocess
import tempfile
import time

import httpx
from pydantic import BaseModel, ConfigDict, Field

MODEL_ID = "google/medgemma-1.5-4b-it"
SHA = r"^[0-9a-f]{40}$"
DIGEST = r"^[0-9a-f]{64}$"

class LocalManifest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version: int = Field(ge=1, le=1)
    sourceModel: str = Field(pattern=r"^google/medgemma-1\.5-4b-it$")
    sourceRevision: str = Field(pattern=SHA)
    converterRevision: str = Field(pattern=SHA)
    runtimeRevision: str = Field(pattern=SHA)
    quantization: str = Field(pattern=r"^Q4_K_M$")
    modelFile: str = Field(min_length=1)
    projectorFile: str = Field(min_length=1)
    modelSha256: str = Field(pattern=DIGEST)
    projectorSha256: str = Field(pattern=DIGEST)

def sha256_file(path: Path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()

def load_manifest(path: Path):
    manifest = LocalManifest.model_validate_json(path.read_text())
    model = (path.parent / manifest.modelFile).resolve()
    projector = (path.parent / manifest.projectorFile).resolve()
    if model == projector or sha256_file(model) != manifest.modelSha256 or sha256_file(projector) != manifest.projectorSha256:
        raise ValueError("Local model integrity check failed")
    return manifest, model, projector

class LlamaCpp:
    def __init__(self, schema):
        self.process = None
        self.client = None
        self.secrets_dir = None
        self.schema = schema
        self.last_diagnostics = {}
        try:
            self._start()
        except Exception:
            self.close()
            raise RuntimeError("Local MedGemma startup failed; check manifest, binary revision, files and available memory") from None

    def _start(self):
        manifest, model, projector = load_manifest(Path(os.environ["MEDGEMMA_GGUF_MANIFEST"]).resolve())
        binary = Path(os.environ["MEDGEMMA_LLAMA_BINARY"]).resolve(strict=True)
        version = subprocess.run([str(binary), "--version"], capture_output=True, text=True, timeout=20, check=True)
        match = re.search(r"commit ([0-9a-f]{7,40})\)", version.stdout + version.stderr)
        if not match or not manifest.runtimeRevision.startswith(match.group(1)):
            raise ValueError("Runtime revision mismatch")
        self.revision = manifest.sourceRevision
        self.runtime = {"engine": "llama.cpp", "engineRevision": manifest.runtimeRevision,
                        "converterRevision": manifest.converterRevision, "quantization": manifest.quantization,
                        "modelSha256": manifest.modelSha256, "projectorSha256": manifest.projectorSha256}
        self.alias = "spotcheckmd-" + manifest.modelSha256[:16] + "-" + manifest.projectorSha256[:16]
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        key = secrets.token_urlsafe(32)
        self.secrets_dir = tempfile.TemporaryDirectory(prefix="spotcheckmd-runtime-")
        keyfile = Path(self.secrets_dir.name) / "key"
        keyfile.touch(mode=0o600)
        keyfile.write_text(key)
        # Explicit CPU operation, one slot, bounded context, no prompt shifting or logs.
        command = [str(binary), "--model", str(model), "--mmproj", str(projector), "--alias", self.alias,
                   "--host", "127.0.0.1", "--port", str(port), "--api-key-file", str(keyfile),
                   "--n-gpu-layers", "0", "--no-mmproj-offload", "--threads", "4", "--threads-batch", "4",
                   "--ctx-size", "16384", "--parallel", "1", "--no-context-shift", "--predict", "3000",
                   "--no-webui", "--no-slots", "--log-disable"]
        child_env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "LC_ALL")}
        self.process = subprocess.Popen(command, env=child_env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.client = httpx.Client(base_url=f"http://127.0.0.1:{port}", headers={"Authorization": "Bearer " + key},
                                   timeout=570, follow_redirects=False, trust_env=False)
        deadline = time.monotonic() + 180
        while time.monotonic() < deadline:
            if self.process.poll() is not None:
                raise RuntimeError("Local runtime exited")
            try:
                response = self.client.get("/v1/models", timeout=2)
                if response.status_code == 200:
                    models = response.json()["data"]
                    if len(models) != 1 or models[0]["id"] != self.alias:
                        raise ValueError("Unexpected runtime model")
                    return
            except httpx.TransportError:
                pass
            time.sleep(0.5)
        raise TimeoutError("Local model startup timed out")

    def __call__(self, image, prompt):
        if self.process.poll() is not None:
            raise RuntimeError("Local runtime exited")
        self.last_diagnostics = {}
        encoded = BytesIO()
        image.save(encoded, format="PNG")
        response = self.client.post("/v1/chat/completions", json={
            "model": self.alias, "stream": False, "temperature": 0, "seed": 0,
            "max_tokens": 3000, "cache_prompt": False,
            "messages": [{"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": "data:image/png;base64," + base64.b64encode(encoded.getvalue()).decode()}},
                {"type": "text", "text": prompt}]}],
            "response_format": {"type": "json_schema", "schema": self.schema},
        })
        response.raise_for_status()
        if len(response.content) > 200000:
            raise ValueError("Oversized local response")
        body = response.json()
        result = body["choices"][0]
        # Counts and finish reason only; never generated text.
        usage = body.get("usage") or {}
        self.last_diagnostics = {"finishReason": str(result.get("finish_reason")), "promptTokens": usage.get("prompt_tokens"), "completionTokens": usage.get("completion_tokens")}
        if result["finish_reason"] != "stop":
            raise ValueError("Incomplete local generation")
        return result["message"]["content"]

    def close(self):
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        if self.client is not None:
            self.client.close()
        if self.secrets_dir is not None:
            self.secrets_dir.cleanup()
