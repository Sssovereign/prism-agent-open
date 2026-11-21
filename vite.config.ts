import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// 构建期注入当前源码SHA：前端与 /api/v1/health 的 sourceSha 比对，不一致即提示刷新。
// 非 git 工作区（历史快照直接构建）降级为 unknown，前端按 unknown 不提示。
function gitShortSha(): string {
  if (process.env.PRISM_SOURCE_SHA) return process.env.PRISM_SOURCE_SHA.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

export default defineConfig({
  root: 'web', plugins: [vue()],
  define: { __BUILD_SHA__: JSON.stringify(gitShortSha()) },
  build: { outDir: '../web-dist', emptyOutDir: true },
});
