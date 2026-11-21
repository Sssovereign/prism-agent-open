// 运行身份解析：桌面宿主版本、业务包版本、运行时兼容标识与数据库结构版本。
// 桌面模式由 main.cjs 经环境变量注入（外置业务包激活时随之切换）；源码部署模式降级为
// 读工作区 package.json，宿主与兼容字段为 null。health 的 productVersion 沿用业务版本，保持旧字段兼容。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface HostIdentity {
    hostVersion: string | null;
    businessVersion: string;
    runtimeCompatibilityId: string | null;
    databaseSchemaVersion: number | null;
}

export function resolveBusinessVersion(cwd: string = process.cwd()): string {
    const fromEnv = process.env.PRISM_BUSINESS_VERSION;
    if (fromEnv && /^[\w.+-]{1,64}$/.test(fromEnv)) return fromEnv;
    try {
        const parsed = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')) as { version?: string };
        return typeof parsed.version === 'string' && parsed.version ? parsed.version : 'unknown';
    } catch {
        return 'unknown';
    }
}

export function resolveHostIdentity(cwd: string = process.cwd()): HostIdentity {
    const schemaFromEnv = Number(process.env.PRISM_DATABASE_SCHEMA_VERSION);
    return {
        hostVersion: process.env.PRISM_HOST_VERSION || null,
        businessVersion: resolveBusinessVersion(cwd),
        runtimeCompatibilityId: process.env.PRISM_RUNTIME_COMPAT || null,
        databaseSchemaVersion: Number.isInteger(schemaFromEnv) && schemaFromEnv > 0 ? schemaFromEnv : null,
    };
}
