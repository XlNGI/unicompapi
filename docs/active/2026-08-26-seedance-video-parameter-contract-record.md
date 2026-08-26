# Seedance Video Parameter Contract Record

Date: 2026-08-26

## Scope

This record covers the UniCompAPI video gateway mappings for
`doubao-seedance-2-0-260128` and `doubao-seedance-2-0-fast-260128`.
No provider request was sent and no credential was read during this work.

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

UniCompAPI's verified `/v1/videos` gateway body remains `model + prompt`
with supported optional top-level fields and optional `image`. Ark's
`content[]` body is not forwarded to the gateway because its compatibility
has not been verified. Invalid enum values fail before HTTP dispatch.

## Verification

Focused Vitest coverage verifies routing, schema registration, Fast model
limits, standard 4k acceptance, and zero HTTP requests for invalid values.
UI contract coverage verifies required labels and local pre-submit errors.
On 2026-08-26, `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and
`git diff --check` all completed successfully.
