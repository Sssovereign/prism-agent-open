import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAssistantReceipts } from '../web/conversation/receipts.js';

test('助手回报：三种状态逐项解析，正文保留在body', () => {
  const text = '任务已完成，交付文档见 /tmp/out/report.md。\n\n【助手回报】\n1. 交付文档存在 — 已通过：已写入 /tmp/out/report.md，共5节\n2. 口径与结论一致 — 未通过：第3节口径与研究结论不符，已改为台账口径\n3. 汇总页脚格式 — 待人工确认：无程序化检查依据';
  const parsed = parseAssistantReceipts(text);
  assert.ok(parsed);
  assert.equal(parsed.body, '任务已完成，交付文档见 /tmp/out/report.md。');
  assert.equal(parsed.items.length, 3);
  assert.deepEqual(parsed.items.map(i => i.status), ['已通过', '未通过', '待人工确认']);
  assert.equal(parsed.items[0]!.item, '交付文档存在');
  assert.match(parsed.items[0]!.detail, /report\.md/);
  assert.match(parsed.items[1]!.detail, /口径/);
});

test('助手回报：无标记或无合法行时返回null，普通消息不受影响', () => {
  assert.equal(parseAssistantReceipts('普通答复，没有回报小节'), null);
  assert.equal(parseAssistantReceipts('【助手回报】\n这一节没有合法行'), null);
  const parsed = parseAssistantReceipts('结论如下【助手回报】\n1. 项 — 已通过：证据充分');
  assert.ok(parsed);
  assert.equal(parsed.body, '结论如下');
});
