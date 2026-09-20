"""PWA server: serves devices/pwa/* and the notify APIs on one port.

Same zero-dependency asyncio HTTP style as dashboard.py (core-deps rule,
AGENTS.md §11). TLS is config-driven (mkcert cert) because iOS requires a
secure context for service workers + Web Push — see devices/pwa/README.md.

Endpoints:
  GET  /…                    static PWA files (index.html, sw.js, manifest, icons)
  GET  /api/vapid-key        {"key": <applicationServerKey>} (503 until keys exist)
  POST /api/subscribe        body = PushSubscription.toJSON() from the browser
  POST /api/unsubscribe      body = {"endpoint": …}
  GET  /api/events           SSE: current card replay + live card stream
  GET  /api/status           sink/subscription/history stats
  POST /api/test             publish a test card on the bus (phone-in-hand check)
"""

from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
from pathlib import Path
from urllib.parse import urlparse

from ..branding import PRODUCT_NAME
from ..bus import EventBus
from ..config import PwaCfg
from ..contracts.display import PRIO_ANSWER, Card, CardTemplate, DisplayAction
from .base import NotifyEvent
from .service import NotifyService
from .webpush_sink import PushSubscription, SubscriptionStore

log = logging.getLogger(__name__)

_MAX_BODY = 64 * 1024
_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",  # wrong type breaks SW registration
    ".css": "text/css; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".json": "application/json",
    ".png": "image/png",
    ".svg": "image/svg+xml",
}


def vapid_public_key_b64(private_pem: Path) -> str | None:
    """applicationServerKey: URL-safe unpadded b64 of the uncompressed P-256 point.
    Needs `cryptography` (ships with the [pwa] extra); None until keys exist."""
    if not private_pem.exists():
        return None
    try:
        from base64 import urlsafe_b64encode

        from cryptography.hazmat.primitives import serialization

        key = serialization.load_pem_private_key(private_pem.read_bytes(), password=None)
        point = key.public_key().public_bytes(
            serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
        )
        return urlsafe_b64encode(point).rstrip(b"=").decode()
    except ImportError:
        log.warning("cryptography not installed — web push disabled (uv sync --extra pwa)")
        return None
    except Exception:
        log.exception("could not derive VAPID public key from %s", private_pem)
        return None


class PwaServer:
    def __init__(
        self,
        bus: EventBus,
        service: NotifyService,
        store: SubscriptionStore,
        cfg: PwaCfg,
        vapid_private_key: Path,
        static_dir: Path | None = None,
    ) -> None:
        self.bus = bus
        self.service = service
        self.store = store
        self.cfg = cfg
        self.vapid_private_key = vapid_private_key
        repo_root = Path(__file__).resolve().parents[3]
        self.static_dir = (static_dir or repo_root / "devices" / "pwa").resolve()
        self._server: asyncio.Server | None = None
        self._vapid_pub: str | None = None
        self._closing = asyncio.Event()  # unblocks SSE loops so stop() never waits them out

    # ---- lifecycle -----------------------------------------------------------------

    async def start(self, port: int | None = None) -> int:
        self._vapid_pub = vapid_public_key_b64(self.vapid_private_key)
        ctx = self._ssl_context()
        self._server = await asyncio.start_server(
            self._handle, self.cfg.host, self.cfg.port if port is None else port, ssl=ctx
        )
        actual = self._server.sockets[0].getsockname()[1]
        scheme = "https" if ctx else "http"
        log.info(
            "pwa on %s://%s:%s (webpush %s, %d subscription(s))",
            scheme,
            self.cfg.host,
            actual,
            "ready" if self._vapid_pub else "OFF — run scripts/gen_vapid.py + --extra pwa",
            len(self.store),
        )
        return actual

    async def stop(self) -> None:
        self._closing.set()  # let open SSE streams exit before wait_closed() (py3.12) blocks on them
        if self._server:
            self._server.close()
            await self._server.wait_closed()

    def _ssl_context(self) -> ssl.SSLContext | None:
        cert, key = Path(self.cfg.certfile), Path(self.cfg.keyfile)
        if not (self.cfg.certfile and cert.exists() and key.exists()):
            if self.cfg.certfile:
                log.warning("pwa TLS cert %s missing — serving plain HTTP (iOS needs TLS)", cert)
            return None
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert, key)
        return ctx

    # ---- http ------------------------------------------------------------------------

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            line, _, rest = head.partition(b"\r\n")
            method, target = line.split(b" ", 2)[0].decode(), line.split(b" ", 2)[1].decode()
            headers = _parse_headers(rest)
            path = urlparse(target).path
            body = b""
            length = int(headers.get("content-length", "0") or 0)
            if length:
                if length > _MAX_BODY:
                    self._respond(writer, "413 Payload Too Large", "text/plain", b"too large")
                    return
                body = await asyncio.wait_for(reader.readexactly(length), timeout=10)

            if path.startswith("/api/"):
                await self._api(writer, method, path, body, headers)
            elif method == "GET":
                self._static(writer, path)
            else:
                self._respond(writer, "405 Method Not Allowed", "text/plain", b"nope")
            await writer.drain()
        except (TimeoutError, asyncio.IncompleteReadError, ConnectionResetError, BrokenPipeError):
            pass
        except Exception:
            log.exception("pwa request failed")
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass

    async def _api(
        self,
        writer: asyncio.StreamWriter,
        method: str,
        path: str,
        body: bytes,
        headers: dict[str, str],
    ) -> None:
        if path == "/api/vapid-key" and method == "GET":
            if self._vapid_pub is None:
                self._vapid_pub = vapid_public_key_b64(self.vapid_private_key)  # keys may be new
            if self._vapid_pub:
                self._json(writer, {"key": self._vapid_pub})
            else:
                self._respond(
                    writer,
                    "503 Service Unavailable",
                    "application/json",
                    b'{"error":"web push not configured; run scripts/gen_vapid.py"}',
                )
        elif path == "/api/subscribe" and method == "POST":
            sub = PushSubscription.model_validate_json(body)
            sub.ua = headers.get("user-agent", "")[:120]
            self.store.add(sub)
            log.info("push subscription added (%d total)", len(self.store))
            self._json(writer, {"ok": True, "subscriptions": len(self.store)}, "201 Created")
        elif path == "/api/unsubscribe" and method == "POST":
            endpoint = json.loads(body or b"{}").get("endpoint", "")
            self._json(writer, {"ok": self.store.remove(endpoint)})
        elif path == "/api/status" and method == "GET":
            self._json(
                writer,
                {
                    "product": PRODUCT_NAME,
                    "webpush": self._vapid_pub is not None,
                    "subscriptions": len(self.store),
                    **self.service.stats(),
                },
            )
        elif path == "/api/test" and method == "POST":
            await self.bus.publish(
                "display.current",
                DisplayAction(
                    card=Card(
                        template=CardTemplate.ALERT,
                        title="Test notification",
                        body="If you can read this on your phone, the pipe works.",
                    ),
                    ttl_ms=8000,
                    priority=PRIO_ANSWER,
                    t_created=time.time(),
                ),
            )
            self._json(writer, {"ok": True})
        elif path == "/api/events" and method == "GET":
            await self._sse(writer)
        else:
            self._respond(writer, "404 Not Found", "text/plain", b"not found")

    async def _sse(self, writer: asyncio.StreamWriter) -> None:
        """Live card feed for the in-app view; bounded queue per §3.1."""
        writer.write(
            b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n"
            b"Cache-Control: no-store\r\nConnection: close\r\n\r\nretry: 2000\r\n\r\n"
        )
        q = self.service.listen()
        closing = asyncio.ensure_future(self._closing.wait())
        try:
            if self.service.current:
                writer.write(_sse_frame(self.service.current))
            await writer.drain()
            while not self._closing.is_set():
                get = asyncio.ensure_future(q.get())
                done, _ = await asyncio.wait(
                    {get, closing}, timeout=20, return_when=asyncio.FIRST_COMPLETED
                )
                if closing in done:
                    get.cancel()
                    break
                if get in done:
                    writer.write(_sse_frame(get.result()))
                else:  # 20s idle -> keepalive comment (also surfaces client disconnect on drain)
                    get.cancel()
                    writer.write(b": keepalive\r\n\r\n")
                await writer.drain()
        finally:
            closing.cancel()
            self.service.unlisten(q)

    def _static(self, writer: asyncio.StreamWriter, path: str) -> None:
        rel = "index.html" if path in ("", "/") else path.lstrip("/")
        file = (self.static_dir / rel).resolve()
        if not (file.is_relative_to(self.static_dir) and file.is_file()):
            self._respond(writer, "404 Not Found", "text/plain", b"not found")
            return
        ctype = _TYPES.get(file.suffix, "application/octet-stream")
        self._respond(writer, "200 OK", ctype, file.read_bytes())

    def _json(self, writer: asyncio.StreamWriter, obj: dict, status: str = "200 OK") -> None:
        self._respond(writer, status, "application/json", json.dumps(obj).encode())

    def _respond(self, writer: asyncio.StreamWriter, status: str, ctype: str, body: bytes) -> None:
        writer.write(
            f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\nCache-Control: no-store\r\n"
            f"Connection: close\r\n\r\n".encode()
            + body
        )


def _sse_frame(event: NotifyEvent) -> bytes:
    return f"data: {event.model_dump_json()}\r\n\r\n".encode()


def _parse_headers(raw: bytes) -> dict[str, str]:
    headers: dict[str, str] = {}
    for line in raw.split(b"\r\n"):
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.decode("latin-1").strip().lower()] = v.decode("latin-1").strip()
    return headers
