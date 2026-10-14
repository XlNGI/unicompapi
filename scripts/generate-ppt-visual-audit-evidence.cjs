/* Generates local, reproducible PPTX/IR/page-image evidence. It uses only the
 * configured local Office and PDF renderers; no provider or network request is made. */
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { generateTemporaryDocumentFile } = require('../dist-electron/src/platform/documents/office-document-generator.js');
const { buildFallbackPresentationDesignIR, parsePresentationDesignIR } = require('../dist-electron/src/domain/entities/presentation-design-contract.js');
const { compilePresentationRenderPlan } = require('../dist-electron/src/platform/documents/presentation-render-plan-compiler.js');
const { resolvePresentationTemplate } = require('../dist-electron/src/platform/documents/presentation-template.js');
const { inspectPptxGeometry } = require('../dist-electron/src/platform/documents/office-render-adapter.js');

const root = path.resolve(process.env.UNICOMP_PPT_EVIDENCE_DIR || path.join('docs', 'evidence', 'ppt-visual-audit-20261013'));
const office = process.env.UNICOMP_OFFICE_RENDERER;
const pdfToPng = process.env.UNICOMP_PDF_RENDERER;
if (!office || !pdfToPng) throw new Error('UNICOMP_OFFICE_RENDERER and UNICOMP_PDF_RENDERER are required');

const outline = {
  kind: 'ppt', title: '测试演示文稿：质量闭环', sections: [
    { heading: '测试目标', level: 1, pageKind: 'insight', blocks: [{ type: 'paragraph', text: '验证生成链路稳定、可复核、可交付' }] },
    { heading: '测试范围', level: 1, pageKind: 'comparison', blocks: [{ type: 'paragraph', text: '覆盖内容规划、Design IR、布局、渲染和登记' }, { type: 'paragraph', text: '不覆盖真实 Provider 收费请求和 macOS 延期目标' }] },
    { heading: '测试流程', level: 1, pageKind: 'process', blocks: [{ type: 'numbered', items: ['第一步：准备同等内容与约束', '第二步：生成 Art Direction 与 Design IR', '第三步：执行布局、渲染和结构检查', '第四步：保存截图与可复核证据'] }] },
    { heading: '预期结果', level: 1, pageKind: 'data', blocks: [{ type: 'bullets', items: ['每页内容完整且无越界', '流程页按语义顺序呈现', '视觉风格跨页一致并可解释'] }] }
  ]
};

function optimizedDesign() {
  const base = buildFallbackPresentationDesignIR(outline);
  const itemRef = (index, item) => `outline.sections[${index}].blocks[0].items[${item}]`;
  const pages = base.pages.map(page => ({ ...page }));
  pages[0] = { ...pages[0], visualTreatment: { surface: 'flat', accent: 'rule' } };
  pages[1] = { ...pages[1], visualTreatment: { surface: 'card', accent: 'edge' }, composition: { principle: 'comparison', focalArea: 'center', balance: 'symmetric', flow: 'comparison' } };
  pages[3] = { ...pages[3], hierarchy: { primary: ['outline.sections[2].heading'], secondary: [itemRef(2, 0), itemRef(2, 1), itemRef(2, 2), itemRef(2, 3)], supporting: [] },
    contentRoles: { title: ['outline.sections[2].heading'], body: [itemRef(2, 0), itemRef(2, 1), itemRef(2, 2), itemRef(2, 3)], metric: [], evidence: [], image: [], chart: [] },
    visualTreatment: { surface: 'card', accent: 'edge', component: 'track' }, composition: { principle: 'timeline', focalArea: 'center', balance: 'symmetric', flow: 'left-to-right' },
    visualStrategy: 'Four ordered steps with a horizontal process track and one visual entry point.' };
  pages[4] = { ...pages[4], visualTreatment: { surface: 'outlined', accent: 'rule' } };
  pages[5] = { ...pages[5], visualTreatment: { surface: 'flat', accent: 'rule' } };
  return parsePresentationDesignIR({ ...base, globalDesign: { ...base.globalDesign, visualTone: 'technical', visualRhythm: 'progressive', density: 'balanced', whitespace: 'generous', typographyDirection: 'display-led', colorDirection: 'restrained', visualSystem: {
    palette: { background: '07111F', surface: '102A43', text: 'F5FAFF', muted: 'B7C9DC', accent: '35D6C8', secondaryAccent: 'FE5EA8' },
    typography: { displayScale: 1.06, bodyScale: 0.98, displayWeight: 800, bodyWeight: 400, lineSpacing: 1.24, charSpacing: 0.15 }
  } }, pages }, { outline });
}

async function renderPages(pptxPath, prefix) {
  const renderRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-ppt-evidence-'));
  const pdfDir = path.join(renderRoot, 'pdf');
  await fs.mkdir(pdfDir, { recursive: true });
  execFileSync(office, [`-env:UserInstallation=${pathToFileURL(path.join(renderRoot, 'office-profile')).href}`, '--headless', '--convert-to', 'pdf', '--outdir', pdfDir, pptxPath], { windowsHide: true, stdio: 'ignore' });
  const pdf = path.join(pdfDir, `${path.basename(pptxPath, '.pptx')}.pdf`);
  execFileSync(pdfToPng, ['-png', '-r', '120', pdf, path.join(renderRoot, 'page')], { windowsHide: true, stdio: 'ignore' });
  const names = (await fs.readdir(renderRoot)).filter(name => /^page-\d+\.png$/u.test(name)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  for (const name of names) await fs.copyFile(path.join(renderRoot, name), path.join(root, `${prefix}-${name}`));
  await fs.rm(renderRoot, { recursive: true, force: true });
  return names.length;
}

async function generate(name, designIR) {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'unicomp-ppt-source-'));
  let prepared;
  const result = await generateTemporaryDocumentFile({ kind: 'ppt', outline, outputDirectory: tempRoot, presentationTemplate: 'business_minimal', now: '2026-10-13T18:00:00.000Z',
    ...(designIR ? { designIR } : {}), onPlanPrepared: value => { prepared = value; } });
  const target = path.join(root, `${name}.pptx`);
  await fs.copyFile(result.temporaryPath, target);
  await fs.writeFile(path.join(root, `${name}-design.json`), JSON.stringify(designIR ?? null, null, 2));
  if (prepared?.renderPlan) await fs.writeFile(path.join(root, `${name}-render-plan.json`), JSON.stringify(prepared.renderPlan, null, 2));
  await fs.writeFile(path.join(root, `${name}-geometry.json`), JSON.stringify(await inspectPptxGeometry(target), null, 2));
  await fs.rm(tempRoot, { recursive: true, force: true });
  return target;
}

(async () => {
  await fs.mkdir(root, { recursive: true });
  const designIR = optimizedDesign();
  const baseline = await generate('baseline', undefined);
  const optimized = await generate('optimized', designIR);
  const compilation = compilePresentationRenderPlan(outline, designIR, resolvePresentationTemplate('business_minimal').tokens);
  await fs.writeFile(path.join(root, 'optimized-audit.json'), JSON.stringify(compilation.visualAudit ?? null, null, 2));
  await renderPages(baseline, 'baseline');
  await renderPages(optimized, 'optimized');
  console.log(JSON.stringify({ root, pages: 6, baseline, optimized, geometryErrors: { baseline: JSON.parse(await fs.readFile(path.join(root, 'baseline-geometry.json'))).length, optimized: JSON.parse(await fs.readFile(path.join(root, 'optimized-geometry.json'))).length } }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
