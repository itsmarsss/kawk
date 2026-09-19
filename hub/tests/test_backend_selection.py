import os
import subprocess
import sys
from pathlib import Path

import pytest
from pydantic import ValidationError
from remember_hub.backends import create_face, create_jev, create_sam, create_stt
from remember_hub.config import BackendSettings, load_settings


def test_core_import_does_not_load_ml():
    code = """
import sys
from remember_hub.config import BackendSettings
from remember_hub.backends import create_face, create_jev, create_sam, create_stt
s=BackendSettings()
for factory in (create_face, create_jev, create_sam, create_stt): factory(s)
assert not {'torch','cv2','onnxruntime','ultralytics','insightface','faster_whisper','httpx'} & set(sys.modules)
"""
    env = dict(os.environ)
    env["PYTHONPATH"] = str(Path(__file__).parents[1])
    subprocess.run([sys.executable, "-c", code], env=env, check=True, timeout=10)


def test_config_paths_resolve_from_config_file(tmp_path):
    path = tmp_path / "remember.toml"
    path.write_text('[face]\nbackend="local"\nmodel_root="assets/models"\n')
    settings = load_settings(path)
    assert settings.face.model_root == str(tmp_path / "assets/models")
    with pytest.raises(ValidationError):
        BackendSettings.model_validate({"stt": {"sample_rate": 48000}})
    with pytest.raises(ValidationError):
        BackendSettings.model_validate({"face": {"model": "buffalo_s"}})


@pytest.mark.parametrize("section,factory,key", [
    ("sam", create_sam, "BASETEN_API_KEY"), ("face", create_face, "BASETEN_API_KEY"),
    ("stt", create_stt, "BASETEN_API_KEY"), ("jev", create_jev, "TYPESAFE_API_KEY"),
])
def test_missing_cloud_key_fails_before_vendor_import(monkeypatch, section, factory, key):
    monkeypatch.delenv(key, raising=False)
    settings = BackendSettings.model_validate({section: {"backend": "typesafe" if section == "jev" else "baseten"}})
    with pytest.raises(RuntimeError, match=key):
        factory(settings)


async def test_empty_fixture_backends_satisfy_contracts():
    settings = BackendSettings()
    sam = create_sam(settings)
    await sam.start_session(["person"])
    assert await sam.push_frame("1", b"synthetic", (640, 480)) == []
    await sam.add_concept("keys")
    await sam.end_session()
    assert await create_face(settings).embed_faces(b"synthetic", (640, 480)) == []
    assert await create_jev(settings).decide("synthetic", []) == []

    async def chunks():
        yield bytes(1024)
    assert [row async for row in create_stt(settings).stream(chunks())] == []
