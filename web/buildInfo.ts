// 构建身份：当前前端bundle对应的源码SHA。运行时 typeof 兜底，避免无define环境（如纯tsc检查）抛引用错误。
declare const __BUILD_SHA__: string;

export const buildSha: string = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown';
