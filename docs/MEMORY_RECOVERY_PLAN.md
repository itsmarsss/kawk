# Bounded interpretation recovery

V5 abandoned five image requests after timeouts and three joined packets after
a model response assigned one identity to two distinct visible objects. Strict
validation must remain. Add one fresh interpretation attempt rather than guessing
an identity, rewriting rejected output, or discarding the saved input.

The interpreter adapter supports one or two attempts per logical operation,
with a bounded delay. Standalone calls default to one for explicit R&D accounting;
the live service selects two. Each attempt gets its own timing record and index.
Image bytes, native OCR, packet, speech revisions and context stay the same within
the operation. The pipeline's existing post-call revision/context check still
rejects stale results and requeues current evidence. Restart can repeat an
interrupted logical operation; this is not a lifetime billing-attempt ledger.

Retry transient transport/provider errors and response validation failures once.
Never retry integrity failures, tool use, model refusal, output-limit violations,
authentication failures or permanent HTTP errors. A rejected response supplies only
its host-controlled error code as corrective feedback; no untrusted response text
becomes an instruction. Preserve uncertainty/conflicts and every original evidence
requirement. A second failure remains explicit and manually retryable; this does
not guarantee successful continuous operation.

Verify unchanged input, separate attempt telemetry, exact retry bounds, denied
retry classes, response-schema recovery, batch atomicity and late-final/correction
behavior. Then replay the saved duplicate-identity failure as the first attempt
and allow at most one fresh writer call. Report this as a recovery regression,
not a new complete capacity run or a repair to the original V5 result.
