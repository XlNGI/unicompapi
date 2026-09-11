import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyProductionMedia } from './verify-production-media.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const xml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
export const storeAssets = {
  'StoreLogo.png': [50, 50],
  'Square150x150Logo.png': [150, 150],
  'Square44x44Logo.png': [44, 44],
  'Wide310x150Logo.png': [310, 150]
};

export function createStoreConfig(identity, version) {
  for (const key of ['identityName', 'publisher', 'publisherDisplayName', 'displayName']) {
    if (typeof identity?.[key] !== 'string' || !identity[key].trim() || identity[key] !== identity[key].trim()) {
      throw new Error(`请填写 Partner Center 的 ${key}，不要使用占位值或首尾空格。`);
    }
    if (/[\u0000-\u001f]/u.test(identity[key])) throw new Error(`${key} 含无效控制字符。`);
  }
  if (!/^[A-Za-z0-9.-]{3,50}$/u.test(identity.identityName)) throw new Error('identityName 必须使用产品标识页面的准确值。');
  if (!/^CN=.+/u.test(identity.publisher)) throw new Error('publisher 必须是产品标识中的完整 Publisher（CN=...）。');
  if (identity.displayName.length > 256 || identity.publisherDisplayName.length > 256) throw new Error('显示名称超过包清单限制。');
  if (!/^[1-9]\d*\.\d+\.\d+$/u.test(version) || version.split('.').some(n => Number(n) > 65535)) {
    throw new Error('商店正式版本须为 major.minor.patch，major 至少为 1，各段不超过 65535；请先明确设置 package.json 版本。');
  }
  return {
    extends: './electron-builder.yml',
    directories: { output: 'release-store' },
    extraResources: [{ from: 'build/production-media/media-engine', to: 'media-engine', filter: [
      'media-engine.json', 'source-information.json', 'bin/*', 'licenses/*', 'sources/*.zip', 'sources/*.tar.xz'
    ] }],
    // Keep the NSIS artifact pattern from leaking into the Store output.
    win: { target: [{ target: 'appx', arch: ['x64'] }], artifactName: 'UniComp-${version}-store-${arch}.${ext}' },
    appx: {
      identityName: identity.identityName,
      publisher: xml(identity.publisher),
      publisherDisplayName: xml(identity.publisherDisplayName),
      displayName: xml(identity.displayName),
      applicationId: 'UniComp',
      artifactName: 'UniComp-${version}-store-${arch}.${ext}',
      languages: ['zh-CN'],
      backgroundColor: '#101418',
      minVersion: '10.0.19045.0',
      maxVersionTested: '10.0.19045.0',
      setBuildNumber: false,
      addAutoLaunchExtension: false,
      electronUpdaterAware: false
    }
  };
}

function run(packageName, entry, args) {
  const executable = path.join(path.dirname(require.resolve(`${packageName}/package.json`)), entry);
  const result = spawnSync(process.execPath, [executable, ...args], {
    cwd: root, stdio: 'inherit', shell: false,
    env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' }
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${packageName} 执行失败（${result.status}）。`);
}

export async function packageStore(args = process.argv.slice(2)) {
  if (args.some(arg => arg !== '--check')) throw new Error('用法：node scripts/package-microsoft-store.mjs [--check]');
  const identityPath = path.join(root, 'config/microsoft-store.local.json');
  let identity;
  try { identity = JSON.parse(await readFile(identityPath, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new Error('缺少商店身份。复制 config/microsoft-store.example.json 为 microsoft-store.local.json，填写 Partner Center 的四项公开身份字段，再重试。');
  }
  const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const config = createStoreConfig(identity, metadata.version);
  for (const [name, [width, height]] of Object.entries(storeAssets)) {
    const png = await readFile(path.join(root, 'build-resources/appx', name));
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
      || png.readUInt32BE(16) !== width || png.readUInt32BE(20) !== height) throw new Error(`商店图标 ${name} 无效。`);
  }
  const media = await verifyProductionMedia(path.join(root, 'build/production-media/media-engine'));
  // Copy only the files that passed verification, including the distribution notices.
  config.extraResources[0].filter = [
    'media-engine.json', 'source-information.json', ...media.files, ...media.sourceArchives,
    'licenses/LGPL-3.0.txt', 'licenses/GPL-3.0.txt', 'licenses/SOURCE.md', 'licenses/THIRD_PARTY_NOTICES.txt'
  ];
  console.log(`商店身份和基础图标校验通过：${identity.identityName} / ${metadata.version}.0 / x64`);
  console.log('此校验不代替源码/许可证完整性复核、安装运行或商店审核。');
  if (args.includes('--check')) return;
  if (process.platform !== 'win32') throw new Error('请在 Windows 构建此商店包。');
  const output = path.join(root, 'release-store');
  await mkdir(output, { recursive: true });
  const file = `UniComp-${metadata.version}-store-x64.appx`;
  const artifactPath = path.join(output, file);
  await unlink(artifactPath).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  await unlink(`${artifactPath}.sha256`).catch((error) => {
    if (error.code !== 'ENOENT') throw error;
  });
  const generatedConfig = path.join(output, 'builder-store.json');
  // Resolve extends from the repository, independently of the output location.
  await writeFile(generatedConfig, JSON.stringify({ ...config, extends: path.join(root, 'electron-builder.yml') }, null, 2));
  run('typescript', 'bin/tsc', ['-b']);
  run('vite', 'bin/vite.js', ['build']);
  run('typescript', 'bin/tsc', ['-p', 'electron/tsconfig.json']);
  const copy = spawnSync(process.execPath, ['scripts/copy-document-templates.mjs'], { cwd: root, stdio: 'inherit', shell: false });
  if (copy.status !== 0) throw new Error('Office 模板复制失败。');
  run('electron-builder', 'cli.js', ['--win', 'appx', '--x64', '--config', generatedConfig, '--publish', 'never']);
  // Builder may sign nested executables; check the copied bytes before reporting success.
  await verifyProductionMedia(path.join(output, 'win-unpacked/resources/media-engine'), media.version);
  const details = await stat(artifactPath).catch(() => null);
  if (!details?.isFile() || details.size === 0) throw new Error('未找到本次构建生成的有效 AppX 产物。');
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(artifactPath)) hash.update(chunk);
  await writeFile(path.join(output, `${file}.sha256`), `${hash.digest('hex')}  ${file}\n`);
  console.log(`商店候选包：release-store/${file}。安装验证与审核完成前请勿视为正式发布。`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageStore().catch(error => { console.error(error.message); process.exitCode = 1; });
}
