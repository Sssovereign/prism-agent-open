/** Shared search catalog: settings and backend accept exactly the same providers. */
export const SEARCH_PROVIDER_OPTIONS = [
  { value: 'none', label: '不启用', description: '关闭关键词搜索；公开网页地址仍可直接读取。' },
  { value: 'bocha', label: '博查 Bocha', description: '使用博查网页搜索 API Key。', docsUrl: 'https://open.bochaai.com/' },
  { value: 'tavily', label: 'Tavily', description: '使用 Tavily 搜索服务 API Key。', docsUrl: 'https://docs.tavily.com/documentation/api-reference/endpoint/search' },
  { value: 'zhipu', label: '智谱 BigModel', description: '使用已开通联网搜索的智谱 API Key，搜索词最多70字符。', docsUrl: 'https://docs.bigmodel.cn/cn/guide/tools/web-search' },
  { value: 'zai', label: 'GLM 国际 Z.ai', description: '使用 Z.ai 的 API Key 调用 Web Search，与智谱国际站模型接口同一密钥。', docsUrl: 'https://docs.z.ai/guides/tools/web-search' },
  { value: 'qianfan', label: '百度千帆 AI 搜索', description: '使用千帆 API Key（与千帆模型接口同一密钥）获取百度搜索结果，搜索词最多72字符。', docsUrl: 'https://cloud.baidu.com/doc/qianfan-api/s/bmwbqlbad' },
  { value: 'kimi', label: 'Kimi 联网搜索', description: '使用 Kimi API Key（与月之暗面模型接口同一密钥）调用联网搜索 Basic，返回链接与摘要。', docsUrl: 'https://platform.kimi.com/docs/api/tools-search' },
  { value: 'deepseek', label: 'DeepSeek 搜索', description: '使用 DeepSeek API Key（与 DeepSeek 模型接口同一密钥）调用 Search API，搜索词最多128字符。', docsUrl: 'https://api-docs.deepseek.com/guides/search' },
  { value: 'brave', label: 'Brave Search', description: '使用 Brave Search API 的搜索订阅密钥。', docsUrl: 'https://api-dashboard.search.brave.com/documentation/services/web-search' },
  { value: 'exa', label: 'Exa', description: '使用 Exa 搜索 API Key，返回网页链接与相关摘录。', docsUrl: 'https://exa.ai/docs/reference/search' },
  { value: 'serper', label: 'Serper（Google 搜索）', description: '通过第三方 Serper 获取 Google 搜索结果，使用 Serper API Key。', docsUrl: 'https://serper.dev/' },
  { value: 'perplexity', label: 'Perplexity Search', description: '使用 Perplexity Search API Key；搜索接口返回链接与摘要。', docsUrl: 'https://docs.perplexity.ai/api-reference/search-post' },
] as const;
export type SearchProvider = typeof SEARCH_PROVIDER_OPTIONS[number]['value'];
export type EnabledSearchProvider = Exclude<SearchProvider, 'none'>;
export const SEARCH_PROVIDERS: SearchProvider[] = SEARCH_PROVIDER_OPTIONS.map(p => p.value);
export function isSearchProvider(value: unknown): value is SearchProvider {
  return typeof value === 'string' && SEARCH_PROVIDERS.includes(value as SearchProvider);
}
export interface SearchSettings {
  provider: SearchProvider;
  credentialStored: boolean;
  /** 引用的模型配置（其 API Key 复用为搜索 Key）；未引用为 null。 */
  sourceConfigId: string | null;
  sourceConfigName: string | null;
  /** 引用有效：配置启用、归属当前账号、Key 可读且地址仍映射到所选搜索服务。 */
  sourceValid: boolean;
}
export interface WebSearchToolResult {
  query: string; provider: EnabledSearchProvider;
  results: Array<{title: string; url: string; snippet: string}>;
  fetchedAt: string;
}

/** 模型 Key 复用映射：这些厂商的搜索端点与模型端点共用同一账号 API Key（按 base_url 主机名匹配，参考各家官方文档核实）。 */
export const SEARCH_KEY_REUSE: ReadonlyArray<{ provider: EnabledSearchProvider; host: string; label: string }> = [
  { provider: 'zhipu', host: 'open.bigmodel.cn', label: '智谱 BigModel' },
  { provider: 'zai', host: 'api.z.ai', label: 'GLM 国际 Z.ai' },
  { provider: 'qianfan', host: 'qianfan.baidubce.com', label: '百度千帆' },
  { provider: 'kimi', host: 'api.moonshot.cn', label: 'Kimi' },
  { provider: 'deepseek', host: 'api.deepseek.com', label: 'DeepSeek' },
  { provider: 'perplexity', host: 'api.perplexity.ai', label: 'Perplexity' },
];
/** 模型接口地址 → 可复用 Key 的搜索服务；不匹配返回 undefined（中转站/其他厂商一律不勾选）。 */
export function searchReuseForBaseUrl(baseUrl: string): { provider: EnabledSearchProvider; label: string } | undefined {
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase(); } catch { return undefined; }
  const match = SEARCH_KEY_REUSE.find(entry => host === entry.host || host.endsWith(`.${entry.host}`));
  return match ? { provider: match.provider, label: match.label } : undefined;
}

/** 套餐端点路径前缀：这些端点的 Key 属套餐计费体系，调不了同厂商主站按量计费的搜索 REST API
 *  （2026-11-17 智谱官方文档核实；ZCode 对这些端点的「原生联网搜索」有效是因为它走服务端代执行，棱镜走 REST，必须区分）。 */
const PLAN_ENDPOINT_PREFIXES: ReadonlyArray<{ host: string; pathPrefixes: string[] }> = [
  { host: 'open.bigmodel.cn', pathPrefixes: ['/api/anthropic', '/api/coding'] },
  { host: 'api.z.ai', pathPrefixes: ['/api/anthropic', '/api/coding'] },
];
/** 接口地址是否为套餐端点（其 Key 大概率调不了搜索 API）：true=勾选绑定后运行时会 401，须提示另配主站 Key。 */
export function isPlanModelEndpoint(baseUrl: string): boolean {
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return false; }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.replace(/\/+$/, '');
  return PLAN_ENDPOINT_PREFIXES.some(p => (host === p.host || host.endsWith(`.${p.host}`)) && p.pathPrefixes.some(prefix => path === prefix || path.startsWith(`${prefix}/`)));
}

/** 接口级搜索绑定的派生视图：勾选可用性与提示（view 下发，前端渲染徽章/警告）。 */
export interface SearchBindingInfo {
  /** 该接口地址可推导出搜索服务（勾选可用）。 */
  available: boolean;
  /** 推导出的搜索厂商与展示名（available=false 为 null）。 */
  provider: EnabledSearchProvider | null;
  label: string | null;
  /** 套餐端点警告：勾选后运行时大概率 401，须另配同厂商主站 Key 或换接口地址。 */
  planKeyWarning: boolean;
}
export function searchBindingForBaseUrl(baseUrl: string): SearchBindingInfo {
  const reuse = searchReuseForBaseUrl(baseUrl);
  return {
    available: !!reuse,
    provider: reuse?.provider ?? null,
    label: reuse?.label ?? null,
    planKeyWarning: !!reuse && isPlanModelEndpoint(baseUrl),
  };
}
