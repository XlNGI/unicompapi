import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ManagedProcessSupervisor } from '../../src/platform/runtime';

describe('ManagedProcessSupervisor', () => {
  it('uses structured arguments without shell interpretation', async () => {
    const supervisor = new ManagedProcessSupervisor();
    const argument = 'value && echo should-not-run';
    const result = await supervisor.start({
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.argv.at(-1) ?? "")', argument],
      timeoutMs: 5_000
    }).promise;

    expect(result.code).toBe(0);
    expect(result.terminationReason).toBeUndefined();
    expect(result.stdout).toBe(argument);
    expect(supervisor.activeCount).toBe(0);
  });

  it('marks timeouts explicitly and terminates the process', async () => {
    const supervisor = new ManagedProcessSupervisor();
    const result = await supervisor.start({
      command: process.execPath,
      args: ['-e', 'setInterval(() => undefined, 1000)'],
      timeoutMs: 100
    }).promise;

    expect(result.terminationReason).toBe('timed_out');
    expect(result.code === null || result.code !== 0).toBe(true);
    expect(supervisor.activeCount).toBe(0);
  });

  it('terminates descendants during shutdown', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'unicomp-process-tree-'));
    const marker = path.join(root, 'descendant-survived.txt');
    const descendant = [
      "const fs=require('node:fs')",
      `setTimeout(()=>fs.writeFileSync(${JSON.stringify(marker)},'alive'),1200)`,
      'setInterval(()=>undefined,1000)'
    ].join(';');
    const parent = [
      "const {spawn}=require('node:child_process')",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'})`,
      'setInterval(()=>undefined,1000)'
    ].join(';');
    const supervisor = new ManagedProcessSupervisor();

    supervisor.start({
      command: process.execPath,
      args: ['-e', parent],
      timeoutMs: 10_000
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await supervisor.terminateAll('shutdown');
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    expect(existsSync(marker)).toBe(false);
    expect(supervisor.activeCount).toBe(0);
    await rm(root, { recursive: true, force: true });
  }, 5_000);
});
