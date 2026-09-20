"""Generate the VAPID keypair for Web Push into data/ (gitignored).

Run once per hub install:  uv run --extra pwa python scripts/gen_vapid.py
The PWA server derives the public applicationServerKey from the private PEM.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> None:
    try:
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric import ec
    except ImportError:
        sys.exit("cryptography missing — run: uv sync --extra pwa")

    data = Path(__file__).resolve().parents[1] / "data"
    data.mkdir(exist_ok=True)
    pem_path = data / "vapid_private.pem"
    if pem_path.exists():
        print(f"{pem_path} already exists — delete it first to rotate (breaks existing subs)")
        return
    key = ec.generate_private_key(ec.SECP256R1())
    pem_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )
    )
    pem_path.chmod(0o600)

    from remember_hub.notify.pwa_server import vapid_public_key_b64

    print(f"wrote {pem_path}")
    print(f"applicationServerKey: {vapid_public_key_b64(pem_path)}")


if __name__ == "__main__":
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hub"))
    main()
