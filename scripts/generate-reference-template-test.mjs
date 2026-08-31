import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const sourcePath = process.argv[2] ?? path.resolve(
  'src/platform/documents/templates/university-classroom.pptx'
);
const outputPath = process.argv[3] ?? path.resolve('tmp/reference-template-test.pptx');

const replacements = [
  ['人工智能入门', 'AI 学习路径：从理解到实践'],
  ['从“会用工具”到“理解系统”', '面向大学生的课堂汇报测试'],
  ['面向大学生的基础认知与实践指南', '直接基于原始 PPTX 母版填充内容'],
  ['AI 是一条不断升级的技术路线', 'AI 技术发展时间轴'],
  ['从“人写规则”走向“机器从数据中学习”，再到“模型生成内容”。', '从规则、数据到模型协作，观察 AI 能力如何演进。'],
  ['1950s–80s', '1950s–80s'],
  ['规则系统', '早期探索'],
  ['专家把知识写进程序', '专家把规则写进程序'],
  ['1990s–2010s', '1990s–2010s'],
  ['机器学习', '数据驱动'],
  ['从样本中找到规律', '从数据中学习规律'],
  ['2010s', '2010s'],
  ['深度学习', '深度模型'],
  ['神经网络处理复杂感知', '表征复杂感知任务'],
  ['2020s–', '2020s–'],
  ['生成式 AI', '生成协作'],
  ['模型理解并生成内容', '生成内容与解决方案'],
  ['趋势：规则 → 数据 → 模型 → 协作', '趋势：规则 → 数据 → 模型 → 协作'],
  ['10 页课堂汇报', '原始母版填充测试'],
  ['AI 入门 · 大学生课堂汇报', '母版测试 · 可编辑 PPTX']
];

function escapeXml(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function replaceTextNodes(xml, from, to) {
  const source = `<a:t>${escapeXml(from)}</a:t>`;
  const replacement = `<a:t>${escapeXml(to)}</a:t>`;
  const count = xml.split(source).length - 1;
  return { xml: xml.replaceAll(source, replacement), count };
}

const source = await readFile(sourcePath);
const zip = await JSZip.loadAsync(source);
let replaced = 0;
for (const entry of Object.values(zip.files)) {
  if (entry.dir || !entry.name.startsWith('ppt/slides/slide') || !entry.name.endsWith('.xml')) {
    continue;
  }
  let xml = await entry.async('string');
  for (const [from, to] of replacements) {
    const result = replaceTextNodes(xml, from, to);
    xml = result.xml;
    replaced += result.count;
  }
  zip.file(entry.name, xml);
}

if (replaced < 10) {
  throw new Error(`母版文本替换数量异常：${replaced}`);
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, await zip.generateAsync({ type: 'nodebuffer' }));
console.log(`已生成母版测试文件：${path.resolve(outputPath)}`);
console.log(`保留原始 PPTX 页面结构，仅替换文本节点：${replaced} 处`);
