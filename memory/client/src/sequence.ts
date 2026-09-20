// One strictly increasing capture sequence per Run, shared by the anchored 5 s ticks, agent interrupt
// photos and the Stop snapshot. Numbers are allocated at draw time, so sequence order equals capture
// order and two photos can never carry the same number. The ticker's own tick index is unaffected.
export class SequenceAllocator {
  private last = -1;
  next(): number { this.last += 1; return this.last; }
  /** Last allocated number, or -1 when nothing has been captured. */
  get current(): number { return this.last; }
  get allocated(): number { return this.last + 1; }
}
