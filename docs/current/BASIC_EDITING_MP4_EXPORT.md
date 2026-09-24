# Basic Editing MP4 Export

Status: stages 1–4 implementation and verification complete for the scoped Windows development path; manual OS-player and macOS checks remain unverified.
Baseline: develop 93c0a59; branch feature/basic-editing-mp4-export.
Authorization: 2026-09-21 user approved the four-stage proposal.
Owner: this task; this document is the sole execution record.

## Outcome and Scope

New basic-editing exports use MP4/H.264/AAC with software encoding. Only locally
verified outputs become works. Library playback must be verified independently.
Keep the editor layout, source materials, old works and frozen WebM plans intact.
No provider calls, real project mutations, dependency installation, release,
commit, push or merge. Use isolated fixtures for export and playback checks.

## Stages

1. Reproduce: correlate the file with its work/execution; capture Electron media
   errors and local response behavior; add meaningful failing MP4 contract tests.
2. Export: update plan/IPC/preflight/FFmpeg/output verification and filename UI;
   retain legacy plan readability and software encoding. Verify actual MP4,
   H.264/AAC streams, full decoding, cancellation/failure and no false work.
3. Playback: fix only the reproduced boundary; expose playback errors and verify
   MP4 plus legacy WebM, seeking, reopening and handle expiry.
4. Acceptance: targeted regressions, typecheck, lint, build, visible Electron
   and OS player where available. Report macOS and unavailable checks honestly.

Each stage reports its evidence before proceeding. A failed gate stops dependent
work. New dependencies, user-data migration or broader redesign reopen scope.

## Baseline Evidence

The inspected user export is genuine VP9/Opus WebM, 1280x720, 10.08 seconds,
772433 bytes. Full FFmpeg decoding passed and its SHA-256 matches registration.
The controller hardcodes WebM in preflight, filename and frozen plan. Local
FFmpeg contains libopenh264/AAC and a 0.2-second software probe passed. These
facts do not prove Electron playback or an MP4 export pipeline.

## Evidence and Remaining Work

T2: export format, frozen-plan compatibility, output registration and media
response contracts. T3: real Electron playback. Target existing tests under
tests/domain/video-export-plan.test.ts and tests/platform/video-export-*,
media-engine-adapter, controlled-local-media and local-media-response.

## Completion Evidence (2026-09-21)

- Controller, adapter, domain and local-media regressions: 30/30 Vitest tests passed.
- FFmpeg tooling contract: 8/8 Node tests passed; no dependency or binary change.
- Real controller export produced `outputs/editing-mp4/controller-export.mp4`; probe confirmed MP4/H.264/AAC and full FFmpeg decode passed.
- Output verification now rejects an `.mp4` path whose probed container/video/audio tuple does not match MP4/H.264/AAC; the controller also rejects a container mismatch before Work registration.
- Real Electron harness loaded the produced MP4 with omitted and explicit `video/mp4` MIME, played, sought to midpoint, advanced to `ended`, and reopened both checks successfully. Evidence: `outputs/editing-mp4/after.json` and `after.png`.
- `pnpm typecheck`, `pnpm lint`, `pnpm build`, tooling tests and `git diff --check` passed. Build emitted only existing bundle-size/CJS warnings.

Historical WebM plans and files remain readable. Existing malformed or decoder-incompatible WebM files are not silently converted; re-exporting the draft creates the new MP4 work. Manual library-page navigation, native OS-player playback, macOS Electron and production packaging remain unverified.
