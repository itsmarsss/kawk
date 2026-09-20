"""Run: python -m tools.perception_lab.server (binds 0.0.0.0:8081)."""
from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import os
import re
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

os.environ.setdefault("NO_ALBUMENTATIONS_UPDATE", "1")
os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from remember_hub.perception.face.baseten_http import FaceRequestTimeout

from .backends import cloud_face_backend, configured_backends, jpeg_dimensions, selection
from .experiments import local_speech_socket, objects_socket
from .faces import MODEL, FaceEngine, FaceSession, Gallery
from .introductions import IntroductionController
from .product_decisions import MODEL as JEV_MODEL
from .product_decisions import backend_from_environment
from .product_memory import NoteMemory, memory_path_for_gallery
from .product_routes import ProductSessions
from .speech import MODEL_ID, cloud_speech_socket, read_key

HERE = Path(__file__).parent
STATIC = HERE / "static"
STATIC.mkdir(exist_ok=True)
MODEL_ROOT = Path(os.getenv("REMEMBER_FACE_MODEL_ROOT", "data"))
PROVIDER = os.getenv("REMEMBER_FACE_PROVIDER", "CoreMLExecutionProvider")
GALLERY_PATH = Path(os.getenv("REMEMBER_GALLERY_PATH", str(HERE / "data" / "gallery.npz")))
MAX_SESSION_S = 600


@contextlib.asynccontextmanager
async def lifespan(_app):
    # Open only at startup, using the selected gallery's sibling by default.
    # An unavailable store must fail startup rather than silently lose notes.
    product_sessions.note_memory = NoteMemory(memory_path_for_gallery(
        gallery.path, os.getenv("REMEMBER_MEMORY_PATH")))
    async def preload():
        with contextlib.suppress(Exception):
            await ensure_engine()  # Failure is exposed in /api/status; speech remains usable.
    task = asyncio.create_task(preload())
    cleanup = asyncio.create_task(product_sessions.cleanup_loop())
    try:
        yield
    finally:
        cleanup.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await cleanup
        await product_sessions.close()
        await task


app = FastAPI(title="Perception test services", docs_url=None, redoc_url=None, lifespan=lifespan)
gallery = Gallery(GALLERY_PATH)
engine = None
engine_error = None
engine_lock = asyncio.Lock()
cloud_face_lock = asyncio.Lock()
introduction_controllers = set()


def same_origin(headers):
    # Non-browser fixture clients omit Origin. Browser capture only on this site.
    origin = headers.get("origin")
    return not origin or urlsplit(origin).netloc == headers.get("host")


product_sessions = ProductSessions(gallery, same_origin, decision_factory=backend_from_environment)


def decision_configuration():
    mode = os.getenv("REMEMBER_V1_DECISIONS", "rules").strip().lower()
    configured = mode == "rules" or (mode == "typesafe" and bool(os.getenv("TYPESAFE_API_KEY", "").strip()))
    return {"backend": mode, "configured": configured,
            "model": JEV_MODEL if mode == "typesafe" else None,
            "message": ("V1 command and object rules; Jev is not connected" if mode == "rules" else
                        "Jev configured; live connection checked on capture" if configured else
                        "Set REMEMBER_V1_DECISIONS=typesafe and a server-side TYPESAFE_API_KEY, then restart")}


@app.middleware("http")
async def origin_guard(request: Request, call_next):
    if request.method not in ("GET", "HEAD", "OPTIONS") and not same_origin(request.headers):
        return JSONResponse({"detail": "Use this server's page"}, status_code=403)
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    script_hashes = []
    if request.url.path in ("/", "/lab", "/faces", "/speech", "/devices", "/objects"):
        filename = "index.html" if request.url.path == "/" else request.url.path[1:] + ".html"
        path = STATIC / filename
        if path.exists():
            for source in re.findall(r"<script\b[^>]*>(.*?)</script>", path.read_text(), re.S):
                if source.strip():
                    digest = base64.b64encode(hashlib.sha256(source.encode()).digest()).decode()
                    script_hashes.append(f"'sha256-{digest}'")
    response.headers["Content-Security-Policy"] = "default-src 'self'; script-src 'self' " + " ".join(script_hashes) + "; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self'; frame-ancestors 'none'"
    return response


def lan_addresses():
    # Prefer the physical LAN over a corporate VPN's default route.
    try:
        output = subprocess.check_output(["/sbin/ifconfig"], text=True, timeout=2)
        addresses, interface = [], ""
        for line in output.splitlines():
            if line and not line[0].isspace():
                interface = line.split(":", 1)[0]
            elif line.strip().startswith("inet ") and interface.startswith(("en", "bridge")):
                addresses.append(line.split()[1])
        if addresses:
            return addresses
    except (OSError, subprocess.SubprocessError):
        pass
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_DGRAM)) as sock:
        try:
            sock.connect(("8.8.8.8", 80))  # Route lookup only; no packet is sent.
            return [sock.getsockname()[0]]
        except OSError:
            return []


@app.get("/api/status")
async def status():
    try:
        configured = bool(read_key())
    except RuntimeError:
        configured = False
    return {"face": {"model": MODEL, "provider": PROVIDER, "ready": engine is not None,
                     "load_ms": engine.load_ms if engine else None, "error": engine_error},
            "speech": {"model_id": MODEL_ID, "configured": configured, "sample_rate": 16000,
                       "chunk_samples": 512, "max_session_s": MAX_SESSION_S},
            "backends": configured_backends(engine is not None, engine_error),
            "decisions": decision_configuration(),
            "gallery_count": len(gallery.entries), "https_port": 8443,
            "https_available": bool(os.getenv("REMEMBER_HTTPS_ENABLED")),
            "lan_addresses": lan_addresses(), "ui_ready": (STATIC / "index.html").exists()}


@app.get("/api/gallery")
async def get_gallery():
    return {"people": gallery.list(), "model": MODEL}


@app.delete("/api/gallery/{person_id}")
async def delete_person(person_id: str):
    deleted = product_sessions.delete_person(person_id)
    for controller in introduction_controllers:
        controller.invalidate()
    if not deleted:
        raise HTTPException(404, "No such enrollment")
    return {"deleted": True}


@app.delete("/api/gallery")
async def reset_gallery():
    # Explicit reset also cancels introductions that have not yet saved a person.
    for controller in introduction_controllers:
        controller.invalidate()
    people = gallery.list()
    for person in people:
        product_sessions.delete_person(person['id'])
    return {"deleted": True, "count": len(people)}


async def ensure_engine():
    global engine, engine_error
    async with engine_lock:
        if engine is None:
            try:
                engine = await native_call(FaceEngine, MODEL_ROOT, PROVIDER)
                engine_error = None
            except Exception as error:
                engine_error = str(error)
                raise


async def native_call(function, *args):
    """Keep the lock until uncancellable native work has really finished."""
    task = asyncio.create_task(asyncio.to_thread(function, *args))
    try:
        return await asyncio.shield(task)
    except asyncio.CancelledError:
        with contextlib.suppress(Exception):
            await task
        raise


async def ws_error(ws, message):
    with contextlib.suppress(Exception):
        await ws.send_json({"type": "error", "message": message})


@app.websocket("/ws/faces")
async def faces_socket(ws: WebSocket):
    if not same_origin(ws.headers):
        await ws.close(code=1008)
        return
    await ws.accept()
    session = FaceSession(gallery)
    try:
        decision_backend = backend_from_environment()
    except ValueError:
        decision_backend = None  # Recognition remains usable; naming reports unavailable.
    introduction = IntroductionController(session, decision_backend, ws.send_json, product_sessions.rename_person)
    introduction_controllers.add(introduction)
    cloud_backend = None
    try:
        name = selection(ws.query_params.get("backend"), "local")
        if name == "local":
            await ensure_engine()
        else:
            cloud_backend = cloud_face_backend()
        lock = engine_lock if name == "local" else cloud_face_lock
        await ws.send_json({"type": "ready", "model": MODEL, "backend": name,
                            "provider": PROVIDER if name == "local" else "Baseten",
                            "load_ms": engine.load_ms if name == "local" else None,
                            "max_fps": 5, "max_side": 640})
        last_frame = 0
        frame_id = 0
        skipped_frames = 0
        consecutive_timeouts = 0
        session_started = time.perf_counter()
        while True:
            if time.perf_counter() - session_started > MAX_SESSION_S:
                raise RuntimeError("Ten-minute face test finished. Start again to continue.")
            message = await asyncio.wait_for(ws.receive(), timeout=60)
            if message["type"] == "websocket.disconnect":
                break
            if message.get("text") is not None:
                try:
                    control = json.loads(message["text"])
                    if not isinstance(control, dict):
                        raise ValueError("Expected an object")
                    if control.get("type") == "enroll":
                        session.begin_enrollment(control.get("name", ""),
                                                 target_track_id=control.get("target_track_id"))
                        await ws.send_json({"type": "enrollment_started", "name": session.enrolling["name"],
                                            "target_track_id": session.enrolling.get("target_track_id")})
                    elif control.get("type") == "cancel_enrollment":
                        session.enrolling = None
                        await ws.send_json({"type": "enrollment_cancelled"})
                    elif control.get("type") == "introduction":
                        await introduction.receive(control)
                    else:
                        raise ValueError("Unknown camera control")
                except (ValueError, TypeError) as error:
                    await ws_error(ws, str(error))
                continue
            jpeg = message.get("bytes")
            if not jpeg or len(jpeg) > 500_000:
                await ws_error(ws, "Send one JPEG of at most 500 KB")
                continue
            if lock.locked() or time.perf_counter() - last_frame < 0.19:
                await ws.send_json({"type": "busy"})
                continue
            started = time.perf_counter()
            last_frame = started
            async with lock:
                try:
                    if name == "local":
                        result = await native_call(engine.infer, jpeg)
                    else:
                        import numpy as np
                        wh = await asyncio.to_thread(jpeg_dimensions, jpeg, 640)
                        observations = await cloud_backend.embed_faces(jpeg, wh)
                        cloud_timings = dict(getattr(cloud_backend, "last_timings_ms", {}))
                        cloud_timings.update(inference=cloud_timings.get("pipeline_total"),
                                             decode=cloud_timings.get("jpeg_decode"),
                                             detection=cloud_timings.get("detect_including_pre_post"))
                        if "embedding_total" in cloud_timings and "align_total" in cloud_timings:
                            cloud_timings["embedding_and_alignment"] = cloud_timings["embedding_total"] + cloud_timings["align_total"]
                        result = {"faces": [{"box": list(row.box), "detection_score": row.det_score,
                                              "embedding": np.asarray(row.embedding_512, dtype=np.float32)}
                                             for row in observations],
                                  "detected_count": getattr(cloud_backend, "last_detected_count", len(observations)), "input_wh": wh,
                                  "timings_ms": cloud_timings}
                    consecutive_timeouts = 0
                except FaceRequestTimeout:
                    consecutive_timeouts += 1
                    skipped_frames += 1
                    if consecutive_timeouts >= 3:
                        await ws_error(ws, "Cloud face timed out three times. It may be waking from zero; wait and Start again, or choose local.")
                        break
                    await ws.send_json({"type": "busy", "reason": "cloud_timeout", "skipped_frames": skipped_frames})
                    continue
                except ValueError as error:
                    await ws_error(ws, str(error))
                    continue
                processed = session.process(result)
                introduction.observe()
            frame_id += 1
            result["timings_ms"]["server_total"] = (time.perf_counter() - started) * 1000
            await ws.send_json({"type": "frame", "frame_id": frame_id, **processed,
                                "input_wh": result["input_wh"], "detected_count": result["detected_count"],
                                "accepted_count": len(processed["faces"]), "timings_ms": result["timings_ms"]})
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception as error:
        await ws_error(ws, engine_error if cloud_backend is None and engine_error else f"Camera test failed ({type(error).__name__}); check the server log")
        import traceback
        traceback.print_exc()
    finally:
        introduction_controllers.discard(introduction)
        await introduction.close()
        if cloud_backend is not None and hasattr(cloud_backend, "aclose"):
            with contextlib.suppress(Exception):
                await cloud_backend.aclose()
        with contextlib.suppress(Exception):
            await ws.close()


@app.websocket("/ws/speech")
async def speech_socket(ws: WebSocket):
    if not same_origin(ws.headers):
        await ws.close(code=1008)
        return
    await ws.accept()
    try:
        name = selection(ws.query_params.get("backend"), "baseten")
    except ValueError as error:
        await ws_error(ws, str(error))
        await ws.close()
        return
    if name == "local":
        await local_speech_socket(ws)
        return
    await cloud_speech_socket(ws, max_session_s=MAX_SESSION_S)


@app.websocket("/ws/objects")
async def object_socket(ws: WebSocket):
    if not same_origin(ws.headers):
        await ws.close(code=1008)
        return
    await ws.accept()
    await objects_socket(ws)


@app.get("/")
@app.get("/lab")
@app.get("/faces")
@app.get("/speech")
@app.get("/devices")
@app.get("/objects")
async def page(request: Request):
    filename = "index.html" if request.url.path == "/" else request.url.path[1:] + ".html"
    path = STATIC / filename
    if not path.is_file():
        return JSONResponse({"status": "Testing UI is being built; backend is ready"}, status_code=503)
    return FileResponse(path)


app.include_router(product_sessions.router)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8081")),
                ws_max_size=500_000, ws_max_queue=1, ws_per_message_deflate=False,
                ssl_certfile=os.getenv("REMEMBER_TLS_CERT"), ssl_keyfile=os.getenv("REMEMBER_TLS_KEY"))
