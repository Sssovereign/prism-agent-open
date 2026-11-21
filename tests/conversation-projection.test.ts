import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectTurn, mergeEvents } from '../web/conversation/project.js';
import { parseMarkdown, safeHref, type MarkdownNode } from '../web/conversation/markdown.js';
import { atBottom, followingAfterScroll, prependTop } from '../web/conversation/scroll.js';
import type { ConversationRun, ConversationEvent } from '../contracts/conversation.js';
const event=(seq:number,type:string,payload:Record<string,unknown>):ConversationEvent=>({seq,type,payload});
const run=(events:ConversationEvent[]=[],status='running'):ConversationRun=>({id:'r',mode:'ordinary',status,createdAt:'2026-11-12T00:00:00Z',messages:[],events,tools:[],approvals:[],throughSeq:events.at(-1)?.seq??0});
const all=(r:ConversationRun)=>projectTurn(r).segments.flatMap(s=>s.rows);
test('assistant completed preserves intermediate body and stable row, replay does not duplicate',()=>{
 const events=[event(1,'message.delta',{messageId:'a',content:'读取'}),event(2,'message.completed',{role:'assistant',messageId:'a',content:'读取之前的完整说明'}),event(3,'tool.started',{invocationId:'t',tool:'read_file'}),event(4,'message.delta',{messageId:'b',content:'继续'})];
 const r=run(mergeEvents(events.slice(2),[...events,...events]));
 assert.deepEqual(all(r).map(r=>r.id),['a','t','b']);
 const text=all(r).find(r=>r.id==='a');assert.equal(text?.kind==='assistant'&&text.text,'读取之前的完整说明');assert.equal(text?.kind==='assistant'&&text.streaming,false);
});
test('pi auto-retry: empty failed attempt completion does not leave a ghost assistant row',()=>{
 const events=[event(1,'agent.started',{}),event(2,'message.completed',{role:'assistant',messageId:'a1',content:'',stopReason:'error',errorMessage:'fetch failed: ECONNRESET'}),event(3,'run.retry_scheduled',{retry:1,maxRetries:2,delayMs:2000,message:'fetch failed: ECONNRESET'}),event(4,'message.delta',{messageId:'a2',content:'重试后的'}),event(5,'message.completed',{role:'assistant',messageId:'a2',content:'重试后的完整答复',stopReason:'stop'})];
 const r=run(events);
 assert.deepEqual(all(r).map(r=>r.id),['a2']);
 // 迟到增量对已跳过的失败id仍被抑制（completedMessages登记不因跳行失效）
 const stale=run(mergeEvents([events[1]!],[...events,event(6,'message.delta',{messageId:'a1',content:'幽灵'})]));
 assert.deepEqual(all(stale).map(r=>r.id),['a2']);
 // 有正文的失败attempt（流中断）保留部分内容可见
 const partial=run([event(1,'message.delta',{messageId:'a1',content:'部分'}),event(2,'message.completed',{role:'assistant',messageId:'a1',content:'部分',stopReason:'error'}),event(3,'message.completed',{role:'assistant',messageId:'a2',content:'完整',stopReason:'stop'})]);
 assert.deepEqual(all(partial).map(r=>r.id),['a1','a2']);
});
test('late same-ID delta cannot reopen completed message or duplicate final source',()=>{
 const r=run([event(1,'message.completed',{role:'assistant',messageId:'source',content:'完整答复'}),event(2,'message.delta',{messageId:'source',content:'旧'}),event(3,'message.completed',{role:'agent',messageId:'final',sourceAssistantMessageId:'source',content:'完整答复'}),event(4,'message.delta',{messageId:'source',content:'更迟的旧正文'})],'succeeded');
 r.messages=[{id:'final',runId:'r',authorType:'agent',seq:2,content:{text:'完整答复'}}];
 assert.deepEqual(all(r).map(r=>r.id),['final']);assert.equal(projectTurn(r).segments[0]?.final?.text,'完整答复');
});
test('same-ID source promotion preserves final rather than deleting itself',()=>{
 const r=run([event(1,'message.completed',{role:'assistant',messageId:'same',content:'正文'}),event(2,'message.completed',{role:'agent',messageId:'same',sourceAssistantMessageId:'same',content:'正文'})],'succeeded');assert.equal(all(r).length,1);assert.equal(projectTurn(r).segments[0]?.final?.id,'same');
});
test('accepted and applied are distinct; repeated apply acknowledgement has one segment',()=>{
 const r=run([event(2,'message.accepted',{messageId:'guide'})]);r.messages=[{id:'guide',runId:'r',authorType:'user',seq:2,clientMessageId:'c',content:{text:'补充'}}];
 let row=all(r)[0];assert.equal(row?.kind==='user'&&row.delivery,'accepted');assert.equal(projectTurn(r).segments.length,1);
 r.events.push(event(3,'message.accepted_applied',{messageIds:['guide']}),event(4,'message.accepted_applied',{messageIds:['guide']}),event(5,'message.completed',{role:'assistant',messageId:'a',content:'处理补充'}));
 const t=projectTurn(r);assert.equal(t.segments.length,2);assert.equal(t.segments[1]?.id,'r:segment:guide');row=all(r)[0];assert.equal(row?.kind==='user'&&row.delivery,'applied');
});
test('successful work folds while interrupted work and failed tools stay discoverable',()=>{
 for(const status of ['failed','cancelled','needs_reconciliation']){const r=run([event(1,'tool.started',{invocationId:'t',tool:'bash'})],status);assert.equal(projectTurn(r).segments[0]?.defaultOpen,true);const tool=all(r)[0];assert.notEqual(tool?.kind==='tool'&&tool.state,'running');}
 const r=run([event(1,'tool.completed',{invocationId:'t',tool:'read_file',ok:true})],'succeeded');assert.equal(projectTurn(r).segments[0]?.defaultOpen,false);
});
test('stale HTTP tool claimed cannot regress live success; approval joins by invocationId',()=>{
 const r=run([event(1,'tool.started',{invocationId:'t',tool:'bash'}),event(2,'tool.completed',{invocationId:'t',tool:'bash',ok:true})]);r.tools=[{invocationId:'t',tool:'bash',state:'claimed'}];r.approvals=[{approvalId:'wrong',invocationId:'another',state:'pending'},{approvalId:'right',invocationId:'t',state:'approved'}];const tool=all(r)[0];assert.equal(tool?.kind==='tool'&&tool.state,'done');assert.equal(tool?.kind==='tool'&&tool.approval?.approvalId,'right');
});
function flatten(nodes:MarkdownNode[]):MarkdownNode[]{return nodes.flatMap(n=>[n,...flatten(n.children??[])]);}
test('Markdown parses real tables, nested lists, fenced code and links without raw HTML nodes',()=>{
 const nodes=flatten(parseMarkdown('| 名称 | 数值 |\n| --- | --- |\n| 项目 | 1 |\n\n1. **第一项**\n   - 子项\n\n```js\n<script>alert(1)</script>\n```\n\n[网站](https://example.com)'));
 for(const tag of ['table','thead','tbody','tr','th','td','ol','ul','li','strong','pre','code','a'])assert.ok(nodes.some(n=>n.tag===tag),tag);
 assert.ok(nodes.some(n=>n.tag==='code'&&n.text?.includes('<script>')));assert.ok(!nodes.some(n=>n.tag==='script'));
});
test('Markdown blocks executable protocols, HTML and remote image loads',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','vbscript:msgbox(1)','file:///etc/passwd','//evil.test','/\\evil.test','java\nscript:alert(1)'])assert.equal(safeHref(url),undefined,url);
 const nodes=flatten(parseMarkdown('<img src=x onerror=alert(1)>\n\n[attack](javascript:alert(1)) ![remote](https://evil.test/track.png) [safe](https://example.com)'));
 assert.ok(!nodes.some(n=>['img','script','iframe','style'].includes(n.tag??'')));
 assert.ok(nodes.filter(n=>n.tag==='a').every(n=>n.attrs?.href==='https://example.com'&&n.attrs?.rel==='noopener noreferrer'));
 assert.ok(nodes.some(n=>n.text?.includes('onerror')),'untrusted HTML stays text');
});
test('stored final source ID deduplicates before the final public event is emitted',()=>{
 const r=run([event(1,'message.completed',{role:'assistant',messageId:'source',content:'原始正文'})],'succeeded');r.messages=[{id:'final',runId:'r',authorType:'agent',seq:2,content:{text:'最终整理正文',sourceAssistantMessageId:'source'}}];assert.deepEqual(all(r).map(r=>r.id),['final']);assert.equal(projectTurn(r).segments[0]?.final?.text,'最终整理正文');
});
test('stored user messages preserve conversation sequence instead of UUID lexical order',()=>{
 const r=run();r.messages=[{id:'z-first',runId:'r',authorType:'user',seq:1,content:{text:'首先'}},{id:'a-second',runId:'r',authorType:'user',seq:2,content:{text:'其次'}}];assert.deepEqual(all(r).map(r=>r.id),['z-first','a-second']);
});
test('one applied batch groups multiple guides and malformed timestamps do not show NaN duration',()=>{
 const r=run([event(3,'message.accepted_applied',{messageIds:['g1','g2'],workSegmentId:'batch'})]);r.messages=['g1','g2'].map((id,index)=>({id,runId:'r',authorType:'user',seq:index+1,content:{text:id},clientMessageId:id}));r.endedAt='invalid';const turn=projectTurn(r);assert.equal(turn.segments.length,2);assert.deepEqual(turn.segments[1]?.triggerMessageIds,['g1','g2']);assert.equal(turn.durationMs,undefined);
});
test('scroll ownership ignores layout change and preserves prepend anchor',()=>{
 const top={scrollTop:250,scrollHeight:2000,clientHeight:700};assert.equal(followingAfterScroll(true,top,'user'),false);assert.equal(followingAfterScroll(false,{...top,scrollTop:1300},'layout'),false);assert.equal(followingAfterScroll(false,{...top,scrollTop:1300},'user'),true);assert.equal(prependTop(top,3000),1250);
});

test('底部判断以实际可滚动范围为准，短内容与弹性上拉不误判，保留48px容差',()=>{
 assert.equal(atBottom({scrollTop:0,scrollHeight:300,clientHeight:600}),true);
 assert.equal(atBottom({scrollTop:-400,scrollHeight:300,clientHeight:600}),true);
 assert.equal(atBottom({scrollTop:-100,scrollHeight:620,clientHeight:600}),true);
 assert.equal(atBottom({scrollTop:352,scrollHeight:1000,clientHeight:600}),true);
 assert.equal(atBottom({scrollTop:351,scrollHeight:1000,clientHeight:600}),false);
 assert.equal(atBottom({scrollTop:500,scrollHeight:1000,clientHeight:600}),true);
});

test('消息真实时间在持久快照和SSE重放后保留，重新回答只展示最新最终答复',()=>{
 const r=run([ {...event(1,'message.completed',{role:'agent',messageId:'answer',content:'新答复'}),occurredAt:'2026-11-14T02:00:00Z'} ],'succeeded');
 r.messages=[{id:'user',runId:'r',authorType:'user',seq:1,createdAt:'2026-11-14T01:00:00Z',content:{text:'问题'}},{id:'old',runId:'r',authorType:'agent',seq:2,createdAt:'2026-11-14T01:01:00Z',content:{text:'旧答复'}},{id:'answer',runId:'r',authorType:'agent',seq:3,createdAt:'2026-11-14T02:00:00Z',content:{text:'新答复'}}];
 const turn=projectTurn(r);assert.equal(turn.segments[0]!.rows.find(row=>row.kind==='user')!.kind,'user');assert.equal((turn.segments[0]!.rows.find(row=>row.kind==='user') as {createdAt?:string}).createdAt,'2026-11-14T01:00:00Z');
 assert.equal(turn.segments[0]!.final!.createdAt,'2026-11-14T02:00:00Z');assert.equal(turn.segments[0]!.final!.text,'新答复');assert.ok(!turn.segments[0]!.history.some(row=>row.id==='old'));
});
test('消息时间不伪造缺失值，同日／昨日／跨年标签含必要日期',async()=>{
 const {messageTime}=await import('../web/conversation/messageTime.js');const now=new Date(2026,10,14,12,0);
 assert.equal(messageTime(undefined,now),undefined);assert.equal(messageTime('invalid',now),undefined);
 assert.equal(messageTime(new Date(2026,10,14,10,30).toISOString(),now)!.label,'10:30');assert.match(messageTime(new Date(2026,10,13,10,30).toISOString(),now)!.label,/昨天/);assert.match(messageTime(new Date(2025,10,13,10,30).toISOString(),now)!.label,/2025/);
});
