// eslint.config.mjs - Obsidian's recommended rules (what the community review checks).
import { defineConfig, globalIgnores } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';

export default defineConfig([
  globalIgnores(['main.js', 'node_modules', 'dist', 'tests/fixtures', 'esbuild.config.mjs', 'vitest.config.ts']),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ['eslint.config.*'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
]);
