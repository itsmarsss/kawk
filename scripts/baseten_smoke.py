"""Explicit smoke-test credential resolution. Never print or serialize the key."""

import json
import os
from pathlib import Path


def api_key(native_profile: bool = False) -> str:
    value = os.environ.get("BASETEN_API_KEY")
    if value:
        return value
    if native_profile:
        path = Path.home() / "Library/Application Support/baseten/auth.json"
        try:
            value = json.loads(path.read_text())["profiles"]["h100-permanent"]["api_key"]
            if value:
                return value
        except (OSError, ValueError, KeyError):
            pass
    raise RuntimeError("Set BASETEN_API_KEY or explicitly select --native-profile (h100-permanent)")
