import { auditPlatformAssumptions, projectRoot } from './phase9-platform-common.mjs';

const result = await auditPlatformAssumptions(projectRoot);
console.log(JSON.stringify(result, null, 2));
if (result.violations.length > 0) process.exitCode = 1;
