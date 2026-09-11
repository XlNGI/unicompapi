import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createRuntimeMediaEngine,
  resolvePackagedMediaEngine
} from '../../electron/ipc/runtime-media-engine';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function packageFixture() {
  const resourcesPath = await mkdtemp(path.join(os.tmpdir(), 'unicomp-runtime-media-'));
  roots.push(resourcesPath);
  const componentRoot = path.join(resourcesPath, 'media-engine');
  await mkdir(path.join(componentRoot, 'bin'), { recursive: true });
  const files = await Promise.all(['ffmpeg.exe', 'ffprobe.exe', 'avcodec.dll'].map(async (name) => {
    const bytes = Buffer.from(`synthetic media fixture: ${name}`);
    await writeFile(path.join(componentRoot, 'bin', name), bytes);
    return { path: `bin/${name}`, sha256: createHash('sha256').update(bytes).digest('hex') };
  }));
  const manifest = {
    schemaVersion: 1,
    usage: 'production',
    engine: 'ffmpeg',
    platform: 'win32',
    architecture: 'x64',
    version: '8.1.2-example',
    files
  };
  const manifestPath = path.join(componentRoot, 'media-engine.json');
  const save = () => writeFile(manifestPath, JSON.stringify(manifest));
  await save();
  return {
    options: { resourcesPath, platform: 'win32', architecture: 'x64' },
    componentRoot, manifest, manifestPath, save
  };
}

describe('packaged media runtime', () => {
  it('locates both packaged tools after checking all binary hashes', async () => {
    const fixture = await packageFixture();
    const options = resolvePackagedMediaEngine(fixture.options);
    expect(options).toEqual({
      ffmpegPath: path.join(fixture.componentRoot, 'bin', 'ffmpeg.exe'),
      ffprobePath: path.join(fixture.componentRoot, 'bin', 'ffprobe.exe'),
      adapterVersion: '8.1.2-example'
    });
    const adapter = createRuntimeMediaEngine({ ...fixture.options, isPackaged: true });
    expect(adapter?.descriptor).toMatchObject({ adapterId: 'ffmpeg', adapterVersion: '8.1.2-example' });
  });

  it.each(['ffmpeg.exe', 'ffprobe.exe', 'avcodec.dll'])('rejects changed %s bytes', async (name) => {
    const fixture = await packageFixture();
    await writeFile(path.join(fixture.componentRoot, 'bin', name), 'changed');
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it.each([
    ['usage', 'development-only'],
    ['platform', 'darwin'],
    ['architecture', 'arm64'],
    ['schemaVersion', 2],
    ['version', 'line\nbreak']
  ])('rejects unsupported manifest %s', async (field, value) => {
    const fixture = await packageFixture();
    Object.assign(fixture.manifest, { [field]: value });
    await fixture.save();
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it.each(['../ffmpeg.exe', 'bin/../ffmpeg.exe', 'bin\\ffmpeg.exe', '/bin/ffmpeg.exe', 'bin/unapproved.exe'])
    ('rejects uncontrolled executable path %s', async (filePath) => {
      const fixture = await packageFixture();
      fixture.manifest.files[0].path = filePath;
      await fixture.save();
      expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
    });

  it('rejects missing tools, duplicate records, and unknown manifest fields', async () => {
    const fixture = await packageFixture();
    fixture.manifest.files.push({ ...fixture.manifest.files[0] });
    await fixture.save();
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
    fixture.manifest.files.pop();
    fixture.manifest.files.shift();
    await fixture.save();
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
    await writeFile(fixture.manifestPath, JSON.stringify({ ...fixture.manifest, command: 'uncontrolled' }));
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it('rejects an unlisted DLL beside the verified tools', async () => {
    const fixture = await packageFixture();
    await writeFile(path.join(fixture.componentRoot, 'bin', 'unexpected.dll'), 'injected');
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it('rejects redirected component directories', async () => {
    const fixture = await packageFixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'unicomp-media-outside-'));
    roots.push(outside);
    await rm(path.join(fixture.componentRoot, 'bin'), { recursive: true });
    await symlink(outside, path.join(fixture.componentRoot, 'bin'), 'junction');
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it('rejects malformed or oversized manifests without preventing app startup', async () => {
    const fixture = await packageFixture();
    await writeFile(fixture.manifestPath, '{');
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
    await writeFile(fixture.manifestPath, ' '.repeat(65 * 1024));
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });

  it('never falls back to development environment paths in an installed app', async () => {
    const fixture = await packageFixture();
    const environment = {
      UNICOMP_FFMPEG_PATH: path.join(fixture.componentRoot, 'bin', 'ffmpeg.exe'),
      UNICOMP_FFPROBE_PATH: path.join(fixture.componentRoot, 'bin', 'ffprobe.exe')
    };
    await rm(fixture.manifestPath);
    expect(createRuntimeMediaEngine({ ...fixture.options, isPackaged: true, environment })).toBeUndefined();
    expect(createRuntimeMediaEngine({ ...fixture.options, isPackaged: false, environment })?.descriptor.adapterId)
      .toBe('ffmpeg');
  });

  it('does not use the Windows x64 component on another platform or architecture', async () => {
    const fixture = await packageFixture();
    expect(resolvePackagedMediaEngine({ ...fixture.options, platform: 'darwin' })).toBeUndefined();
    expect(resolvePackagedMediaEngine({ ...fixture.options, architecture: 'arm64' })).toBeUndefined();
  });

  it('checks fresh bytes when validating again', async () => {
    const fixture = await packageFixture();
    expect(resolvePackagedMediaEngine(fixture.options)).toBeDefined();
    const target = path.join(fixture.componentRoot, 'bin', 'ffmpeg.exe');
    const bytes = await readFile(target);
    bytes[0] ^= 1;
    await writeFile(target, bytes);
    expect(resolvePackagedMediaEngine(fixture.options)).toBeUndefined();
  });
});
