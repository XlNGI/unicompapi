import {
  spawn as nodeSpawn,
  type ChildProcessByStdio
} from 'node:child_process';
import type { Readable } from 'node:stream';

export type ManagedProcessTerminationReason =
  | 'cancelled'
  | 'timed_out'
  | 'shutdown';

export interface ManagedProcessResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly terminationReason?: ManagedProcessTerminationReason;
}

export interface ManagedProcessRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly onStdout?: (chunk: string) => void;
}

export interface ManagedProcessHandle {
  readonly pid: number;
  readonly promise: Promise<ManagedProcessResult>;
  cancel(reason?: ManagedProcessTerminationReason): boolean;
}

type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    readonly shell: false;
    readonly windowsHide: true;
    readonly detached: boolean;
    readonly stdio: ['ignore', 'pipe', 'pipe'];
  }
) => ChildProcessByStdio<null, Readable, Readable>;

export class ManagedProcessSupervisor {
  private readonly active = new Set<ManagedProcessHandle>();

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly spawnProcess: SpawnProcess = (command, args, options) =>
      nodeSpawn(command, [...args], options)
  ) {}

  start(request: ManagedProcessRequest): ManagedProcessHandle {
    validateRequest(request);
    const child = this.spawnProcess(request.command, request.args, {
      shell: false,
      windowsHide: true,
      detached: this.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    if (!child.pid) throw new Error('Managed process did not receive a process id');

    let stdout = '';
    let stderr = '';
    let closed = false;
    let terminationReason: ManagedProcessTerminationReason | undefined;
    const maxStdoutBytes = request.maxStdoutBytes ?? 512_000;
    const maxStderrBytes = request.maxStderrBytes ?? 32_000;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout = boundedAppend(stdout, chunk, maxStdoutBytes);
      request.onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr = boundedAppend(stderr, chunk, maxStderrBytes);
    });

    let handle!: ManagedProcessHandle;
    const promise = new Promise<ManagedProcessResult>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        closed = true;
        resolve({
          code,
          signal,
          stdout,
          stderr,
          ...(terminationReason ? { terminationReason } : {})
        });
      });
    }).finally(() => {
      clearTimeout(timeout);
      this.active.delete(handle);
    });

    handle = {
      pid: child.pid,
      promise,
      cancel: (reason = 'cancelled') => {
        if (closed || terminationReason) return false;
        terminationReason = reason;
        terminateProcessTree(child, this.platform);
        return true;
      }
    };
    this.active.add(handle);
    const timeout = setTimeout(() => {
      handle.cancel('timed_out');
    }, request.timeoutMs);
    timeout.unref?.();
    return handle;
  }

  get activeCount(): number {
    return this.active.size;
  }

  async terminateAll(reason: ManagedProcessTerminationReason = 'shutdown'): Promise<void> {
    const handles = [...this.active];
    for (const handle of handles) handle.cancel(reason);
    await Promise.allSettled(handles.map((handle) => handle.promise));
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.active].map((handle) => handle.promise));
  }
}

function validateRequest(request: ManagedProcessRequest): void {
  if (!request.command.trim()) throw new TypeError('Managed process command is required');
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1) {
    throw new TypeError('Managed process timeout is invalid');
  }
  for (const argument of request.args) {
    if (typeof argument !== 'string' || argument.includes('\0')) {
      throw new TypeError('Managed process argument is invalid');
    }
  }
}

function boundedAppend(current: string, chunk: string, maximumBytes: number): string {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError('Managed process output limit is invalid');
  }
  if (maximumBytes === 0) return '';
  const combined = current + chunk;
  return combined.length <= maximumBytes
    ? combined
    : combined.slice(-maximumBytes);
}

function terminateProcessTree(
  child: ChildProcessByStdio<null, Readable, Readable>,
  platform: NodeJS.Platform
): void {
  if (!child.pid) return;
  if (platform === 'win32') {
    const killer = nodeSpawn(
      'taskkill.exe',
      ['/pid', String(child.pid), '/t', '/f'],
      { shell: false, windowsHide: true, stdio: 'ignore' }
    );
    killer.once('error', () => {
      child.kill('SIGTERM');
    });
    killer.once('close', (code) => {
      if (code !== 0) child.kill('SIGTERM');
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  const forceTimer = setTimeout(() => {
    if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }, 1_000);
  forceTimer.unref?.();
}
