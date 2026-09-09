# Chat Performance Optimization Acceptance Record

Date: 2026-08-18
Branch: `feature/chat-stop-edit-resend`
Phase: 9 (phase 10 not started)

## Scope

This increment keeps the existing chat surface and implements fast local acceptance for send and stop commands. It does not add a top-level page, provider, model, credential, publishing flow, or paid provider call.

## Delivered behavior

- `startResponse` performs local conversation/message/draft/route acceptance and returns the pending execution before provider dispatch completes.
- Repeated `clientCommandId` values are idempotent within the project process and do not create a second execution.
- The acceptance path persists the assistant message once as `pending`; the background provider lifecycle projects it to `streaming` only when the stream actually starts.
- Stream deltas are appended as batches through one atomic repository write per batch.
- Renderer stream events are coalesced into at most one React state update per animation frame. Terminal events flush immediately.
- Historical Markdown messages are memoized, so send, stop, and active-stream state changes do not reparse unchanged conversation history.
- A response subscription resumes after the last known `streamSequence`. Live events received during replay are buffered, ordered, and deduplicated before delivery.
- Stop requests call the provider session abort without waiting for SSE completion. The renderer stays in a cancelling state until a terminal event is received.
- For an active provider handle, cancellation is initiated before any execution or conversation persistence read.
- A stop received before provider handle registration is queued by the execution coordinator. A late provider handle is cancelled automatically.
- A bounded cancellation timeout writes `stream_interrupted` with `transport_interrupted`; the pending cancellation registry is capped at 256 entries.
- Only a confirmed `stream_cancelled` restores the previous user message for editing. Interrupted, failed, completed, or still-active executions remain non-editable.

## Delay reproduction and resolution

The reported multi-second pause was reproduced without a provider call by rendering long Markdown histories. The cost grew with total conversation size, not with the new message size:

| Conversation history | Full-history render time before this increment |
| --- | ---: |
| 20 messages x 18K Markdown | 1.465 s |
| 50 messages x 18K Markdown | 3.436 s |
| 100 messages x 18K Markdown | 6.606 s |
| 200 messages x 18K Markdown | 12.699 s |

Control measurements did not reproduce the same delay in the main-process path: delayed provider dispatch still returned local acceptance in 135 ms, a synthetic 50 MB double durable write took 97 ms, and the response artifact factory suite completed in 154 ms. This identifies repeated Renderer Markdown parsing as the primary reproduced cause. Memoization removes unchanged history from send/stop/SSE rerenders; frame batching bounds active-message parsing frequency. Initial opening of a very large conversation still parses its Markdown once and remains a separate virtualization candidate if product-scale histories require it.

## Verification

- `node --test tests/*.test.mjs tests/ui/*.test.mjs`: 262 passed, 0 failed.
- `vitest run tests/domain tests/platform`: 725 passed, 0 failed.
- `npm.cmd run typecheck`: passed.
- `npm.cmd run lint`: passed.
- `npm.cmd run build`: passed; Vite emitted the existing chunk-size warning only.
- `npm.cmd run audit:platform`: passed; 0 violations.
- `npm.cmd run verify:handoff`: passed; 50 checksum entries and 27 manifest assets verified.
- `git diff --check`: passed.

## Boundaries and follow-up

- No real paid provider request was made. Vidu image/video budgets remain exhausted and were not called.
- Initial rendering of an unusually large conversation is still proportional to its visible Markdown history. Windowing/virtualization is not included in this increment because the reported send/stop hot path no longer reparses unchanged history.
- macOS real-device and media-toolchain suites remain deferred with `required=false`; this record does not claim macOS support.
- Phase 10 release work (packaging, signing, notarization, production update, SBOM, and distribution) remains unopened.
