import os from 'node:os';
import type { PerformanceSettings } from '../../domain';
import type {
  PerformanceTaskType,
  SettingsSystemStatusDto
} from '../../shared/settings-ipc';

export interface MachinePerformanceFacts {
  readonly logicalCpuCount: number;
  readonly totalMemoryBytes: number;
  readonly freeMemoryBytes: number;
  readonly loadAverageOneMinute: number | null;
}

export interface TaskPolicySnapshot {
  readonly createdAt: string;
  readonly mode: PerformanceSettings['mode'];
  readonly concurrency: Readonly<Record<PerformanceTaskType, number>>;
  readonly continueInBackground: boolean;
  readonly preventSleepWhileActive: boolean;
  readonly pauseOnLowBattery: boolean;
  readonly hardwareAcceleration: 'auto' | 'prefer_hardware' | 'software_only';
  readonly automaticSoftwareFallback: true;
  readonly appliesTo: 'new_task_or_attempt';
}

export class PerformancePolicyService {
  constructor(
    private readonly readFacts: () => MachinePerformanceFacts = systemFacts,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly activeTaskCount: () => Promise<number | null> = async () => null
  ) {}

  async getStatus(): Promise<SettingsSystemStatusDto['performance']> {
    const facts = normalizeFacts(this.readFacts());
    const maximums = calculateMaximums(facts);
    const recommendations = calculateRecommendations(facts, maximums);
    return {
      logicalCpuCount: facts.logicalCpuCount,
      totalMemoryBytes: facts.totalMemoryBytes,
      freeMemoryBytes: facts.freeMemoryBytes,
      currentLoadPercent: facts.loadAverageOneMinute === null
        ? null
        : Math.min(100, Math.max(0, Math.round(
          facts.loadAverageOneMinute / facts.logicalCpuCount * 100
        ))),
      activeTaskCount: await this.activeTaskCount(),
      recommendations,
      maximums,
      changesApplyTo: 'new_tasks_and_attempts'
    };
  }

  createSnapshot(
    performance: PerformanceSettings,
    hardwareAcceleration: TaskPolicySnapshot['hardwareAcceleration'],
    automaticSoftwareFallback: true
  ): TaskPolicySnapshot {
    const facts = normalizeFacts(this.readFacts());
    const maximums = calculateMaximums(facts);
    const recommendations = calculateRecommendations(facts, maximums);
    const multiplier = modeMultiplier(performance.mode);
    const concurrency = Object.fromEntries(
      taskTypes.map((taskType) => {
        const intent = concurrencyIntent(performance, taskType);
        const resolved = intent === 'auto'
          ? Math.max(1, Math.min(maximums[taskType], Math.round(recommendations[taskType] * multiplier)))
          : Math.max(1, Math.min(maximums[taskType], intent));
        return [taskType, resolved];
      })
    ) as Record<PerformanceTaskType, number>;
    return Object.freeze({
      createdAt: this.now(),
      mode: performance.mode,
      concurrency: Object.freeze(concurrency),
      continueInBackground: performance.continueInBackground,
      preventSleepWhileActive: performance.preventSleepWhileActive,
      pauseOnLowBattery: performance.pauseOnLowBattery,
      hardwareAcceleration,
      automaticSoftwareFallback,
      appliesTo: 'new_task_or_attempt'
    });
  }
}

const taskTypes: readonly PerformanceTaskType[] = [
  'online_generation',
  'local_image',
  'local_video',
  'downloads',
  'thumbnails'
];

function calculateMaximums(
  facts: MachinePerformanceFacts
): Readonly<Record<PerformanceTaskType, number>> {
  const memoryGiB = Math.max(1, facts.totalMemoryBytes / (1024 ** 3));
  return Object.freeze({
    online_generation: Math.max(1, Math.min(32, facts.logicalCpuCount * 2)),
    local_image: Math.max(1, Math.min(facts.logicalCpuCount, Math.floor(memoryGiB / 2))),
    local_video: Math.max(1, Math.min(Math.ceil(facts.logicalCpuCount / 2), Math.floor(memoryGiB / 4))),
    downloads: Math.max(1, Math.min(16, facts.logicalCpuCount * 2)),
    thumbnails: Math.max(1, Math.min(facts.logicalCpuCount, Math.floor(memoryGiB / 2)))
  });
}

function calculateRecommendations(
  facts: MachinePerformanceFacts,
  maximums: Readonly<Record<PerformanceTaskType, number>>
): Readonly<Record<PerformanceTaskType, number>> {
  const freeRatio = facts.totalMemoryBytes === 0
    ? 0.25
    : facts.freeMemoryBytes / facts.totalMemoryBytes;
  const memoryPressure = freeRatio < 0.15 ? 0.25 : freeRatio < 0.3 ? 0.5 : 1;
  return Object.freeze({
    online_generation: Math.max(1, Math.round(Math.min(4, maximums.online_generation) * memoryPressure)),
    local_image: Math.max(1, Math.round(Math.min(4, maximums.local_image) * memoryPressure)),
    local_video: Math.max(1, Math.round(Math.min(2, maximums.local_video) * memoryPressure)),
    downloads: Math.max(1, Math.round(Math.min(6, maximums.downloads) * memoryPressure)),
    thumbnails: Math.max(1, Math.round(Math.min(4, maximums.thumbnails) * memoryPressure))
  });
}

function concurrencyIntent(
  settings: PerformanceSettings,
  taskType: PerformanceTaskType
): 'auto' | number {
  const key = {
    online_generation: 'onlineGeneration',
    local_image: 'localImage',
    local_video: 'localVideo',
    downloads: 'downloads',
    thumbnails: 'thumbnails'
  }[taskType] as keyof PerformanceSettings['concurrency'];
  return settings.concurrency[key];
}

function modeMultiplier(mode: PerformanceSettings['mode']): number {
  if (mode === 'energy_saver') return 0.5;
  if (mode === 'high_performance') return 1.5;
  return 1;
}

function systemFacts(): MachinePerformanceFacts {
  const load = os.loadavg()[0];
  return {
    logicalCpuCount: os.availableParallelism?.() ?? os.cpus().length,
    totalMemoryBytes: os.totalmem(),
    freeMemoryBytes: os.freemem(),
    loadAverageOneMinute: process.platform === 'win32' || !Number.isFinite(load)
      ? null
      : load
  };
}

function normalizeFacts(facts: MachinePerformanceFacts): MachinePerformanceFacts {
  return {
    logicalCpuCount: Math.max(1, Math.floor(facts.logicalCpuCount)),
    totalMemoryBytes: Math.max(0, Math.floor(facts.totalMemoryBytes)),
    freeMemoryBytes: Math.max(0, Math.min(
      Math.floor(facts.freeMemoryBytes),
      Math.floor(facts.totalMemoryBytes)
    )),
    loadAverageOneMinute: facts.loadAverageOneMinute !== null &&
      Number.isFinite(facts.loadAverageOneMinute)
      ? Math.max(0, facts.loadAverageOneMinute)
      : null
  };
}
