import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const normalize = value => path.relative(root, value).split(path.sep).join('/');
const configs = ['tsconfig.test.json', 'electron/tsconfig.json'].map(file => {
  const loaded = ts.readConfigFile(file, ts.sys.readFile);
  if (loaded.error) throw new Error(ts.flattenDiagnosticMessageText(loaded.error.messageText, '\n'));
  return ts.parseJsonConfigFileContent(loaded.config, ts.sys, path.dirname(path.resolve(file)));
});
const files = [...new Set(configs.flatMap(config => config.fileNames))];
const program = ts.createProgram(files, configs[0].options);
const checker = program.getTypeChecker();
const watchedMethods = new Map([
  ['src/application/conversation-service.ts', new Set([
    'create', 'get', 'list', 'ensureWorkflowReply', 'ensureLocalReply', 'rename', 'archive',
    'restore', 'delete', 'addUserMessage', 'editCancelledUserMessage', 'start',
    'createCompletedLocalAssistantMessage', 'append', 'complete', 'attachDocumentResult',
    'updateDocumentGenerationStatus', 'fail', 'cancel'
  ])],
  ['src/application/conversation-context-builder.ts', new Set(['build'])],
  ['src/application/agent-context-assembler.ts', new Set(['assemble'])],
  ['src/platform/providers/conversation-response-artifact-factory.ts', new Set(['create'])],
  ['src/platform/ipc/conversation-controller.ts', new Set([
    'create', 'get', 'list', 'listCandidates', 'rename', 'archive', 'restore', 'delete',
    'addUserMessage', 'editCancelledUserMessage', 'copyLegacyConversation', 'requestAssistantResponse'
  ])],
  ['src/shared/chat-context-ipc.ts', new Set(['getConversation', 'listConversations'])]
]);
const watchedFiles = new Set(watchedMethods.keys());
const watchedNames = new Set([
  'ConversationApplicationService', 'ConversationContextBuilder',
  'AgentContextAssembler', 'ConversationResponseArtifactFactory'
]);
const references = [];
for (const source of program.getSourceFiles()) {
  const file = normalize(source.fileName);
  if (source.isDeclarationFile || !/^(src|electron|tests)\//u.test(file)) continue;
  const visit = node => {
    if (ts.isCallExpression(node)) {
      const declaration = checker.getResolvedSignature(node)?.declaration;
      const declarationFile = declaration && normalize(declaration.getSourceFile().fileName);
      const name = ts.isPropertyAccessExpression(node.expression) ? node.expression.name.text : '';
      if (declarationFile && watchedMethods.get(declarationFile)?.has(name)) {
        references.push({
          file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          name, kind: 'resolved_call_signature', declarationFile,
          declarationLine: declaration.getSourceFile().getLineAndCharacterOfPosition(declaration.getStart()).line + 1
        });
      }
    }
    if (ts.isIdentifier(node) && watchedNames.has(node.text)) {
      let symbol = checker.getSymbolAtLocation(node);
      if (symbol?.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      const declaration = symbol?.declarations?.find(item => watchedFiles.has(normalize(item.getSourceFile().fileName)));
      if (declaration) references.push({
        file, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        name: node.text, kind: 'resolved_symbol_reference',
        declarationFile: normalize(declaration.getSourceFile().fileName)
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
const design = fs.readFileSync('docs/architecture/conversation-system-refactor.md', 'utf8');
const evidencePaths = [...new Set(design.match(/(?:src|electron|tests)\/[A-Za-z0-9_./-]+\.(?:tsx|ts|mjs)\b/gu) ?? [])];
const missingPaths = evidencePaths.filter(file => !fs.existsSync(file));
const productionCalls = references.filter(row => row.kind === 'resolved_call_signature' && !row.file.startsWith('tests/'));
const productionCallCount = productionCalls.length;
if (!productionCallCount) throw new Error('No production references resolved; audit cannot pass');
if (missingPaths.length) throw new Error(`Missing design evidence paths: ${missingPaths.join(', ')}`);
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  method: 'TypeScript Compiler API symbol and resolved call signature analysis',
  parsedConfigs: ['tsconfig.test.json', 'electron/tsconfig.json'],
  checkedEvidencePaths: evidencePaths.length,
  missingPaths,
  watchedMethods: Object.fromEntries([...watchedMethods].map(([file, names]) => [file, [...names].sort()])),
  productionCallCount,
  references
};
const outIndex = process.argv.indexOf('--out');
if (outIndex >= 0) {
  const destination = path.resolve(process.argv[outIndex + 1] ?? '');
  const relative = path.relative(path.join(root, 'outputs'), destination);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Report destination must be inside outputs/');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, JSON.stringify(report, null, 2) + '\n');
}
console.info(JSON.stringify({ checkedEvidencePaths: evidencePaths.length, productionCallCount,
  references: references.length, missingPaths,
  consumers: [...new Set(productionCalls.map(row => row.file))] }, null, 2));
