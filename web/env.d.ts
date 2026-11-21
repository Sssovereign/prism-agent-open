// 构建期由 vite define 注入（vite.config.ts），指向构建时的 git 短SHA；非 git 工作区为 "unknown"。
declare const __BUILD_SHA__: string;
