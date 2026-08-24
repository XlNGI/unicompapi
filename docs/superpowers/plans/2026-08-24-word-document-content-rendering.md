# Word Document Content and Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert the model's alternate Word JSON into the existing document outline contract and generate an editable DOCX whose content and typography resemble the user-provided screenshot instead of exposing JSON text.

**Architecture:** Keep the existing Electron main-process document workflow and `DocumentOutline` as the only generation input. Add a strict model-content normalization boundary in `src/platform/documents/`; canonical outlines remain unchanged, the observed alternate `{ title, sections[].content }` shape is normalized explicitly, and malformed JSON-shaped responses fail closed instead of entering Markdown fallback. Improve only the Word adapter in `office-document-generator.ts` with native DOCX styles, editable paragraphs, lists, captions, and tables; Excel/PPT and IPC DTOs remain on their existing paths.

**Tech Stack:** TypeScript, Electron main process, `docx` 9.7.1, Vitest, Node test, pnpm.

**Spec:** `docs/superpowers/specs/2026-08-24-word-document-content-rendering-design.md`

## Global Constraints

- Required delivery platform remains Windows x64; this change does not add portable, macOS, signing, or publishing behavior.
- Use the existing owners: `src/platform/documents/` for normalization and Office generation, `src/platform/ipc/document-generation-controller.ts` for orchestration, and existing test layers for evidence.
- Do not add a provider, model, dependency, IPC channel, arbitrary file access, retry path, or generic Agent runtime.
- Renderer continues to submit only the existing message/document request fields; it does not receive paths, credentials, raw provider responses, or hashes.
- Markdown fallback is allowed only for content that is not JSON-shaped; malformed or unsupported JSON-shaped model output must not be rendered as literal JSON.
- The canonical `DocumentOutline` contract remains the generation input; the observed alternate model shape is an adapter, not a second persisted business schema.
- Word output remains a native editable DOCX; do not embed screenshots or flatten pages into images.
- Keep the root `AGENTS.md` local-only and untouched in the main checkout and do not modify handoff originals.
- Do not run real Provider calls, read credentials, package installers, or commit/push changes without explicit authorization.

---

### Task 1: Add a strict model-content normalization boundary

**Files:**
- Modify: `src/platform/documents/document-outline-parser.ts`
- Modify: `src/platform/documents/index.ts` if the new parser is not already exported through the existing barrel
- Test: `tests/platform/document-outline-parser.test.ts`

**Interfaces:**
- Consumes: assistant message content and the requested `DocumentWorkspaceKind` (`'word' | 'excel' | 'ppt'`).
- Produces: `parseDocumentContent(content: string, kind: DocumentWorkspaceKind): DocumentOutline`.
- Existing `parseDocumentOutline`, `parseMarkdownToOutline`, `stripPreamble`, and `unwrapJsonFence` keep their current public behavior.

- [ ] **Step 1: Write the failing tests for the observed alternate JSON shape**

Add a fixture matching the screenshots and assert that the adapter maps it to the canonical contract:

```ts
it('normalizes the observed section-content JSON shape into a Word outline', () => {
  const source = JSON.stringify({
    title: '智能客服 Agent 系统设计文档',
    sections: [
      {
        id: '1',
        heading: '一、系统概述',
        content: [
          { type: 'paragraph', text: '系统说明。' },
          {
            type: 'table',
            caption: '表 1-1 系统核心能力',
            headers: ['能力', '说明'],
            rows: [['意图识别', '识别用户咨询']]
          }
        ]
      },
      {
        id: '2',
        heading: '二、核心流程',
        content: [
          {
            type: 'ordered_list',
            items: ['接收请求', '检索资料', '输出答案']
          },
          {
            type: 'subsection',
            heading: '2.1 低置信度处理',
            content: [{ type: 'paragraph', text: '转人工。' }]
          }
        ]
      }
    ]
  });

  const outline = parseDocumentContent(source, 'word');

  expect(outline).toMatchObject({
    kind: 'word',
    title: '智能客服 Agent 系统设计文档',
    sections: [
      {
        heading: '一、系统概述',
        level: 1,
        blocks: [
          { type: 'paragraph', text: '系统说明。' },
          { type: 'paragraph', text: '表 1-1 系统核心能力' },
          {
            type: 'table',
            header: ['能力', '说明'],
            rows: [['意图识别', '识别用户咨询']]
          }
        ]
      },
      {
        heading: '二、核心流程',
        level: 1,
        blocks: [
          { type: 'numbered', items: ['接收请求', '检索资料', '输出答案'] },
          { type: 'paragraph', text: '2.1 低置信度处理' },
          { type: 'paragraph', text: '转人工。' }
        ]
      }
    ]
  });
});
```

- [ ] **Step 2: Add failing negative-path tests**

Add tests proving that malformed JSON-shaped content does not become a Markdown paragraph, while ordinary Markdown still uses the existing fallback:

```ts
it('fails closed for unsupported JSON-shaped content', () => {
  expect(() =>
    parseDocumentContent(
      '{"title":"文档","sections":[{"heading":"正文","content":[{"type":"unknown"}]}]}',
      'word'
    )
  ).toThrow(DocumentOutlineError);
});

it('keeps Markdown fallback for non-JSON content', () => {
  expect(parseDocumentContent('# 周报\n\n正文。', 'word').title).toBe('周报');
});
```

- [ ] **Step 3: Run the focused parser tests and verify RED**

Run:

```text
pnpm exec vitest run tests/platform/document-outline-parser.test.ts --reporter=verbose
```

Expected: the new normalization and malformed-JSON tests fail because `parseDocumentContent` is not implemented; existing parser tests remain green.

- [ ] **Step 4: Implement the minimal adapter**

Implement `parseDocumentContent` in the document parser owner with this decision table:

```ts
export function parseDocumentContent(
  content: string,
  kind: DocumentWorkspaceKind
): DocumentOutline {
  const cleaned = stripPreamble(content);
  const candidate = unwrapJsonFence(cleaned);
  if (!looksLikeJson(candidate)) {
    return parseMarkdownToOutline(cleaned, kind);
  }

  const parsed = parseJsonRecord(candidate); // throws DocumentOutlineError
  if (isCanonicalOutline(parsed)) {
    const outline = parseDocumentOutline(candidate);
    if (outline.kind !== kind) {
      throw new DocumentOutlineError(
        'document_invalid_outline',
        `Document outline kind must be ${kind}`
      );
    }
    return outline;
  }

  return normalizeObservedDocument(parsed, kind);
}
```

`normalizeObservedDocument` must accept only the observed object shape: non-empty string `title`, an array of sections, section `heading`, and `content` blocks. Map `paragraph` to `paragraph`, `ordered_list` to `numbered`, `unordered_list`/`bullet_list` to `bullets`, and `table.headers`/`rows` to the canonical table. Convert a table `caption` into a paragraph immediately before the table so the caption remains visible without expanding the shared table contract. Recursively flatten `subsection` content into a section's block sequence and assign its heading as a paragraph before its child blocks. Unknown block types, missing required text, invalid row cells, or unsupported root shapes throw `DocumentOutlineError`; no fields are guessed or silently dropped.

- [ ] **Step 5: Run the focused parser tests and verify GREEN**

Run the same focused command. Expected: all parser tests pass, including the observed screenshot shape, malformed JSON rejection, canonical contract, and Markdown fallback.

- [ ] **Step 6: Run the existing platform document tests**

Run:

```text
pnpm exec vitest run tests/platform/document-outline-parser.test.ts tests/platform/document-generation-controller.test.ts --reporter=verbose
```

Expected: all selected tests pass; no provider or credential access occurs.

### Task 2: Route assistant messages through the adapter and make the model contract explicit

**Files:**
- Modify: `src/platform/ipc/document-generation-controller.ts`
- Modify: `src/pages/chat/documentDrafting.ts`
- Test: `tests/platform/document-generation-controller.test.ts`
- Test: `tests/application/document-drafting.test.ts`

**Interfaces:**
- Consumes: `parseDocumentContent` from Task 1 and the existing `generateFromMessage` request.
- Produces: the same `DocumentGenerationIpcResult`; invalid model content returns the existing `invalid_outline` error and never runs the generator.

- [ ] **Step 1: Write the failing controller regression test**

Create a completed assistant message containing the screenshot-shaped JSON, call `generateFromMessage({ kind: 'word', ... })`, and assert the generated file is registered with a meaningful title rather than `{`. Add a second test with unsupported JSON-shaped content and assert `{ ok: false, error.code: 'invalid_outline' }` plus no new work record.

- [ ] **Step 2: Run the controller tests and verify RED**

Run:

```text
pnpm exec vitest run tests/platform/document-generation-controller.test.ts --reporter=verbose
```

Expected: the screenshot-shaped message follows the current Markdown fallback and the new assertions fail before the controller is changed.

- [ ] **Step 3: Replace the broad JSON-error fallback**

In `DocumentGenerationController.generateFromMessage`, replace the current `try { parseDocumentOutline(...) } catch { parseMarkdownToOutline(...) }` block with:

```ts
const outline = parseDocumentContent(message.content, input.kind);
```

Keep the existing `execute` error mapping so `DocumentOutlineError` becomes `invalid_outline`. Do not alter the persistence, revision retry, runner, or file-registration flow.

- [ ] **Step 4: Make Word prompting use the canonical contract**

Update `documentKindInstruction('word')` and the shared document instruction so the model sees the exact canonical object shape, including `kind`, `title`, `sections`, `heading`, `level`, `blocks`, `paragraph`, `numbered`, `bullets`, and `table.header`. Explicitly prohibit alternate keys observed in the screenshot (`content`, `id`, `ordered_list`, `headers`, and `subsection`). Keep the instruction that content must be based on supplied materials and that unsupported facts must not be invented. Preserve the existing Excel/PPT intent rules.

- [ ] **Step 5: Run application and controller tests and verify GREEN**

Run:

```text
pnpm exec vitest run tests/application/document-drafting.test.ts tests/platform/document-generation-controller.test.ts --reporter=verbose
```

Expected: prompt-contract tests, canonical messages, screenshot-shaped messages, and invalid JSON-shaped messages all pass. The invalid path must not create a `Work` record.

### Task 3: Render a professional, editable Word document

**Files:**
- Modify: `src/platform/documents/office-document-generator.ts`
- Test: `tests/platform/office-document-generator.test.ts`

**Interfaces:**
- Consumes: canonical `DocumentOutline` and existing `DocumentTheme` from Task 1/2.
- Produces: native DOCX bytes with structured editable paragraphs, headings, lists, captions, and tables; Excel/PPT branches remain unchanged.

- [ ] **Step 1: Write the failing DOCX layout/content tests**

Generate a Word file from the normalized screenshot fixture and inspect `word/document.xml`. Assert the XML contains the title, section headings, paragraph text, table caption, table cells, separate list text, a centered title paragraph, the selected accent color, and a shaded/bold table header. Assert the XML does not contain raw JSON markers such as `"title"`, `"sections"`, `"content"`, or `"ordered_list"`.

- [ ] **Step 2: Run the Word generator tests and verify RED**

Run:

```text
pnpm exec vitest run tests/platform/office-document-generator.test.ts --reporter=verbose
```

Expected: existing generation tests pass, while the new style and alternate-content assertions fail because the current Word adapter uses default paragraph styles, concatenates list items into one paragraph, and has no styled table header.

- [ ] **Step 3: Add native Word styles without changing the outline contract**

Configure the `Document` with:

- page margins suitable for the screenshot-like report layout;
- default East Asian/body font fallback and readable paragraph spacing;
- a centered, accent-colored, bold title with a bottom divider;
- accent-colored heading 1/2/3 styles with `keepNext` and spacing before/after;
- body paragraphs with readable line spacing;
- separate `Paragraph` instances for every bullet/numbered item so each item receives its own native marker;
- a visible caption paragraph before a table when normalization supplies one;
- percentage-width tables with header shading derived from `theme.accent`, white bold header text, consistent cell margins, muted borders, and readable body rows.

Keep all values local to the Word adapter or derive them from the existing `DocumentTheme`; do not introduce a second theme registry or image-based layout.

- [ ] **Step 4: Flatten Word blocks safely**

Change the private Word block helper to return `readonly (Paragraph | Table)[]` and flatten it from `buildWordBuffer`. Paragraph and quote blocks return one item, list blocks return one paragraph per item, table blocks return the caption paragraph (when present) followed by the table, and chart blocks retain their current Word text representation. This prevents list text from being concatenated and keeps all content editable.

- [ ] **Step 5: Run the Word generator tests and verify GREEN**

Run the same focused generator command. Expected: all existing Word/Excel/PPT generation tests and new XML layout/content assertions pass.

- [ ] **Step 6: Run the combined document path tests**

Run:

```text
pnpm exec vitest run tests/application/document-drafting.test.ts tests/platform/document-outline-parser.test.ts tests/platform/document-generation-controller.test.ts tests/platform/office-document-generator.test.ts --reporter=verbose
```

Expected: the complete synthetic assistant-message-to-DOCX path passes without a raw JSON marker in the generated Word XML.

### Task 4: Record acceptance evidence and complete verification

**Files:**
- Create: `docs/active/对话内Office文档生成-Word内容与排版修复验收记录.md`
- Modify: `PLANS.md` with the actual implementation and verification result after tests pass

**Interfaces:**
- Consumes: passing tests and Windows manual evidence from Tasks 1–3.
- Produces: an owner-aligned acceptance record; no new runtime contract or competing product source.

- [ ] **Step 1: Run the risk-scoped automated gates**

Run:

```text
pnpm test:application
pnpm test:platform
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Expected: all commands exit 0. If a non-document baseline test fails, record its exact command, test name, and fresh output; do not change unrelated code.

- [ ] **Step 2: Perform Windows Electron manual acceptance**

In the Windows app, with a local project open and no real Provider budget added for this task:

1. Use the existing conversation/document flow with a completed assistant message equivalent to the screenshot-shaped JSON and generate Word.
2. Open the DOCX in WPS/Word and confirm the title, headings, paragraphs, numbered lists, table captions, table headers, and cells are normal editable Word content; confirm no `{`, JSON keys, or serialized arrays appear.
3. Confirm the visual direction matches screenshot 3: centered colored title, readable heading hierarchy, divider, paragraph spacing, native lists, and styled editable tables.
4. Repeat with ordinary Markdown content and with a malformed JSON-shaped response; the former generates normally and the latter reports `invalid_outline` without registering a misleading Word work.
5. Check the document card, Work registration, file opening, same-project ownership, and no path/credential exposure in renderer-visible data.

- [ ] **Step 3: Write the acceptance record**

Record modified files, exact commands and results, the synthetic JSON-shape regression, the manual Windows observations, the known baseline PDF cold-start timeout that passed on rerun, and any unverified boundaries. Do not claim real Provider, packaging, macOS, signing, or security-complete validation.

- [ ] **Step 4: Leave the branch ready for user review**

Run `git status --short --branch` and `git diff --stat`. Keep `AGENTS.md` unstaged and do not commit, push, create a PR, or merge without explicit authorization.

## Self-Review

- Coverage: the screenshot-shaped JSON contract, fail-closed invalid JSON behavior, canonical Markdown fallback, controller integration, professional editable Word styling, native lists/tables, application/platform tests, and Windows manual acceptance each have a task.
- Completeness scan: every code step, negative path, command, and expected result is explicit; no deferred or unspecified implementation step remains.
- Type consistency: Task 1 produces `parseDocumentContent(content, kind): DocumentOutline`; Task 2 consumes it; Task 3 consumes the resulting canonical outline and returns native DOCX bytes; Task 4 verifies the complete path.
- Baseline note: the first full `pnpm test` run had one cold PDF extraction timeout under concurrent load; the focused test and immediate full rerun passed, so the PDF code remains out of scope.
