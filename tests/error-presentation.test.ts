import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_ERROR_CODES } from '../contracts/errors.js';
import { describeApiError, stopReasonText, formatErrorCopyText, ERROR_CODE_PRESETS } from '../web/ui/errorPresentation.js';
import { ApiError, v1 } from '../web/api.js';
import { applyLanguage } from '../web/ui/i18n/index.js';
// 本文件断言的是中文呈现契约（node 环境默认语言解析可能落到 en），先固定到 zh。
applyLanguage('zh');

test('presentation map covers every server ErrorCode (新增码必须显式登记呈现决策)', () => {
  const missing = ALL_ERROR_CODES.filter(code => !(code in ERROR_CODE_PRESETS));
  assert.deepEqual(missing, [], `未登记呈现决策的错误码: ${missing.join(', ')}`);
  const unknownKeys = Object.keys(ERROR_CODE_PRESETS).filter(code => !ALL_ERROR_CODES.includes(code as never));
  assert.deepEqual(unknownKeys, [], `映射表包含契约中不存在的码: ${unknownKeys.join(', ')}`);
});

test('describeApiError maps codes to recovery actions and keeps server message priority', () => {
  const credential = describeApiError(new ApiError('CREDENTIAL_REQUIRED', '网关缺少模型凭据', 422));
  assert.equal(credential.message, '网关缺少模型凭据');
  assert.equal(credential.action?.kind, 'open-model-settings');
  assert.equal(credential.action?.label, '打开模型设置');

  const expired = describeApiError(new ApiError('SESSION_EXPIRED', '未登录或会话已过期', 401));
  assert.equal(expired.action?.kind, 'login');

  const validation = describeApiError(new ApiError('VALIDATION_FAILED', 'limit 须为1—100整数', 400));
  assert.equal(validation.message, 'limit 须为1—100整数');
  assert.equal(validation.action, undefined);

  const rate = describeApiError(new ApiError('PROVIDER_RATE_LIMIT', '请求过于频繁', 429, { retryable: true }));
  assert.equal(rate.retryable, true);

  const requestId = describeApiError(new ApiError('INTERNAL_ERROR', '内部错误', 500, { requestId: 'req-1' }));
  assert.equal(requestId.requestId, 'req-1');
});

test('describeApiError falls back for non-ApiError values', () => {
  assert.equal(describeApiError(new Error('网络中断')).message, '网络中断');
  assert.equal(describeApiError('字符串错误').message, '字符串错误');
  assert.equal(describeApiError(undefined, '操作失败').message, '操作失败');
  assert.equal(describeApiError(new Error(''), '创建失败').message, '创建失败');
  assert.equal(describeApiError(new Error('x')).retryable, false);
});

test('explicit non-retryable API errors stay non-retryable and expose public details', () => {
  const error = new ApiError('PROVIDER_ERROR', '请求格式不受支持', 502, { retryable: false, details: { reason: 'unsupported format' } });
  assert.equal(describeApiError(error).retryable, false);
  assert.match(describeApiError(error).detail ?? '', /unsupported format/);
  assert.equal(describeApiError(new ApiError('PROVIDER_ERROR', '临时错误', 502)).retryable, true);
});

test('API envelope keeps explicit retryability, details and correlation ID', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({error:{code:'PROVIDER_ERROR',message:'unsupported format',retryable:false,details:{reason:'unsupported format'}},requestId:'req-acceptance'}),{status:502}));
  await assert.rejects(v1('/fixture'), error => {
    assert.ok(error instanceof ApiError);
    const presentation=describeApiError(error);
    assert.equal(presentation.retryable,false);
    assert.equal(presentation.requestId,'req-acceptance');
    assert.match(presentation.detail??'',/unsupported format/);
    return true;
  });
});

test('stopReasonText covers supervisor terminal values and classifier values without raw passthrough', () => {
  const known = [
    'completed', 'user_requested', 'CREDENTIAL_REQUIRED', 'RUNNER_EXITED', 'RUNNER_SPAWN_FAILED',
    'WORKER_CHANNEL_CLOSED', 'INTERRUPTED_RESTART', 'budget_exceeded', 'FORK_HISTORY', 'MIGRATION_DEDUP',
    'CONTEXT_LIMIT_EXCEEDED', 'MODEL_QUOTA_EXCEEDED', 'PROVIDER_RATE_LIMIT', 'MODEL_TIMEOUT', 'PROVIDER_ERROR',
  ];
  for (const reason of known) assert.notEqual(stopReasonText(reason), reason, `缺少文案: ${reason}`);
  assert.equal(stopReasonText('CREDENTIAL_REQUIRED'), '需要更新模型连接');
  assert.equal(stopReasonText('PROVIDER_ERROR'), '模型服务返回错误');
  assert.equal(stopReasonText('INTERRUPTED_RESTART'), '服务重启时任务被中断');
  assert.equal(stopReasonText('SOME_FUTURE_CODE'), 'SOME_FUTURE_CODE');
  assert.equal(stopReasonText(null), '');
});

test('formatErrorCopyText assembles message, code, requestId and runId, omitting absent fields', () => {
  const full = formatErrorCopyText({ message: '请求失败', code: 'PROVIDER_ERROR', requestId: 'req-9', runId: 'run-3' });
  const lines = full.split('\n');
  assert.equal(lines[0], '错误：请求失败');
  assert.ok(lines.includes('错误码：PROVIDER_ERROR'));
  assert.ok(lines.includes('requestId：req-9'));
  assert.ok(lines.includes('runId：run-3'));
  assert.deepEqual(formatErrorCopyText({ message: '仅文案' }).split('\n'), ['错误：仅文案']);
});
