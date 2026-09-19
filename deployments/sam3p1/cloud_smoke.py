"""Real WS frames arriving sequentially; finite fixtures, not webcam/WAN latency."""
import argparse
import asyncio
import io
import json
import statistics
from pathlib import Path
from time import perf_counter


async def run(args):
    import uvicorn
    import websockets
    from fastapi import FastAPI, WebSocket
    from model.server import WindowSocketServer
    from model.windowed import WindowedSamEngine
    from PIL import Image, ImageDraw

    engine = WindowedSamEngine(args.checkpoint)
    handler = WindowSocketServer(engine)
    app = FastAPI()

    @app.websocket("/ws")
    async def endpoint(websocket: WebSocket):
        # Only this standalone wrapper accepts; Model.websocket does not.
        await websocket.accept()
        await handler.serve(websocket)

    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=8085,
                                         log_level="warning", ws_max_queue=1,
                                         ws_max_size=8 * 1024 * 1024, ws_per_message_deflate=False))
    task = asyncio.create_task(server.serve())
    while not server.started:
        if task.done():
            await task
            raise RuntimeError("WS server failed to start")
        await asyncio.sleep(0.05)
    paths = sorted(args.frames.glob("*.jpg"), key=lambda p: int(p.stem))
    args.output.mkdir(parents=True, exist_ok=True)
    result = {"scope": "new sequential fixture JPEGs over real worker-loopback WS; no future frames supplied; not webcam or Mac/WAN latency",
              "model": engine.load_report, "cases": []}
    (args.output / "results.json").write_text(json.dumps(result, indent=2))
    try:
        for window, vocabulary, indices in [(1, ["person"], [0, 16, 32, 48]),
                                              (1, ["person", "car", "bicycle"], [0, 24, 48]),
                                              (4, ["person"], [0, 16, 32, 48])]:
            handler.window_size = window
            case = {"window_size": window, "vocabulary": vocabulary, "frames": []}
            result["cases"].append(case)
            async with websockets.connect("ws://127.0.0.1:8085/ws", compression=None,
                                           max_queue=1, open_timeout=10) as ws:
                await ws.send(json.dumps({"type": "start_session", "vocabulary": vocabulary}))
                ready = json.loads(await ws.recv())
                assert ready["tracking_persistent"] is False and ready["type"] == "ready"
                for generation, index in enumerate(indices, 1):
                    # Read/encode this JPEG only AFTER the preceding response.
                    # Server never gets this path, remaining indices, or clip.
                    image = Image.open(paths[index]).convert("RGB")
                    image.thumbnail((960, 540))
                    buffer = io.BytesIO()
                    image.save(buffer, format="JPEG", quality=90)
                    wh = list(image.size)
                    frame_id = f"w{window}-c{len(vocabulary)}-{index}"
                    start = perf_counter()
                    await ws.send(json.dumps({"type": "frame", "frame_id": frame_id, "wh": wh}))
                    await ws.send(buffer.getvalue())
                    reply = json.loads(await asyncio.wait_for(ws.recv(), timeout=150))
                    elapsed = (perf_counter() - start) * 1000
                    if reply.get("type") != "frame":
                        raise RuntimeError(f"Model protocol error: {reply.get('message')}")
                    assert reply["frame_id"] == frame_id and reply["wh"] == wh
                    assert reply["tracker_generation"] == generation
                    assert reply["window_frames"] == min(window, generation)
                    assert reply["memory"]["active_sessions"] == 0
                    reply["client_roundtrip_ms"] = elapsed
                    reply["jpeg_bytes"] = len(buffer.getvalue())
                    case["frames"].append(reply)
                    for obj in reply["objects"]:
                        ImageDraw.Draw(image).rectangle(obj["box_xyxy"], outline="lime", width=3)
                        ImageDraw.Draw(image).text(tuple(obj["box_xyxy"][:2]), obj["label"], fill="yellow")
                    image.save(args.output / f"{frame_id}.jpg", quality=90)
                    (args.output / "results.json").write_text(json.dumps(result, indent=2))
                    print("SAM31_ARRIVED_FRAME " + json.dumps({"frame_id": frame_id,
                          "client_roundtrip_ms": elapsed, "objects": len(reply["objects"]),
                          "timings_ms": reply["timings_ms"], "memory": reply["memory"]}), flush=True)
                await ws.send(json.dumps({"type": "end_session"}))
            values = [row["client_roundtrip_ms"] for row in case["frames"]]
            case["roundtrip_median_ms"] = statistics.median(values)
            case["roundtrip_max_ms"] = max(values)
            if not any(row["objects"] for row in case["frames"]):
                raise RuntimeError("No detections in supplied person fixture")
            (args.output / "results.json").write_text(json.dumps(result, indent=2))
        result["complete"] = True
        result["final_memory"] = engine.memory()
        (args.output / "results.json").write_text(json.dumps(result, indent=2))
        print("SAM31_ARRIVING_SMOKE_COMPLETE " + json.dumps({"complete": True,
              "cases": [{k: v for k, v in case.items() if k != "frames"} for case in result["cases"]],
              "final_memory": result["final_memory"]}), flush=True)
    finally:
        server.should_exit = True
        await task


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--frames", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    asyncio.run(run(parser.parse_args()))
