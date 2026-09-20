// Box overlay geometry. The face derivative is the full camera frame scaled uniformly (same aspect),
// so a box in derivative pixels maps to the displayed video by one uniform scale plus the letterbox
// offset of `object-fit: contain`. No mirroring anywhere: the preview is not flipped.
export interface Rect { x: number; y: number; w: number; h: number }

/** Where the video content sits inside its element under object-fit: contain. */
export function contentRect(videoW: number, videoH: number, elemW: number, elemH: number): Rect {
  if (videoW <= 0 || videoH <= 0 || elemW <= 0 || elemH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const scale = Math.min(elemW / videoW, elemH / videoH);
  const w = videoW * scale, h = videoH * scale;
  return { x: (elemW - w) / 2, y: (elemH - h) / 2, w, h };
}

/** Derivative-space box → element-space rect. */
export function mapBox(box: readonly [number, number, number, number], inputW: number, inputH: number, content: Rect): Rect {
  if (inputW <= 0 || inputH <= 0) return { x: 0, y: 0, w: 0, h: 0 };
  const sx = content.w / inputW, sy = content.h / inputH;
  return { x: content.x + box[0] * sx, y: content.y + box[1] * sy, w: (box[2] - box[0]) * sx, h: (box[3] - box[1]) * sy };
}

/** Uniform downscale so the long side is at most maxSide; never upscales. Integer output. */
export function fitDimensions(w: number, h: number, maxSide: number): { width: number; height: number } {
  const scale = Math.min(1, maxSide / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
