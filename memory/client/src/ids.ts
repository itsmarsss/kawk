// Unique client-side identifiers. Every socket connection and every scheduled photo gets its own.
let counter = 0;
export function newId(prefix: string, nowMs: number = Date.now()): string {
  counter += 1;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${nowMs.toString(36)}_${counter.toString(36)}_${rand}`;
}
