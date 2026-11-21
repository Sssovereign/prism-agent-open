import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ComposerSubmissionLedger } from '../web/view-model/composerSubmission.js';

test('supplement retry reuses submission identity after an uncertain transport result', () => {
  let sequence = 0;
  const ledger = new ComposerSubmissionLedger(() => `submission-${++sequence}`);
  const draft = {scope:'task:a',revision:1,text:'补充内容'};
  assert.equal(ledger.claim(draft).clientMessageId, ledger.claim({...draft}).clientMessageId);
});
test('late acknowledgement never clears another task or a newer draft', () => {
  const ledger = new ComposerSubmissionLedger(() => 'stable-id');
  const claim = ledger.claim({scope:'task:a',revision:1,text:'原内容'});
  assert.equal(ledger.settle(claim,{scope:'task:b',revision:1,text:'原内容'}),false);
  assert.equal(ledger.settle(claim,{scope:'task:a',revision:2,text:'原内容'}),false);
  assert.equal(ledger.settle(claim,{scope:'task:a',revision:1,text:'新内容'}),false);
});
test('matching acknowledgement consumes only its unchanged draft and releases identity', () => {
  let sequence = 0;
  const ledger = new ComposerSubmissionLedger(() => `submission-${++sequence}`);
  const draft = {scope:'task:a',revision:3,text:'确定内容'};
  const claim = ledger.claim(draft);
  assert.equal(ledger.settle(claim,draft),true);
  assert.notEqual(ledger.claim(draft).clientMessageId,claim.clientMessageId);
});
