# Seedance Video Parameter Contract Record

Date: 2026-08-26

## Follow-up correction (2026-08-27)

The implementation decision below remains the active UniCompAPI gateway
contract. The exact UniCompAPI Seedance image-to-video route follows the
dashboard envelope: `model` plus `metadata` controls and a `content[]` array
containing text and one first-frame `image_url`. Generic NewAPI routes retain
the legacy projection.
Two approved local submission attempts received HTTP 400 / safe upstream code
`invalid_tokenpony_request` from the configured endpoint's front layer. The
UniCompAPI backend has no corresponding call records, so business-gateway
receipt is unconfirmed; no further real calls are authorized until the
instance-level TokenPony contract and request-recording path are provided. Full evidence is recorded in
`docs/active/UniCompAPI-Seedance图生视频真实验收与拒绝记录-2026-08-27.md`.

## Scope

This record covers the UniCompAPI video gateway mappings for
`doubao-seedance-2-0-260128` and `doubao-seedance-2-0-fast-260128`.
The original 2026-08-26 contract review sent no provider request and read no
credential; the follow-up real submissions are recorded separately above.

## Evidence

Volcano Ark documentation was reviewed on 2026-08-26:

- Create video task: `https://docs.volcengine.com/docs/82379/1520757?lang=zh`
- Seedance 2.0 guide: `https://docs.volcengine.com/docs/82379/2291680?lang=zh`

For both models, official API required fields are `model` and `content`.
The optional controls are `resolution`, `ratio`, `duration`, `frames`,
`generate_audio`, `watermark`, `seed`, `camera_fixed`, and
`return_last_frame`.

The standard model permits resolutions `480p`, `720p`, `1080p`, and `4k`.
The Fast model permits only `480p` and `720p`. Both use ratios `21:9`,
`16:9`, `4:3`, `1:1`, `3:4`, `9:16`, and `adaptive`, and duration `-1` or
an integer from `4` through `15`.

## Implementation Decision

Official capability values are represented by separate per-model parameter
schemas and local validation. The UI renders them as enum controls and marks
only actual required inputs: selected model, prompt, and the image-to-video
first frame.

UniCompAPI's Seedance `/v1/videos` body uses `model + metadata + content[]`;
the dashboard's image path uses a public MinIO URL rather than a large inline
data URL. The desktop adapter preserves the controlled local image bytes while
the instance's media-upload contract remains unverified. Invalid enum values
fail before HTTP dispatch.

## Verification

Focused Vitest coverage verifies routing, schema registration, Fast model
limits, standard 4k acceptance, and zero HTTP requests for invalid values.
UI contract coverage verifies required labels and local pre-submit errors.
On 2026-08-26, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and
`git diff --check` all completed successfully.
