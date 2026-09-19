"""Small cloud utilities; importing the hub never imports an ML runtime."""

import math
import re


def endpoint(model_id: str, api_key: str, *, websocket: bool = False) -> str:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", model_id or ""):
        raise ValueError("Set a valid BASETEN model ID before selecting the cloud backend")
    if not api_key or not api_key.strip():
        raise ValueError("Set BASETEN_API_KEY before selecting the cloud backend")
    scheme, suffix = ("wss", "websocket") if websocket else ("https", "predict")
    return f"{scheme}://model-{model_id}.api.baseten.co/environments/production/{suffix}"


def timings(value: object) -> dict[str, float]:
    if not isinstance(value, dict):
        return {}
    return {
        str(k): float(v)
        for k, v in value.items()
        if isinstance(v, (int, float)) and math.isfinite(v) and v >= 0
    }


def checked_box(
    box: object, wh: tuple[int, int], *, clip: bool = False
) -> tuple[float, float, float, float]:
    if not isinstance(box, (list, tuple)) or len(box) != 4:
        raise ValueError("Cloud response must contain four absolute xyxy coordinates")
    x0, y0, x1, y1 = (float(x) for x in box)
    if not all(math.isfinite(v) for v in (x0, y0, x1, y1)):
        raise ValueError("Nonfinite cloud bounding box")
    if x1 < x0 or y1 < y0:
        raise ValueError("Unordered cloud bounding box")
    if clip:
        x0, x1 = max(0.0, min(wh[0], x0)), max(0.0, min(wh[0], x1))
        y0, y1 = max(0.0, min(wh[1], y0)), max(0.0, min(wh[1], y1))
    if not (0 <= x0 <= x1 <= wh[0] and 0 <= y0 <= y1 <= wh[1]):
        raise ValueError("Cloud box is outside the SENT image dimensions")
    return x0, y0, x1, y1
