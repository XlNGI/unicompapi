import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      // Repository snapshots under tmp/ are not maintained source tests.
      // Exclude them so path filters such as `tests/platform` cannot match
      // archived copies with the same test filenames.
      exclude: ['**/node_modules/**', '**/tmp/**', '**/temp/**', '**/dist/**']
    }
  })
);
