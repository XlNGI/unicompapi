import { projectRoot, verifyHandoff } from './phase9-platform-common.mjs';

const result = await verifyHandoff(projectRoot);
console.log(JSON.stringify(result, null, 2));
if (result.failures.length > 0) process.exitCode = 1;
