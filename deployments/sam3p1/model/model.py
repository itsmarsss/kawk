import os
from pathlib import Path

from fastapi import WebSocket

from model.server import WindowSocketServer
from model.windowed import WindowedSamEngine


class Model:
    def __init__(self, data_dir, config, **kwargs):
        self.data_dir = Path(data_dir)

    def load(self):
        checkpoint = os.environ.get("SAM31_CHECKPOINT", str(self.data_dir / "sam3.1_multiplex.pt"))
        if not Path(checkpoint).is_file():
            from huggingface_hub import hf_hub_download

            checkpoint = hf_hub_download(
                "AEmotionStudio/sam3.1", "sam3.1_multiplex.pt",
                revision="694239a1479aab8fd1317c87c433c58acd7c6eab", local_files_only=True,
            )
        self.engine = WindowedSamEngine(checkpoint)
        self.server = WindowSocketServer(self.engine, int(os.environ.get("SAM31_WINDOW_SIZE", "1")))

    async def websocket(self, websocket: WebSocket):
        await self.server.serve(websocket)
