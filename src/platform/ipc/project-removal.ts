import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTerminalExecutionState } from '../../domain';
import {
  JsonConversationResponseExecutionRepository,
  JsonExecutionRepository,
  JsonProjectRepository,
  JsonProviderInvocationRepository
} from '../repositories';
import { NodeProjectStorage } from '../storage';
import type { ProjectCatalogEntry } from './project-catalog';

/** Only Host catalog entries can identify directories for the native trash API. */
export async function validateProjectTrashTarget(
  entry: ProjectCatalogEntry,
  entries: readonly ProjectCatalogEntry[],
  currentDirectory?: string,
  protectedDirectories: readonly string[] = []
): Promise<void> {
  const target = path.resolve(entry.rootDirectory);
  const info = await lstat(target);
  if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), target)) {
    throw new Error('Project trash target must be an ordinary directory');
  }
  // Reject broad roots and directories containing other registered/current projects.
  const protectedPaths = [path.parse(target).root, os.homedir(), process.cwd(), ...protectedDirectories,
    ...(currentDirectory ? [currentDirectory] : []),
    ...entries.filter(candidate => candidate.projectId !== entry.projectId).map(candidate => candidate.rootDirectory)];
  for (const protectedPath of protectedPaths) {
    if (contains(target, protectedPath)) throw new Error('Project trash target overlaps a protected directory');
    const canonical = await realpath(protectedPath).catch(() => protectedPath);
    if (contains(target, canonical)) throw new Error('Project trash target overlaps a protected directory');
  }
  const storage = new NodeProjectStorage(target);
  const project = await new JsonProjectRepository(storage, entry.projectId).load();
  if (!project || project.id !== entry.projectId) throw new Error('Project identity changed');
  const [executions, responses, invocations] = await Promise.all([
    new JsonExecutionRepository(storage).listAll(),
    new JsonConversationResponseExecutionRepository(storage, entry.projectId).list(),
    new JsonProviderInvocationRepository(storage, entry.projectId).list()
  ]);
  if (executions.some(execution => !isTerminalExecutionState(execution.state)) ||
    responses.some(response => response.state === 'pending' || response.state === 'streaming') ||
    invocations.some(invocation => !['completed', 'failed', 'cancelled', 'failed_before_submission'].includes(invocation.state))) {
    throw new Error('Project has unfinished operations');
  }
}

function samePath(left: string, right: string): boolean {
  return path.relative(left, right) === '';
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return !relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
