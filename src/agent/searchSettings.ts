import type { Db } from '../storage/db.js';
import { ApiError } from '../../contracts/errors.js';
import { SEARCH_PROVIDERS, searchWeb, type SearchProvider } from './webTools.js';
import { searchReuseForBaseUrl, type SearchSettings } from '../../contracts/search.js';

/** Search settings and credentials are account-owned and persisted locally.
 *  Key 来源两轨：独立搜索 Key（本表+local_search_credentials）或引用模型配置的 Key（source_config_id）。 */
import { dirname, join } from 'node:path';
import { LocalCredentialStore } from '../models/localCredentialStore.js';
const stores=new WeakMap<Db,LocalCredentialStore>();
function store(db:Db):LocalCredentialStore{let value=stores.get(db);if(!value){value=new LocalCredentialStore(db,join(dirname(db.path),'credential-master.key'));stores.set(db,value);}return value;}
export function setSearchCredential(db:Db,userId:string,apiKey:string):void{
 const trimmed=apiKey.trim();if(!trimmed){clearSearchCredential(db,userId);return;}
 if(trimmed.length>512||/[\s\x00-\x1f\x7f]/.test(trimmed))throw new ApiError('VALIDATION_FAILED','API Key 格式无效');
 store(db).writeSearch(userId,trimmed);
}
export function clearSearchCredential(db:Db,userId:string):void{store(db).clearSearch(userId);}
export function hasSearchCredential(db:Db,userId:string):boolean{return !!store(db).readSearch(userId);}
export function peekSearchCredential(db:Db,userId:string):string|undefined{return store(db).readSearch(userId);}

interface SourceRow { sourceConfigId: string | null; sourceName: string | null; sourceBaseUrl: string | null; sourceEnabled: number | null }
export function getSearchSettings(db: Db, userId: string): SearchSettings {
    const row = db.db.prepare('SELECT provider FROM search_settings WHERE user_id=?').get(userId) as { provider: string } | undefined;
    const provider = row?.provider as SearchProvider | undefined;
    const settingsProvider = provider && SEARCH_PROVIDERS.includes(provider) ? provider : 'none';
    const source = db.db.prepare(`SELECT ss.source_config_id AS sourceConfigId, c.name AS sourceName, c.base_url AS sourceBaseUrl, c.enabled AS sourceEnabled
        FROM search_settings ss LEFT JOIN model_configs c ON c.id=ss.source_config_id AND c.owner_user_id=ss.user_id WHERE ss.user_id=?`).get(userId) as SourceRow | undefined;
    const sourceConfigId = source?.sourceConfigId ?? null;
    let sourceValid = false;
    if (sourceConfigId && settingsProvider !== 'none' && source?.sourceEnabled === 1 && searchReuseForBaseUrl(source.sourceBaseUrl ?? '')?.provider === settingsProvider) {
        sourceValid = !!store(db).readModel(userId, sourceConfigId);
    }
    return {
        provider: settingsProvider,
        credentialStored: hasSearchCredential(db,userId),
        sourceConfigId,
        sourceConfigName: sourceConfigId ? source?.sourceName ?? null : null,
        sourceValid,
    };
}

/** 引用校验：本人接口、已启用、地址主机名映射到所选搜索服务。 */
function validateSearchSource(db: Db, userId: string, provider: SearchProvider, configId: string): void {
    const row = db.db.prepare('SELECT base_url,enabled,owner_user_id FROM model_configs WHERE id=?').get(configId) as { base_url: string; enabled: number; owner_user_id: string } | undefined;
    if (!row || row.owner_user_id !== userId) throw new ApiError('NOT_FOUND', '接口不存在或无权访问');
    if (provider === 'none') throw new ApiError('VALIDATION_FAILED', '未启用搜索服务时不能引用模型接口');
    if (row.enabled !== 1) throw new ApiError('VALIDATION_FAILED', '该接口已停用，请先启用再勾选连通搜索');
    if (searchReuseForBaseUrl(row.base_url)?.provider !== provider) throw new ApiError('VALIDATION_FAILED', '该接口的 API 地址与所选搜索服务不匹配，无法复用其 Key');
}

export function setSearchProvider(db: Db, userId: string, provider: SearchProvider, sourceConfigId?: string | null): SearchSettings {
    if (!SEARCH_PROVIDERS.includes(provider)) throw new ApiError('VALIDATION_FAILED', '搜索服务不存在');
    const previous=getSearchSettings(db,userId);
    const switchClear = provider === 'none' || provider !== previous.provider;
    // 未显式给出时沿旧语义：换厂商/关闭清引用；显式 null=解除引用，显式串=设置引用
    const nextSource = sourceConfigId === undefined ? (switchClear ? null : previous.sourceConfigId) : sourceConfigId;
    if (nextSource) validateSearchSource(db, userId, provider, nextSource);
    const now = new Date().toISOString();
    db.tx(tx => {
        tx.prepare(`INSERT INTO search_settings(user_id,provider,source_config_id,updated_at) VALUES (?,?,?,?)
            ON CONFLICT(user_id) DO UPDATE SET provider=excluded.provider, source_config_id=excluded.source_config_id, updated_at=excluded.updated_at`)
            .run(userId, provider, nextSource, now);
    });
    if (switchClear) clearSearchCredential(db,userId);
    return getSearchSettings(db, userId);
}

export function clearSearchSource(db: Db, userId: string): void {
    db.db.prepare('UPDATE search_settings SET source_config_id=NULL, updated_at=? WHERE user_id=?').run(new Date().toISOString(), userId);
}

/** Key 解析：引用的模型配置优先，独立搜索 Key 兜底；引用失效时给出指路文案而非静默降级。 */
export function resolveSearchKey(db: Db, userId: string): { key: string; source: 'reference' | 'standalone' } {
    const settings = getSearchSettings(db, userId);
    if (settings.sourceConfigId && settings.sourceValid) {
        const key = store(db).readModel(userId, settings.sourceConfigId);
        if (key) return { key, source: 'reference' };
        throw new ApiError('SEARCH_NOT_CONFIGURED', '联网搜索引用的模型接口 Key 不可用：请在「模型接口」重新保存 Key');
    }
    if (settings.sourceConfigId) throw new ApiError('SEARCH_NOT_CONFIGURED', '联网搜索引用的模型接口已停用、地址已变更或 Key 已清除：请在「模型接口」重新保存，或在联网搜索设置解除引用');
    const apiKey = peekSearchCredential(db,userId);
    if (!apiKey) throw new ApiError('SEARCH_NOT_CONFIGURED', '搜索 API Key 未保存：请在设置→联网搜索填写并保存，或在模型接口勾选「用此接口的 Key 连通联网搜索」');
    return { key: apiKey, source: 'standalone' };
}

/** 本次任务所用接口的勾选解析（学 ZCode 能力位）：已勾选且启用 → 复用该接口 Key；未勾选/停用 → null（回落全局设置）。 */
export function resolveRunSearchBinding(db: Db, userId: string, runBinding: { configId: string; baseUrl: string }): { provider: Exclude<SearchProvider, 'none'>; key: string; source: 'run-binding' } | null {
    const row = db.db.prepare('SELECT search_provider,enabled,owner_user_id FROM model_configs WHERE id=?').get(runBinding.configId) as { search_provider: string | null; enabled: number; owner_user_id: string } | undefined;
    if (!(row && row.owner_user_id === userId && row.enabled === 1 && row.search_provider && SEARCH_PROVIDERS.includes(row.search_provider as SearchProvider) && row.search_provider !== 'none')) return null;
    const provider = row.search_provider as Exclude<SearchProvider, 'none'>;
    // 勾选时的地址推导一致性：接口地址变更会联动清空（routes PATCH），此处兜底校验防止残留错配
    if (searchReuseForBaseUrl(runBinding.baseUrl)?.provider !== provider)
        throw new ApiError('SEARCH_NOT_CONFIGURED', '该接口的联网搜索绑定已因地址变更失效：请重新保存接口配置');
    const key = store(db).readModel(userId, runBinding.configId);
    if (!key) throw new ApiError('SEARCH_NOT_CONFIGURED', '联网搜索引用的模型接口 Key 不可用：请在「模型接口」重新保存 Key');
    return { provider, key, source: 'run-binding' };
}

/** web_search 工具入口：无 provider/key 时给出明确错误（不静默降级为空结果）。
 *  解析顺序（学 ZCode 能力勾选语义）：①本次任务所用接口已勾选联网搜索（model_configs.search_provider）→ 复用该接口 Key；
 *  ②接口未勾选 → 回落全局搜索设置；③都无 → 明确报错。 */
export async function searchWebForUser(db: Db, userId: string, query: string, count: number, runBinding?: { configId: string; baseUrl: string }): Promise<ReturnType<typeof searchWeb>> {
    if (runBinding) {
        const bound = resolveRunSearchBinding(db, userId, runBinding);
        if (bound) return searchWeb(bound.provider, bound.key, query, count);
    }
    const settings = getSearchSettings(db, userId);
    if (settings.provider === 'none') throw new ApiError('SEARCH_NOT_CONFIGURED', '未配置联网搜索服务：请在设置→联网搜索选择服务并填写 API Key，或在模型接口勾选「为该接口启用联网搜索」');
    const { key } = resolveSearchKey(db, userId);
    return searchWeb(settings.provider, key, query, count);
}

/** attempt 启动时冻结的搜索可用性（决定 runner 是否向模型下发 web_search 工具，学 ZCode shouldExposeWebSearch）：
 *  接口已勾选即视为可用（Key 缺失留给调用时报错指路），否则看全局设置。 */
export function webSearchAvailableForBinding(db: Db, userId: string, runBinding?: { configId: string; baseUrl: string }): boolean {
    if (runBinding) {
        const row = db.db.prepare('SELECT search_provider,enabled,owner_user_id FROM model_configs WHERE id=?').get(runBinding.configId) as { search_provider: string | null; enabled: number; owner_user_id: string } | undefined;
        if (row && row.owner_user_id === userId && row.enabled === 1 && row.search_provider && row.search_provider !== 'none') return true;
    }
    return getSearchSettings(db, userId).provider !== 'none';
}
