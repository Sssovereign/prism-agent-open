// 厂商文档核实层（vendorFacts）测试：官方文档事实授信、未载明端点诚实降级、
// 与 pi-ai 目录的哨兵比对（漂移即失败，文档更全的有意分歧走白名单）。
// 事实出处与原文引用见 docs/vendor-facts/vendor-api-facts.json（访问日期 2026-11-14）。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {getBuiltinModels, getBuiltinProviders} from '@earendil-works/pi-ai/providers/all';
import {getSupportedThinkingLevels} from '@earendil-works/pi-ai/models';
import type {Api, Model} from '@earendil-works/pi-ai';
import {resolveThinkingCapability} from '../src/agent/modelCatalog.js';
import {resolveModelParameters} from '../src/models/parameterResolver.js';
import {VENDOR_ENDPOINT_FACTS} from '../src/agent/vendorFacts.js';
const normBase = (value: string): string => value.trim().replace(/\/+$/, '').toLowerCase();

test('vendor facts: documented endpoints grant per-model levels from official docs',()=>{
    for (const endpoint of VENDOR_ENDPOINT_FACTS) {
        if (endpoint.thinkingControl !== 'per-model') continue;
        for (const fact of endpoint.models ?? []) {
            const cap = resolveThinkingCapability(endpoint.protocol, endpoint.baseUrl, fact.modelId);
            assert.equal(cap.id, 'vendor-docs-v1', `${endpoint.baseUrl} ${fact.modelId}`);
            assert.equal(cap.verified, true, `${endpoint.baseUrl} ${fact.modelId}`);
            assert.deepEqual(cap.thinkingLevels, fact.levels, `${endpoint.baseUrl} ${fact.modelId}`);
            assert.deepEqual(cap.thinkingLevelMap, fact.levelMap, `${endpoint.baseUrl} ${fact.modelId}`);
            assert.equal(cap.temperature, fact.temperature, `${endpoint.baseUrl} ${fact.modelId}`);
            assert.equal(cap.vendorSource, 'vendor-docs', `${endpoint.baseUrl} ${fact.modelId}`);
            assert.ok(cap.vendorCompat, `${endpoint.baseUrl} ${fact.modelId} 应携带文档方言 compat`);
        }
    }
});

test('vendor facts: endpoint lookup normalizes case and trailing slash',()=>{
    const cap = resolveThinkingCapability('openai-completions', 'HTTPS://API.Moonshot.cn/v1/', 'kimi-k3.1-pro');
    assert.equal(cap.vendorSource, 'vendor-docs');
    assert.deepEqual(cap.thinkingLevels, ['low', 'high', 'max']);
});

test('vendor facts: anthropic-compatible endpoint without documented thinking control degrades honestly',()=>{
    // 智谱 Claude 兼容端点官方文档未载明 thinking/budget_tokens：不授予目录推断的档位
    const cap = resolveThinkingCapability('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3-flash');
    assert.equal(cap.verified, false);
    assert.deepEqual(cap.thinkingLevels, []);
    assert.equal(cap.vendorSource, 'vendor-docs-undocumented');
    // 存量显式档位不报错而是降级忽略（建单不失败，按模型默认思考执行）
    const resolved = resolveModelParameters('anthropic-messages', 'https://open.bigmodel.cn/api/anthropic', 'glm-5.3-flash', {thinkingLevel: 'max', contextWindow: 200000});
    assert.equal(resolved.effective.thinkingLevel, 'off');
    assert.equal(resolved.effective.reasoning, undefined);
    assert.ok(resolved.adjustments.some(a => a.field === 'thinkingLevel' && /未载明思考强度控制/.test(String(a.reason))));
});

test('vendor facts: resolver grants documented levels and honors vendor temperature gating',()=>{
    // kimi-k3.1-pro：effort low/high/max 放行（文档默认 max）
    const kimi = resolveModelParameters('openai-completions', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro', {thinkingLevel: 'max'});
    assert.equal(kimi.capability.id, 'vendor-docs-v1');
    assert.equal(kimi.effective.reasoning, 'max');
    // 目录声明 off:null（始终思考）→ 显式 off 拒绝
    assert.throws(() => resolveModelParameters('openai-completions', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro', {thinkingLevel: 'off'}), /思考级别支持/);
    // 文档要求 temperature 固定 1.0 勿显式传入 → 显式 temperature 拒绝
    assert.throws(() => resolveModelParameters('openai-completions', 'https://api.moonshot.cn/v1', 'kimi-k3.1-pro', {temperature: 0.7}), /temperature/);
    // glm-5.3-flash 标准端点：low 放行；temperature 文档未载限制 → 接受
    const glm = resolveModelParameters('openai-completions', 'https://open.bigmodel.cn/api/paas/v4', 'glm-5.3-flash', {thinkingLevel: 'low', temperature: 1});
    assert.equal(glm.effective.reasoning, 'low');
    assert.equal(glm.effective.temperature, 1);
});

test('vendor facts: mistyped baseUrl still refuses to guess (original kimi failure mode stays honest)',()=>{
    // 用户曾误配 /v1/responses 后缀：不在事实层与目录端点索引中，同 id 全目录结论冲突（radius 带 off 档）
    // → 回落正则 → unverified，无思考档位（滑杆不渲染）——修复方式是改对端点，不是模糊匹配
    const cap = resolveThinkingCapability('openai-completions', 'https://api.moonshot.cn/v1/responses', 'kimi-k3.1-pro');
    assert.equal(cap.verified, false);
    assert.deepEqual(cap.thinkingLevels, []);
});

test('vendor facts sentinel: curated facts agree with pi-ai catalog; intentional divergences whitelisted',()=>{
    // 目录条目按 baseUrl+id 查找；文档更全的有意分歧显式白名单（记录原因，防目录升级悄悄漂移）
    const intentionalDivergence = new Set([
        // glm-5.2：目录保守（off/high/max），官方文档载明全枚举与映射（low/medium→high、xhigh→max、none/minimal=放弃思考）
        'https://open.bigmodel.cn/api/paas/v4|glm-5.2',
        // deepseek-flash：目录把 minimal/medium 标 null（拒绝档位），文档载明兼容映射 minimal→low、medium/xhigh→high；级别结论一致
        'https://api.deepseek.com|deepseek-flash',
        // deepseek-v4-pro：目录缺 low 档，文档载明 effort 枚举两模型一致（none/low/high/max）
        'https://api.deepseek.com|deepseek-v4-pro',
    ]);
    const problems: string[] = [];
    for (const endpoint of VENDOR_ENDPOINT_FACTS) {
        if (endpoint.thinkingControl !== 'per-model') continue;
        for (const fact of endpoint.models ?? []) {
            const key = `${normBase(endpoint.baseUrl)}|${fact.modelId}`;
            const hits: Model<Api>[] = [];
            for (const provider of getBuiltinProviders()) {
                for (const model of getBuiltinModels(provider)) {
                    if (normBase(model.baseUrl) === normBase(endpoint.baseUrl) && model.id.toLowerCase() === fact.modelId)
                        hits.push(model);
                }
            }
            if (hits.length === 0) continue; // 目录未收录该端点：容忍（事实层本来就是更高等级的证据）
            for (const hit of hits) {
                if (JSON.stringify(hit.thinkingLevelMap ?? null) !== JSON.stringify(fact.levelMap) && !intentionalDivergence.has(key))
                    problems.push(`${key}: 目录映射 ${JSON.stringify(hit.thinkingLevelMap ?? null)} ≠ 文档映射 ${JSON.stringify(fact.levelMap)}`);
                const levels = hit.reasoning ? getSupportedThinkingLevels(hit) : [];
                if (!intentionalDivergence.has(key) && JSON.stringify(levels) !== JSON.stringify(fact.levels))
                    problems.push(`${key}: 目录级别 ${JSON.stringify(levels)} ≠ 文档级别 ${JSON.stringify(fact.levels)}`);
            }
        }
    }
    assert.deepEqual(problems, []);
});

test('vendor facts: documented endpoints carry every fact source with access date and quote',()=>{
    for (const endpoint of VENDOR_ENDPOINT_FACTS) {
        assert.ok(endpoint.sources.length > 0, `${endpoint.baseUrl} 应有来源`);
        for (const source of endpoint.sources) {
            assert.match(source.url, /^https?:\/\//, source.topic);
            assert.match(source.accessed, /^\d{4}-\d{2}-\d{2}$/, source.topic);
            assert.ok(source.quote.length > 0, source.topic);
        }
    }
});
