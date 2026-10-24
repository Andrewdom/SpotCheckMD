"""Convert the gated official safetensors to an explicitly versioned local experiment.

Run with the isolated converter Python environment described in docs/medgemma.md.
Never pass access tokens as arguments. Hugging Face uses its local token cache.
"""
import argparse
import hashlib
from importlib.metadata import distributions
import json
from pathlib import Path
import re
import subprocess
import sys

from huggingface_hub import HfApi, snapshot_download

MODEL_ID = "google/medgemma-1.5-4b-it"
SOURCE_REVISION = "91850547d9f0b2fdd21aa7c5f4f3d1a8a52c243b"
CONVERTER_REVISION = "4762ad7316dcdec20016ab5985fb46a27902204d"  # llama.cpp b6000
RUNTIME_REVISION = "edc353842c1be9b4ebc27460a1da4526a026d3a9"

def digest(path):
    with Path(path).open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()

def prepare(converter, binary, output):
    converter, binary, output = converter.resolve(), binary.resolve(strict=True), output.resolve()
    revision = subprocess.check_output(["git", "-C", str(converter), "rev-parse", "HEAD"], text=True).strip()
    if revision != CONVERTER_REVISION:
        raise ValueError("Unexpected converter revision")
    if subprocess.check_output(["git", "-C", str(converter), "status", "--porcelain"], text=True).strip():
        raise ValueError("Converter checkout must be clean")
    version = subprocess.run([str(binary), "--version"], capture_output=True, text=True, check=True, timeout=20)
    match = re.search(r"commit ([0-9a-f]{7,40})\)", version.stdout + version.stderr)
    if not match or not RUNTIME_REVISION.startswith(match.group(1)):
        raise ValueError("Unexpected runtime revision")
    info = HfApi().model_info(MODEL_ID, revision=SOURCE_REVISION, files_metadata=True)
    snapshot = Path(snapshot_download(MODEL_ID, revision=SOURCE_REVISION,
                    allow_patterns=["*.json", "*.safetensors", "*.model", "*.jinja", "README.md", "LICENSE*"], max_workers=2))
    source_hashes = {}
    for file in info.siblings:
        if file.rfilename.endswith(".safetensors"):
            actual = digest(snapshot / file.rfilename)
            if not file.lfs or actual != file.lfs.sha256:
                raise ValueError("Official weight integrity check failed")
            source_hashes[file.rfilename] = actual
    if not source_hashes:
        raise ValueError("No official safetensors found")
    output.mkdir(mode=0o700, parents=True, exist_ok=False)
    intermediate, projector, quantized = output / "model-F16.gguf", output / "mmproj-F16.gguf", output / "model-Q4_K_M.gguf"
    logpath = output / "conversion.log"
    logpath.touch(mode=0o600)
    with logpath.open("w") as log:
        for arguments in [
            [sys.executable, str(converter / "convert_hf_to_gguf.py"), str(snapshot), "--outfile", str(intermediate), "--outtype", "f16"],
            [sys.executable, str(converter / "convert_hf_to_gguf.py"), str(snapshot), "--mmproj", "--outfile", str(projector), "--outtype", "f16"],
            [str(binary.parent / "llama-quantize"), str(intermediate), str(quantized), "Q4_K_M", "4"],
        ]:
            print("Running", Path(arguments[0]).name, "(conversion log in output directory)", flush=True)
            subprocess.run(arguments, stdout=log, stderr=log, check=True, cwd=converter)
    manifest = {"version": 1, "sourceModel": MODEL_ID, "sourceRevision": SOURCE_REVISION,
                "converterRevision": CONVERTER_REVISION, "runtimeRevision": RUNTIME_REVISION,
                "quantization": "Q4_K_M", "modelFile": quantized.name, "projectorFile": projector.name,
                "modelSha256": digest(quantized), "projectorSha256": digest(projector)}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    (output / "source-integrity.json").write_text(json.dumps(source_hashes, indent=2) + "\n")
    (output / "converter-packages.txt").write_text("\n".join(sorted(f"{d.metadata['Name']}=={d.version}" for d in distributions())) + "\n")
    print("Prepared", output / "manifest.json", flush=True)

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--converter", required=True, type=Path)
    parser.add_argument("--llama-server", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path, help="New private directory outside the repository")
    args = parser.parse_args()
    try:
        prepare(args.converter, args.llama_server, args.output)
    except Exception:
        print("Preparation failed. Check model access, pinned tool versions, free memory/disk and conversion.log if created. No model fallback was used.", file=sys.stderr)
        sys.exit(1)
