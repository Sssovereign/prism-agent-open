import {test} from 'node:test';
import assert from 'node:assert/strict';
import {phaseNavLabel,railGroupKey,phaseAtScroll,claimTargetIndex,speechSummary,majorityVerdict,inputViewOf,dispositionFields,reviewSubjectFor,normalizeDecision} from '../web/view-model/research.js';
import type {ResearchRecord,ResearchReport,ResearchView} from '../contracts/research.js';

const record=(over:Partial<ResearchRecord>):ResearchRecord=>({id:'r',kind:'source',participantId:null,phaseTaskId:null,title:'资料',content:'',hash:'h',url:null,truncated:false,published:true,...over});
const view=(over:Partial<ResearchView>):ResearchView=>({id:'v',phaseTaskId:'pt1',participantId:'p1',role:'pro',recordIds:['r'],hashes:{r:'h'},tools:['research_read','research_search'],supplementThrough:0,policyVersion:'research-v1',...over});

test('research面板: 阶段导航标签按phaseKey与轮次组织',()=>{
 assert.equal(phaseNavLabel({id:'p',label:'pro',role:'pro',ordinal:0,phaseKey:'opening_pro',roundNo:0,status:'succeeded'},{role:'正方',opening:'开题',round:(n)=>`第${n}轮`}),'正方 · 开题');
 assert.equal(phaseNavLabel({id:'p',label:'pro',role:'pro',ordinal:2,phaseKey:'round_2_pro',roundNo:2,status:'running'},{role:'正方',opening:'开题',round:(n)=>`第${n}轮`}),'正方 · 第2轮');
 assert.equal(phaseNavLabel({id:'p',label:'host',role:'host',ordinal:4,phaseKey:'host',roundNo:0,status:'pending'},{role:'主持',opening:'开题',round:(n)=>`第${n}轮`}),'主持');
});

test('research面板: 导航轨分组键开题成对、轮次按轮分档',()=>{
 assert.equal(railGroupKey({id:'p',label:'pro',role:'pro',ordinal:0,phaseKey:'opening_pro',roundNo:0,status:'succeeded'}),'opening');
 assert.equal(railGroupKey({id:'p',label:'con',role:'con',ordinal:1,phaseKey:'opening_con',roundNo:0,status:'succeeded'}),'opening');
 assert.equal(railGroupKey({id:'p',label:'pro',role:'pro',ordinal:2,phaseKey:'round_1_pro',roundNo:1,status:'running'}),'round:1');
 assert.equal(railGroupKey({id:'p',label:'pro',role:'pro',ordinal:4,phaseKey:'round_2_pro',roundNo:2,status:'pending'}),'round:2');
 assert.equal(railGroupKey({id:'p',label:'host',role:'host',ordinal:6,phaseKey:'host',roundNo:0,status:'pending'}),'host');
 assert.equal(railGroupKey({id:'p',label:'juror1',role:'juror',ordinal:0,status:'succeeded'}),'juror');
});

test('research面板: 滚动停留判定取锚线上最后一个阶段并触底兜底',()=>{
 const entries=[{id:'p1',top:0},{id:'p2',top:600},{id:'p3',top:1400}];
 assert.equal(phaseAtScroll([],96),'');
 assert.equal(phaseAtScroll(entries,-100),'');
 assert.equal(phaseAtScroll(entries,96),'p1');
 assert.equal(phaseAtScroll(entries,600),'p2');
 assert.equal(phaseAtScroll(entries,1350),'p2');
 assert.equal(phaseAtScroll(entries,1400),'p3');
 assert.equal(phaseAtScroll(entries,-100,true),'p3');
 assert.equal(phaseAtScroll(entries,96,true),'p3');
});

test('research面板: 回应定位索引覆盖本轮与继承的已发布主张',()=>{
 const records=[
  record({id:'s1',kind:'statement',phaseTaskId:'pt1',content:JSON.stringify({claims:[{id:'pt1:c1',text:'主张一'},{id:'pt1:c2',text:'主张二'}]})}),
  record({id:'s2',kind:'opinion',phaseTaskId:'ptX',content:JSON.stringify({claims:[{id:'ptX:c1'}]})}),
  record({id:'s3',kind:'statement',phaseTaskId:'pt1',content:'不是JSON'}),
  record({id:'s4',kind:'verdict',title:'旧陪审结论',content:JSON.stringify({claims:[{id:'old:c1',text:'旧主张'}]})}),
  record({id:'s5',kind:'opinion',published:false,content:JSON.stringify({claims:[{id:'sealed:c1',text:'封存主张'}]})}),
 ];
 const index=claimTargetIndex(records,id=>id==='pt1'?{label:'正方',roundNo:0}:null);
 assert.equal(index.size,3);
 assert.deepEqual(index.get('pt1:c1'),{phaseId:'pt1',roleLabel:'正方',roundNo:0,claimNo:1,text:'主张一'});
 assert.equal(index.has('ptX:c1'),false);
 assert.deepEqual(index.get('old:c1'),{phaseId:null,roleLabel:'旧陪审结论',roundNo:0,claimNo:1,text:'旧主张'});
 assert.equal(index.has('sealed:c1'),false);
});

test('research面板: 复核输入使用方案或主张原文，旧裁决留在来源报告',()=>{
 const report:ResearchReport={
  version:2,runId:'debate',mode:'debate',text:'旧主持裁决',summary:'旧裁决推荐方案 A',execution:'complete',
  evidenceStatus:'insufficient',sourceCount:0,evidenceCount:0,claimCount:0,tally:null,limitations:[],recordIds:[],
  decision:{required:true,proposition:'上线哪种方案？',candidates:[{id:'a',text:'先上线可读性'}]},
  disposition:{kind:'adopt',candidateId:'a'},
 };
 assert.deepEqual(reviewSubjectFor(report,'上线哪种方案？'),{title:'先上线可读性',content:'先上线可读性'});
 assert.equal(reviewSubjectFor(report,'上线哪种方案？','旧报告兼容是硬约束').content,'旧报告兼容是硬约束');
});

test('research面板: 发言摘要优先summary并按正文长度回退',()=>{
 assert.equal(speechSummary({summary:' 摘要 ',text:'正文'}),'摘要');
 assert.equal(speechSummary({text:'短正文'}),'短正文');
 const long='长'.repeat(150);
 assert.equal(speechSummary({text:long}),`${'长'.repeat(140)}…`);
 assert.equal(speechSummary(null),'');
});

test('research面板: 程序多数判定要求同一判定至少两票',()=>{
 assert.deepEqual(majorityVerdict({pro:1,con:2,mixed:0,insufficient:0,abstain:0}),{key:'con',count:2});
 assert.equal(majorityVerdict({pro:1,con:1,mixed:1,insufficient:0,abstain:0}),null);
 assert.deepEqual(majorityVerdict({pro:3,con:2}),{key:'pro',count:3});
 assert.equal(majorityVerdict(null),null);
 assert.equal(majorityVerdict({}),null);
});

test('research面板: 处置字段按类型分组展示',()=>{
 assert.deepEqual(dispositionFields('adopt'),['candidateId','hardConstraints']);
 assert.deepEqual(dispositionFields('trial'),['scope','successCriteria','reEvalTrigger']);
 assert.deepEqual(dispositionFields('defer'),['missingEvidence','howToObtain','reDecisionConditions']);
 assert.deepEqual(dispositionFields('unknown'),[]);
});

test('research面板: 输入视野按冻结视图分类并反映联网搜索状态',()=>{
 const records=[
  record({id:'r1',kind:'source',title:'共同资料',content:'x'}),
  record({id:'r2',kind:'statement',phaseTaskId:'pt1',title:'【pro】发言',content:'x'}),
  record({id:'r3',kind:'statement',phaseTaskId:'pt1',title:'未发布发言',content:'x',published:false}),
  record({id:'r4',kind:'supplement',title:'用户补充',content:'x'}),
  record({id:'r5',kind:'source',title:'视图外资料',content:'x'}),
 ];
 const summary=inputViewOf(view({recordIds:['r1','r2','r3','r4'],supplementThrough:2,tools:['research_read','research_search','web_search']}),records);
 assert.equal(summary.sourceCount,1);assert.equal(summary.speechCount,1);
 assert.equal(summary.supplementVersion,2);assert.equal(summary.webSearch,true);
 assert.deepEqual(summary.categories.map(c=>c.key),['sources','speeches','supplements']);
 assert.deepEqual(summary.categories[0]!.titles,['共同资料']);
 const offline=inputViewOf(view({recordIds:['r1'],tools:['research_read']}),records);
 assert.equal(offline.webSearch,false);
 assert.equal(offline.categories.length,1);
});

test('决定草稿归一化: 命题回退议题并剔空候选',()=>{
 const n=normalizeDecision({proposition:'  ',candidates:[{text:' 方案A '},{text:''},{text:'维持现状'}]},' 采用哪种方案？ ');
 assert.equal(n.proposition,'采用哪种方案？');
 assert.equal(n.propositionFromObjective,true);
 assert.deepEqual(n.candidates.map(c=>c.text),['方案A','维持现状']);
 assert.equal(n.ready,true);
 assert.deepEqual(n.issues,[]);
});

test('决定草稿归一化: 显式命题优先且候选不足不就绪',()=>{
 const n=normalizeDecision({proposition:' 自定义命题 ',candidates:[{text:'A'}]},'议题');
 assert.equal(n.proposition,'自定义命题');
 assert.equal(n.propositionFromObjective,false);
 assert.deepEqual(n.issues,['candidates-insufficient']);
 assert.equal(n.ready,false);
});

test('决定草稿归一化: 议题超长不静默截断，要求显式短命题',()=>{
 const long='长'.repeat(2001);
 const n=normalizeDecision({proposition:'',candidates:[{text:'A'},{text:'B'}]},long);
 assert.equal(n.proposition,'');
 assert.deepEqual(n.issues,['proposition-too-long']);
 assert.equal(n.ready,false);
 const fixed=normalizeDecision({proposition:'短命题',candidates:[{text:'A'},{text:'B'}]},long);
 assert.equal(fixed.ready,true);
});

test('决定草稿归一化: 超限候选与空草案分别报issue',()=>{
 const tooLong=normalizeDecision({proposition:'长'.repeat(2001),candidates:[{text:'A'},{text:'B'}]},'');
 assert.deepEqual(tooLong.issues,['proposition-too-long']);
 const many=normalizeDecision({proposition:'p',candidates:Array.from({length:7},(_,i)=>({text:`c${i}`}))},'');
 assert.deepEqual(many.issues,['candidates-too-many']);
 const longCand=normalizeDecision({proposition:'p',candidates:[{text:'a'.repeat(501)},{text:'B'}]},'');
 assert.deepEqual(longCand.issues,['candidate-too-long']);
 const empty=normalizeDecision(null,'  ');
 assert.equal(empty.issues.includes('proposition-empty'),true);
 assert.equal(empty.ready,false);
});
