/* Run actual local Office/PDF QA outside Vitest's VM, where native ESM imports work. */
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, file) => module._compile(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
}).outputText, file);
const { createConfiguredOfficeRenderAdapter } = require('../../src/platform/documents/office-render-adapter.ts');
(async () => {
  const render = createConfiguredOfficeRenderAdapter();
  if (!render) throw new Error('local_office_renderer_unavailable');
  const result = await render(path.resolve(process.argv[2]), { kind: 'ppt', signal: new AbortController().signal });
  process.stdout.write(`QA_RESULT:${JSON.stringify(result)}\n`);
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
