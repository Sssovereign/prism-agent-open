import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCreateRun, validateSupplementInput, validateRunEvent, validateModelConfigInput } from '../src/contracts/schemas.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const ordinaryRun = {
  conversationId: uuid(1), problemVersionId: uuid(2), mode: 'ordinary',
  resources: [], grants: [],
  agents: [{ role: 'ordinary', modelConfigId: uuid(3), modelId: 'deepseek-chat' }],
  limitsProfile: 'standard-v1',
};
const debateRun = {
  conversationId: uuid(1), problemVersionId: uuid(2), mode: 'debate', rounds: 2,
  resources: [{ resourceId: uuid(3), version: 1 }],
  grants: [{ grantId: uuid(4), revision: 1 }],
  agents: [
    { role: 'pro', modelConfigId: uuid(5), modelId: 'deepseek-chat' },
    { role: 'con', modelConfigId: uuid(6), modelId: 'glm-4.7' },
    { role: 'host', modelConfigId: uuid(7), modelId: 'glm-4.7' },
  ],
  limitsProfile: 'standard-v1',
};

test('CreateRun 正例：ordinary 与 debate 均通过', () => {
  assert.equal(validateCreateRun(ordinaryRun).ok, true);
  assert.equal(validateCreateRun(debateRun).ok, true);
});

test('CreateRun 负例：辩论缺主持/角色重复/ordinary混入辩论角色均拒绝', () => {
  const noHost = { ...debateRun, agents: debateRun.agents.filter(a => a.role !== 'host') };
  assert.equal(validateCreateRun(noHost).ok, false);
  const dupCon = { ...debateRun, agents: [debateRun.agents[0], { role: 'con', modelConfigId: uuid(6), modelId: 'x' }, { role: 'con', modelConfigId: uuid(9), modelId: 'x' }] };
  assert.equal(validateCreateRun(dupCon).ok, false);
  const ordinaryInDebate = { ...debateRun, agents: [...debateRun.agents, { role: 'ordinary', modelConfigId: uuid(9), modelId: 'x' }] };
  assert.equal(validateCreateRun(ordinaryInDebate).ok, false);
});

test('RoleBindingInput：thinkingLevel 可选且枚举校验（max 合法、未知值拒绝）', () => {
  assert.equal(validateCreateRun({ ...ordinaryRun, agents: [{ ...ordinaryRun.agents[0], thinkingLevel: 'high' }] }).ok, true);
  assert.equal(validateCreateRun({ ...ordinaryRun, agents: [{ ...ordinaryRun.agents[0], thinkingLevel: 'max' }] }).ok, true);
  assert.equal(validateCreateRun({ ...ordinaryRun, agents: [{ ...ordinaryRun.agents[0], thinkingLevel: 'fake' }] }).ok, false);
  assert.equal(validateCreateRun({ ...ordinaryRun, agents: [{ ...ordinaryRun.agents[0], thinkingLevel: 3 }] }).ok, false);
});
test('CreateRun 负例：rounds 越界/unknown 字段/非法 UUID/普通模式带 rounds 拒绝', () => {
  for (const rounds of [0, 4, 2.5]) assert.equal(validateCreateRun({ ...debateRun, rounds }).ok, false);
  assert.equal(validateCreateRun({ ...ordinaryRun, extra: 1 }).ok, false);
  assert.equal(validateCreateRun({ ...debateRun, conversationId: 'not-a-uuid' }).ok, false);
  assert.equal(validateCreateRun({ ...ordinaryRun, rounds: 2 }).ok, false);
});

test('SupplementInput 正例与负例（kind 固定 supplement、resourceRefs ≤20、unknown 拒绝）', () => {
  const ok = { clientMessageId: uuid(10), content: '补充：以2024年报为准', kind: 'supplement' as const };
  assert.equal(validateSupplementInput(ok).ok, true);
  const refs = Array.from({ length: 21 }, (_, i) => ({ resourceId: uuid(100 + i), version: 1 }));
  assert.equal(validateSupplementInput({ ...ok, resourceRefs: refs }).ok, false);
  assert.equal(validateSupplementInput({ ...ok, resourceRefs: refs.slice(0, 20) }).ok, true);
  assert.equal(validateSupplementInput({ ...ok, kind: 'note' }).ok, false);
  assert.equal(validateSupplementInput({ ...ok, userId: 'u1' }).ok, false);
  assert.equal(validateSupplementInput({ ...ok, content: '' }).ok, false);
});

test('RunEvent 信封校验：合法事件通过，未知 type/缺 payload 拒绝', () => {
  const event = {
    schemaVersion: 'v1' as const, eventId: uuid(20), runId: uuid(1), seq: 1,
    at: '2026-11-10T15:00:00.000Z', type: 'run.created', visibility: 'public' as const, payload: {},
  };
  assert.equal(validateRunEvent(event).ok, true);
  assert.equal(validateRunEvent({ ...event, type: 'custom.unknown' }).ok, false);
  assert.equal(validateRunEvent({ ...event, seq: 0 }).ok, false);
});

test('ModelConfigInput：厂商预设全清单+custom 合法；未知 preset/空模型列表拒绝', () => {
  for (const preset of ['deepseek', 'glm-cn-coding', 'glm-cn-standard', 'glm-global-coding', 'glm-global-standard', 'qianfan', 'kimi', 'qwen', 'minimax', 'xiaomi', 'hunyuan', 'volcengine', 'stepfun', 'siliconflow', 'openai', 'anthropic', 'xai', 'openrouter', 'opencode', 'custom']) {
    const result = validateModelConfigInput({ preset, name: '测试', baseUrl: 'https://api.example.com', models: [{ modelId: 'm1', displayName: 'M1', enabled: true, parameters: {} }] });
    assert.equal(result.ok, true, preset);
  }
  assert.equal(validateModelConfigInput({ preset: 'not-a-vendor', name: 'x', baseUrl: 'https://x.com', models: [{ modelId: 'm', displayName: 'm', enabled: true, parameters: {} }] }).ok, false);
  assert.equal(validateModelConfigInput({ preset: 'deepseek', name: 'x', baseUrl: 'https://x.com', models: [] }).ok, false);
  assert.equal(validateModelConfigInput({ preset: 'deepseek', name: 'x', baseUrl: 'https://x.com', models: [{ modelId: 'm', displayName: 'm', enabled: true, parameters: {} }], apiKey: 'sk-leak' }).ok, false);
});
