// 供应商识别→品牌资产：身份来自 pi 目录 provider 字段（服务端 view.providerId 下发，
// 见 modelCatalog.resolveModelProvider）。只取 ZCode provider-icons 打包素材（明暗变体语义同上游
// openrouter/opencode 双素材）；ZCode 未覆盖的供应商无品牌资产，由调用方回落 package 图标。
import deepseekIcon from './assets/provider-icons/model-provider-deepseek.png';
import zaiIcon from './assets/provider-icons/model-provider-zai.png';
import anthropicIcon from './assets/provider-icons/model-provider-anthropic.png';
import openaiIcon from './assets/provider-icons/model-provider-openai.png';
import kimiIcon from './assets/provider-icons/model-provider-moonshot-kimi.png';
import minimaxIcon from './assets/provider-icons/model-provider-minimax.png';
import xiaomiIcon from './assets/provider-icons/model-provider-xiaomi-mimo.png';
import alibabaIcon from './assets/provider-icons/model-provider-alibaba-cloud.png';
import xaiIcon from './assets/provider-icons/model-provider-xai.png';
import tencentIcon from './assets/provider-icons/model-provider-tencent-cloud.png';
import volcengineIcon from './assets/provider-icons/model-provider-volcengine.png';
import stepfunIcon from './assets/provider-icons/model-provider-stepfun.png';
import siliconflowIcon from './assets/provider-icons/model-provider-siliconflow.png';
import openrouterLight from './assets/provider-icons/model-provider-openrouter-light.svg';
import openrouterDark from './assets/provider-icons/model-provider-openrouter-dark.svg';
import opencodeLight from './assets/provider-icons/model-provider-opencode-light.svg';
import opencodeDark from './assets/provider-icons/model-provider-opencode-dark.svg';

export interface ProviderAsset { light: string; dark?: string }

const PROVIDERS: Array<{ test: RegExp; asset: ProviderAsset }> = [
  { test: /^deepseek/, asset: { light: deepseekIcon } },
  { test: /^zai|^bigmodel|^glm/, asset: { light: zaiIcon } },
  { test: /^anthropic/, asset: { light: anthropicIcon } },
  { test: /^openai/, asset: { light: openaiIcon } },
  { test: /^moonshot|^kimi/, asset: { light: kimiIcon } },
  { test: /^minimax/, asset: { light: minimaxIcon } },
  { test: /^xiaomi/, asset: { light: xiaomiIcon } },
  { test: /^qwen|^alibaba|^dashscope/, asset: { light: alibabaIcon } },
  { test: /^xai/, asset: { light: xaiIcon } },
  { test: /^openrouter/, asset: { light: openrouterLight, dark: openrouterDark } },
  { test: /^opencode/, asset: { light: opencodeLight, dark: opencodeDark } },
  { test: /^tencent/, asset: { light: tencentIcon } },
  { test: /^volcengine/, asset: { light: volcengineIcon } },
  { test: /^stepfun/, asset: { light: stepfunIcon } },
  { test: /^siliconflow/, asset: { light: siliconflowIcon } },
];

export function resolveProviderAsset(providerId: string | null | undefined): ProviderAsset | null {
  if (!providerId) return null;
  const id = providerId.trim().toLocaleLowerCase();
  return PROVIDERS.find(entry => entry.test.test(id))?.asset ?? null;
}

// 端点主机提示：pi 目录按端点精确匹配 + 同 id 多家收录时不猜（能力结论保持保守），
// 品牌展示另用 baseUrl 主机兜底——如 glm-5.3-flash 在 open.bigmodel.cn 的 anthropic/standard
// 端点解析不出唯一 providerId，但主机本身就指向厂商。仅用于选图标，不回写能力。
const HOST_PROVIDERS: Array<{ test: RegExp; asset: ProviderAsset }> = [
  { test: /bigmodel|\.z\.ai|(^|\.)zai\./, asset: { light: zaiIcon } },
  { test: /deepseek/, asset: { light: deepseekIcon } },
  { test: /anthropic/, asset: { light: anthropicIcon } },
  { test: /openai/, asset: { light: openaiIcon } },
  { test: /moonshot|kimi/, asset: { light: kimiIcon } },
  { test: /minimax/, asset: { light: minimaxIcon } },
  { test: /xiaomi/, asset: { light: xiaomiIcon } },
  { test: /dashscope|alibaba|aliyun/, asset: { light: alibabaIcon } },
  { test: /(^|\.)x\.ai|xai/, asset: { light: xaiIcon } },
  { test: /tencent/, asset: { light: tencentIcon } },
  { test: /volcengine/, asset: { light: volcengineIcon } },
  { test: /stepfun/, asset: { light: stepfunIcon } },
  { test: /siliconflow/, asset: { light: siliconflowIcon } },
  { test: /openrouter/, asset: { light: openrouterLight, dark: openrouterDark } },
  { test: /opencode/, asset: { light: opencodeLight, dark: opencodeDark } },
];

export function resolveProviderAssetFor(providerId: string | null | undefined, baseUrl?: string | null): ProviderAsset | null {
  return resolveProviderAsset(providerId)
    ?? (baseUrl
      ? HOST_PROVIDERS.find(entry => { try { return entry.test.test(new URL(baseUrl).hostname.toLowerCase()); } catch { return false; } })?.asset ?? null
      : null);
}
