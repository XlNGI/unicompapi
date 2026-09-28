import { readFile } from 'node:fs/promises';
import process from 'node:process';

const manifest = JSON.parse(await readFile(new URL('../config/plan-manifest.json', import.meta.url), 'utf8'));
const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const allowedStatuses = new Set(['planned', 'in_progress', 'blocked', 'passed', 'deferred', 'not_started']);
const expectedPhaseIds = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
const errors = [];

if (manifest.schemaVersion !== 1 || manifest.planId !== 'ppt-goal-pipeline') errors.push('plan manifest identity is invalid');
if (JSON.stringify(manifest.phases.map((phase) => phase.id)) !== JSON.stringify(expectedPhaseIds)) errors.push('phase order is invalid');
const requirementIds = new Set();
for (const phase of manifest.phases) {
  if (!allowedStatuses.has(phase.status)) errors.push(`${phase.id} has an invalid status`);
  if (!Array.isArray(phase.requirements) || phase.requirements.length === 0) errors.push(`${phase.id} has no requirement IDs`);
  for (const requirement of phase.requirements ?? []) {
    if (requirementIds.has(requirement)) errors.push(`duplicate requirement ID: ${requirement}`);
    requirementIds.add(requirement);
  }
}
for (const command of manifest.requiredCommands ?? []) {
  if (typeof packageJson.scripts?.[command] !== 'string') errors.push(`missing package script: ${command}`);
}
if (errors.length > 0) {
  console.error(JSON.stringify({ ok: false, errors }, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, planId: manifest.planId, phases: manifest.phases.length, requirements: requirementIds.size }, null, 2));
}
