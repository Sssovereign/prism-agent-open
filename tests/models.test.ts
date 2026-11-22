import {DEFAULT_SUBAGENT_SETTINGS} from '../contracts/models.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildProductApp } from '../src/app.js';
import { hashPassword } from '../src/auth/passwords.js';
import { CredentialVault } from '../src/models/vault.js';
import { resolveModelParameters } from '../src/models/parameterResolver.js';
import { publicAddress } from '../src/models/network.js';
import type { ModelConfigInput } from '../contracts/v1.js';
const secret = 'sk-fixture-never-persist-0123456789';
const config: ModelConfigInput = { preset: 'custom', name: '测试接口', baseUrl: 'https://models.example.org/v1', models: [{ modelId: 'fixture-model', displayName: '测试模型', enabled: true, parameters: {} }] };
async function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'prism-settings-'));
    const calls: Array<{
        url: string;
        authorization: string | null;
        apiKey?: string | null;
        body: Record<string, unknown>;
    }> = [];
    const fx = buildProductApp(dir, { serveWeb: false, modelTransport: () => async (input, init) => {
            const request = new Request(input, init);
            const body = request.method === 'POST' ? await request.json() as Record<string, unknown> : {};
            calls.push({ url: request.url, authorization: request.headers.get('authorization'), apiKey: request.headers.get('x-api-key'), body });
            if (request.url.endsWith('/models'))
                return Response.json({ data: [{ id: 'fixture-model' }, { id: 'another-model' }] });
            if (request.headers.get('authorization') === 'Bearer sk-bad-fixture')
                return Response.json({ error: { message: `untrusted echo ${secret}` } }, { status: 401 });
            if (new URL(request.url).pathname.endsWith('/v1/messages')) {
                const events = [
                    ['message_start',{type:'message_start',message:{id:'msg_test',type:'message',role:'assistant',content:[],model:'fixture-model',stop_reason:null,stop_sequence:null,usage:{input_tokens:4,output_tokens:0}}}],
                    ['content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}}],
                    ['content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}}],
                    ['content_block_stop',{type:'content_block_stop',index:0}],
                    ['message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}}],
                    ['message_stop',{type:'message_stop'}],
                ];
                return new Response(events.map(([name,data])=>`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''),{headers:{'content-type':'text/event-stream'}});
            }
            const event = { id: 'chatcmpl-test', object: 'chat.completion.chunk', model: 'fixture-model', choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] };
            return new Response(`data: ${JSON.stringify(event)}\n\ndata: ${JSON.stringify({ ...event, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
        } });
    const pw = await hashPassword('SettingsTest2026!');
    for (const name of ['models-a', 'models-b']) {
        const ts = new Date().toISOString();
        fx.db.tx(tx => tx.prepare('INSERT INTO users(id,username,password_hash,password_salt,password_params_json,disabled,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?)').run(randomUUID(), name, pw.hash, pw.salt, pw.paramsJson, ts, ts));
    }
    async function login(username = 'models-a') { const r = await fx.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: 'SettingsTest2026!' } }); assert.equal(r.statusCode, 200); const raw = r.headers['set-cookie']; return { cookie: (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!, 'x-csrf-token': r.json().data.csrfToken }; }
    return { fx, dir, calls, login, async cleanup() { await fx.app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
test('model settings: private CRUD, optimistic revision and no secret in metadata or DB', async () => {
    const e = await fixture();
    try {
        const a = await e.login(), b = await e.login('models-b');
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers: a, payload: config });
        assert.equal(created.statusCode, 201);
        const c = created.json().data;
        assert.equal(c.revision, 1);
        const put = await e.fx.app.inject({ method: 'PUT', url: `/api/v1/model-configs/${c.id}/credential`, headers: a, payload: { apiKey: secret } });
        assert.equal(put.statusCode, 200);
        assert.equal(put.body.includes(secret), false);
        const list = await e.fx.app.inject({ url: '/api/v1/model-configs', headers: a });
        assert.equal(list.json().data[0].hasCredential, true);
        assert.equal(list.body.includes(secret), false);
        assert.equal((await e.fx.app.inject({ url: '/api/v1/model-configs', headers: b })).json().data.length, 0);
        assert.equal((await e.fx.app.inject({ method: 'PUT', url: `/api/v1/model-configs/${c.id}/credential`, headers: b, payload: { apiKey: secret } })).statusCode, 404);
        const conflict = await e.fx.app.inject({ method: 'PATCH', url: `/api/v1/model-configs/${c.id}`, headers: a, payload: { ...config, revision: 2 } });
        assert.equal(conflict.statusCode, 409);
        const update = await e.fx.app.inject({ method: 'PATCH', url: `/api/v1/model-configs/${c.id}`, headers: a, payload: { name: '改名', revision: 1 } });
        assert.equal(update.json().data.revision, 2);
        assert.equal(update.json().data.baseUrl, config.baseUrl);
        assert.equal(update.json().data.models[0].modelId, 'fixture-model');
        assert.equal(update.json().data.hasCredential, true);
        const endpoint = await e.fx.app.inject({ method: 'PATCH', url: `/api/v1/model-configs/${c.id}`, headers: a, payload: { ...config, baseUrl: 'https://another.example.org/v1', revision: 2 } });
        assert.equal(endpoint.json().data.hasCredential, false);
        assert.equal(readFileSync(join(e.dir, 'workbench.sqlite')).includes(Buffer.from(secret)), false);
        const wal = await import('node:fs');
        if (wal.existsSync(join(e.dir, 'workbench.sqlite-wal')))
            assert.equal(readFileSync(join(e.dir, 'workbench.sqlite-wal')).includes(Buffer.from(secret)), false);
    }
    finally {
        await e.cleanup();
    }
});
test('model view下发visionSupported与目录档案：按pi目录解析，随配置读取返回', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        const payload: ModelConfigInput = { preset: 'custom', name: '目录解析', baseUrl: 'https://api.deepseek.com', models: [
            { modelId: 'deepseek-flash', displayName: 'DS Flash', enabled: true, parameters: {} },
            { modelId: 'deepseek-v4-pro', displayName: 'DS Pro', enabled: true, parameters: {} },
            { modelId: 'travel-agent', displayName: '自定义未知', enabled: true, parameters: {} },
        ] };
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload });
        assert.equal(created.statusCode, 201);
        const models = created.json().data.models as Array<{ modelId: string; visionSupported: boolean; maxOutputTokensDefault: number | null; providerId: string | null }>;
        const byId = Object.fromEntries(models.map(m => [m.modelId, m]));
        assert.equal(byId['deepseek-flash']!.visionSupported, true);
        assert.equal(byId['deepseek-v4-pro']!.visionSupported, false);
        assert.equal(byId['travel-agent']!.visionSupported, false);
        // 目录声明的单次最大输出随视图下发；未收录为 null
        assert.equal(byId['deepseek-flash']!.maxOutputTokensDefault, 384000);
        assert.equal(byId['deepseek-flash']!.providerId, 'deepseek');
        assert.equal(byId['travel-agent']!.maxOutputTokensDefault, null);
        assert.equal(byId['travel-agent']!.providerId, null);
    }
    finally {
        await e.cleanup();
    }
});
test('最大输出默认接pi目录：收录模型请求目录值(生效受窗口1/4)，未收录保守4096，手填值优先', () => {
    // deepseek-flash 目录 maxTokens=384000、窗口 1,000,000 → 默认请求 384000，生效 min(384000, 250000)=250000
    const listed = resolveModelParameters('openai-completions', 'https://api.deepseek.com', 'deepseek-flash', {});
    assert.equal(listed.effective.maxOutputTokens, 250000);
    assert.equal(listed.effective.contextWindow, 1000000);
    // 目录未收录的模型保持 4096 保守默认（窗口未知不造数，1/4 约束不生效）
    const unknown = resolveModelParameters('openai-completions', 'https://api.deepseek.com', 'travel-agent', {});
    assert.equal(unknown.effective.maxOutputTokens, 4096);
    assert.equal(unknown.effective.contextWindow, null);
    // 手填值优先于目录默认；非整数拒绝
    const manual = resolveModelParameters('openai-completions', 'https://api.deepseek.com', 'deepseek-flash', { maxOutputTokens: 300 });
    assert.equal(manual.effective.maxOutputTokens, 300);
    assert.throws(() => resolveModelParameters('openai-completions', 'https://api.deepseek.com', 'deepseek-flash', { maxOutputTokens: 4096.5 }), /整数/);
});
test('思考级别按pi目录下发与保存：glm-5.3 显式级别可保存回读，未知别名仍拒绝', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        const base = { preset: 'glm-cn-standard', name: 'GLM 标准端点', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' };
        // 目录未收录的别名带显式级别 → 整个配置拒绝（fail-closed）
        const rejected = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: { ...base, models: [
            { modelId: 'glm-5.3', displayName: 'GLM', enabled: true, parameters: { thinkingLevel: 'high' } },
            { modelId: 'travel-agent', displayName: '未知', enabled: true, parameters: { thinkingLevel: 'high' } },
        ] } });
        assert.equal(rejected.statusCode, 400);
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: { ...base, models: [
            { modelId: 'glm-5.3', displayName: 'GLM', enabled: true, parameters: { thinkingLevel: 'high' } },
        ] } });
        assert.equal(created.statusCode, 201, created.body);
        const model = created.json().data.models[0];
        assert.deepEqual(model.thinkingLevels, ['low', 'high', 'max']);
        assert.equal(model.parameters.thinkingLevel, 'high');
        // PATCH 往返：只读 thinkingLevels 被投影，不触发 additionalProperties 拒绝
        const patched = await e.fx.app.inject({ method: 'PATCH', url: `/api/v1/model-configs/${created.json().data.id}`, headers, payload: { ...base, models: [
            { modelId: 'glm-5.3', displayName: 'GLM', enabled: true, parameters: { thinkingLevel: 'max' } },
        ], revision: 1 } });
        assert.equal(patched.statusCode, 200, patched.body);
        assert.equal(patched.json().data.models[0].parameters.thinkingLevel, 'max');
        const reloaded = await e.fx.app.inject({ url: '/api/v1/model-configs', headers });
        const saved = reloaded.json().data.find((entry: { id: string }) => entry.id === created.json().data.id).models[0];
        assert.deepEqual(saved.thinkingLevels, ['low', 'high', 'max']);
        assert.equal(saved.parameters.thinkingLevel, 'max');
    }
    finally {
        await e.cleanup();
    }
});
test('thinking picker contract: non-thinking and unknown models expose no off-only option', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: {
            preset: 'custom', name: '文本接口', baseUrl: 'https://api.openai.com/v1', models: [
                { modelId: 'gpt-4o', displayName: '文本模型', enabled: true, parameters: {} },
                { modelId: 'custom-alias', displayName: '未知模型', enabled: true, parameters: {} },
            ],
        } });
        assert.equal(created.statusCode, 201, created.body);
        const list = await e.fx.app.inject({ url: '/api/v1/model-configs', headers });
        const saved = list.json().data.find((entry: { id: string }) => entry.id === created.json().data.id);
        for (const model of saved.models) {
            assert.deepEqual(model.thinkingLevels, []);
            assert.equal(model.parameters.thinkingLevel, undefined);
        }
    }
    finally { await e.cleanup(); }
});
test('advanced model metadata: staged resolution and persisted overrides agree without losing existing context or effort', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        const parameters = { contextWindow:300000,thinkingLevel:'max',advanced:{thinkingLevels:['low','high','max'],thinkingParameterMap:{thinking:{type:'enabled'},output_config:{effort:'$level'}}} };
        const base = {preset:'custom',name:'兼容接口',protocol:'anthropic-messages',baseUrl:'https://open.bigmodel.cn/api/anthropic'};
        const preview = await e.fx.app.inject({method:'POST',url:'/api/v1/model-configs/resolve-model',headers,payload:{protocol:base.protocol,baseUrl:base.baseUrl,modelId:'glm-5.3',parameters}});
        assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().data.image,false);assert.equal(preview.json().data.source,'manual');assert.deepEqual(preview.json().data.thinkingLevels,['low','high','max']);
        assert.equal(e.fx.db.db.prepare('SELECT COUNT(*) n FROM model_configs').get()!.n,0);
        const created = await e.fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers,payload:{...base,models:[{modelId:'glm-5.3',displayName:'GLM',enabled:true,parameters}]}});
        assert.equal(created.statusCode,201,created.body);const config=created.json().data;
        assert.equal(config.models[0].visionSupported,false);assert.deepEqual(config.models[0].parameters,parameters);
        const patched = await e.fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${config.id}`,headers,payload:{revision:config.revision,models:config.models}});
        assert.equal(patched.statusCode,200,patched.body);
        const list=await e.fx.app.inject({url:'/api/v1/model-configs',headers});const model=list.json().data[0].models[0];
        assert.equal(model.parameters.contextWindow,300000);assert.equal(model.parameters.thinkingLevel,'max');assert.equal(model.metadata.image,false);assert.deepEqual(model.metadata.thinkingLevels,['low','high','max']);
    } finally { await e.cleanup(); }
});
test('connection test uses Pi SSE adapter with bounded output, auth injection and redacted failures', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: config });
        const c = created.json().data;
        const url = `/api/v1/model-configs/${c.id}`;
        assert.equal((await e.fx.app.inject({ method: 'POST', url: `${url}/test`, headers, payload: { modelId: 'fixture-model', revision: 1 } })).json().error.code, 'CREDENTIAL_REQUIRED');
        await e.fx.app.inject({ method: 'PUT', url: `${url}/credential`, headers, payload: { apiKey: secret } });
        const result = await e.fx.app.inject({ method: 'POST', url: `${url}/test`, headers, payload: { modelId: 'fixture-model', revision: 1 } });
        assert.equal(result.statusCode, 200, result.body);
        assert.equal(result.json().data.success, true);
        assert.equal(result.body.includes(secret), false);
        assert.equal(e.calls[0]!.url, 'https://models.example.org/v1/chat/completions');
        assert.equal(e.calls[0]!.authorization, `Bearer ${secret}`);
        assert.equal(e.calls[0]!.body.max_tokens, 128);
        assert.equal(e.calls[0]!.body.stream, true);
        const list = await e.fx.app.inject({ method: 'POST', url: `${url}/discover`, headers, payload: { revision: 1 } });
        assert.deepEqual(list.json().data.models, ['fixture-model', 'another-model']);
        await e.fx.app.inject({ method: 'PUT', url: `${url}/credential`, headers, payload: { apiKey: 'sk-bad-fixture' } });
        const failed = await e.fx.app.inject({ method: 'POST', url: `${url}/test`, headers, payload: { modelId: 'fixture-model', revision: 1 } });
        assert.equal(failed.statusCode, 422);
        assert.equal(failed.body.includes(secret), false);
        assert.equal(failed.json().error.code, 'MODEL_UNAVAILABLE');
    }
    finally {
        await e.cleanup();
    }
});
test('credentials follow the local account across sessions, logout and backend restart', async () => {
    const e = await fixture();
    try {
        const a = await e.login(), otherSession = await e.login();
        const created = await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers: a, payload: config });
        const c = created.json().data;
        await e.fx.app.inject({ method: 'PUT', url: `/api/v1/model-configs/${c.id}/credential`, headers: a, payload: { apiKey: secret } });
        assert.equal((await e.fx.app.inject({ url: '/api/v1/model-configs', headers: otherSession })).json().data[0].hasCredential, true);
        await e.fx.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: a });
        const fresh = await e.login();
        assert.equal((await e.fx.app.inject({ url: '/api/v1/model-configs', headers: fresh })).json().data[0].hasCredential, true);
        await e.fx.app.inject({ method: 'PUT', url: `/api/v1/model-configs/${c.id}/credential`, headers: fresh, payload: { apiKey: secret } });
        await e.fx.app.close();
        const restarted = buildProductApp(e.dir, { serveWeb: false });
        try {
            const list = await restarted.app.inject({ url: '/api/v1/model-configs', headers: fresh });
            assert.equal(list.statusCode, 200);
            assert.equal(list.json().data[0].hasCredential, true);
        }
        finally {
            await restarted.app.close();
        }
    }
    finally {
        await e.cleanup();
    }
});
test('unsafe endpoint and unknown fields fail before a model request; credential writes require CSRF', async () => {
    const e = await fixture();
    try {
        const headers = await e.login();
        for (const baseUrl of ['http://example.org/v1', 'https://localhost/v1', 'https://127.0.0.1/v1', 'https://[::1]/v1', 'https://example.org/v1?api_key=secret', 'https://user:pass@example.org/v1'])
            assert.equal((await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: { ...config, baseUrl } })).statusCode, 400);
        assert.equal((await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: { ...config, apiKey: secret } })).statusCode, 400);
        const c = (await e.fx.app.inject({ method: 'POST', url: '/api/v1/model-configs', headers, payload: config })).json().data;
        assert.equal((await e.fx.app.inject({ method: 'PUT', url: `/api/v1/model-configs/${c.id}/credential`, headers: { cookie: headers.cookie }, payload: { apiKey: secret } })).statusCode, 403);
        assert.equal(e.calls.length, 0);
        for (const ip of ['127.0.0.1', '10.2.3.4', '192.168.1.1', '198.18.0.54', '169.254.169.254', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::'])
            assert.equal(publicAddress(ip), false, ip);
        assert.equal(publicAddress('8.8.8.8'), true);
        assert.equal(publicAddress('2606:4700:4700::1111'), true);
    }
    finally {
        await e.cleanup();
    }
});
test('vault replacement, expiry and config changes cancel in-flight probes', () => {
    const v = new CredentialVault(), future = new Date(Date.now() + 60000).toISOString();
    v.set('s', 'c', secret, future);
    const c = new AbortController();
    v.track('s', 'c', c);
    v.set('s', 'c', 'replacement-key', future);
    assert.equal(c.signal.aborted, true);
    assert.equal(v.get('s', 'c'), 'replacement-key');
    v.configChanged('c', true);
    assert.equal(v.get('s', 'c'), undefined);
    v.set('s', 'c', secret, new Date(0).toISOString());
    assert.equal(v.get('s', 'c'), undefined);
    v.dispose();
});

test('Anthropic协议：持久化、真实Messages线格式与凭据隔离；切协议清除旧Key', async () => {
 const e=await fixture();
 try {
  const headers=await e.login();
  const create=await e.fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers,payload:{...config,protocol:'anthropic-messages',baseUrl:'https://models.example.org'}});
  assert.equal(create.statusCode,201,create.body);const c=create.json().data;
  assert.equal(c.protocol,'anthropic-messages');
  await e.fx.app.inject({method:'PUT',url:`/api/v1/model-configs/${c.id}/credential`,headers,payload:{apiKey:secret}});
  const probe=await e.fx.app.inject({method:'POST',url:`/api/v1/model-configs/${c.id}/test`,headers,payload:{modelId:'fixture-model',revision:1}});
  assert.equal(probe.statusCode,200,probe.body);
  assert.equal(e.calls[0]!.url,'https://models.example.org/v1/messages?beta=true');
  assert.equal(e.calls[0]!.apiKey,secret);
  assert.equal(e.calls[0]!.body.max_tokens,128);
  assert.equal(e.calls[0]!.body.stream,true);
  const changed=await e.fx.app.inject({method:'PATCH',url:`/api/v1/model-configs/${c.id}`,headers,payload:{revision:1,protocol:'openai-completions'}});
  assert.equal(changed.statusCode,200,changed.body);assert.equal(changed.json().data.hasCredential,false);
  assert.equal(changed.json().data.protocol,'openai-completions');
  const bad=await e.fx.app.inject({method:'POST',url:'/api/v1/model-configs',headers,payload:{...config,protocol:'unknown'}});
  assert.equal(bad.statusCode,400);
 }finally{await e.cleanup();}
});

test('公网DNS兼容：仅识别Fake-IP，DNS回答包含内网/保留地址仍拒绝', async () => {
 const {isFakeIp,publicDnsAnswers,validateEndpoint}=await import('../src/models/network.js');
 assert.equal(isFakeIp('198.18.0.1'),true);assert.equal(isFakeIp('127.0.0.1'),false);
 assert.deepEqual(publicDnsAnswers({Answer:[{type:1,data:'8.8.8.8'}]}),[{address:'8.8.8.8',family:4}]);
 for(const ip of ['127.0.0.1','10.0.0.1','198.18.0.3','::1'])assert.throws(()=>publicDnsAnswers({Answer:[{type:1,data:ip}]}));
 assert.throws(()=>publicDnsAnswers({Answer:[{type:1,data:'8.8.8.8'},{type:1,data:'192.168.1.1'}]}));
 assert.equal(validateEndpoint({...config,baseUrl:'https://models.example.org/v1/chat/completions'}),'https://models.example.org/v1');
 assert.equal(validateEndpoint({...config,protocol:'anthropic-messages',baseUrl:'https://models.example.org/v1/messages'}),'https://models.example.org');
});

test('项目权限：可显式调整编辑权限、版本冲突/跨账号/缺CSRF拒绝', async () => {
 const e=await fixture();
 try{
  const h=await e.login(), other=await e.login('models-b');
  const project=(await e.fx.app.inject({method:'POST',url:'/api/v1/projects',headers:h,payload:{name:'权限项目'}})).json().data;
  const owner=e.fx.db.db.prepare('SELECT owner_user_id FROM projects WHERE id=?').get(project.id) as {owner_user_id:string};
  const grantId=randomUUID(),now=new Date().toISOString();
  e.fx.db.db.prepare("INSERT INTO workspace_grants(id,project_id,canonical_root,access,revision,selected_by,excludes_json,created_at,updated_at) VALUES (?,?,?,'read',1,?,'[]',?,?)").run(grantId,project.id,e.dir,owner.owner_user_id,now,now);
  const url=`/api/v1/projects/${project.id}/grants/${grantId}`;
  assert.equal((await e.fx.app.inject({method:'PATCH',url,headers:other,payload:{access:'write',revision:1}})).statusCode,404);
  assert.equal((await e.fx.app.inject({method:'PATCH',url,headers:{cookie:h.cookie},payload:{access:'write',revision:1}})).statusCode,403);
  const upgraded=await e.fx.app.inject({method:'PATCH',url,headers:h,payload:{access:'write',revision:1}});
  assert.equal(upgraded.statusCode,200,upgraded.body);assert.equal(upgraded.json().data.access,'write');assert.equal(upgraded.json().data.revision,2);
  assert.equal((await e.fx.app.inject({method:'PATCH',url,headers:h,payload:{access:'read',revision:1}})).statusCode,409);
  assert.equal((await e.fx.app.inject({method:'PATCH',url,headers:h,payload:{access:'read',revision:2}})).statusCode,200);
  const b=(await e.fx.app.inject({method:'POST',url:'/api/v1/projects',headers:h,payload:{name:'另一个项目'}})).json().data;
  assert.equal((await e.fx.app.inject({url:`/api/v1/projects/${b.id}/grants/${grantId}`,headers:h})).statusCode,404);
 }finally{await e.cleanup();}
});


test('任务列表严格按项目隔离，追问保留会话标题与模型绑定', async () => {
 const e=await fixture();
 try{
  const h=await e.login();const app=e.fx.app;
  const a=(await app.inject({method:'POST',url:'/api/v1/projects',headers:h,payload:{name:'项目A'}})).json().data;
  const b=(await app.inject({method:'POST',url:'/api/v1/projects',headers:h,payload:{name:'项目B'}})).json().data;
  const conv=randomUUID(),now=new Date().toISOString();
  e.fx.db.db.prepare("INSERT INTO conversations(id,project_id,mode,title,last_message_seq,created_at,updated_at) VALUES (?,?,'ordinary','保留的会话标题',0,?,?)").run(conv,a.id,now,now);
  let lastRun='';
  for(const n of [1,2]){
   const problem=randomUUID();lastRun=randomUUID();
   e.fx.db.db.prepare("INSERT INTO problem_versions(id,conversation_id,version,objective,constraints_json,created_at,updated_at) VALUES (?,?,?,?,'[]',?,?)").run(problem,conv,n,n===1?'原始目标':'后续追问',now,now);
   e.fx.db.db.prepare("INSERT INTO runs(id,project_id,conversation_id,problem_version_id,mode,status,phase,round_count,config_snapshot_json,next_event_seq,created_at,updated_at) VALUES (?,?,?,?,'ordinary','succeeded','ordinary',0,?,0,?,?)").run(lastRun,a.id,conv,problem,JSON.stringify({modelConfigId:'configured-model-id',modelId:'fixture-model',contextWindow:32768}),now,now);
  }
  const listA=(await app.inject({url:`/api/v1/projects/${a.id}/runs`,headers:h})).json().data.runs;
  const listB=(await app.inject({url:`/api/v1/projects/${b.id}/runs`,headers:h})).json().data.runs;
  assert.equal(listA.length,2);assert.equal(listB.length,0);assert.ok(listA.every((r:{title:string})=>r.title==='保留的会话标题'));
  const detail=(await app.inject({url:`/api/v1/runs/${lastRun}`,headers:h})).json().data.run;
  assert.equal(detail.objective,'后续追问');assert.equal(detail.model.configId,'configured-model-id');assert.equal(detail.conversationTitle,'保留的会话标题');
  const other=await e.login('models-b');assert.equal((await app.inject({url:`/api/v1/projects/${a.id}/runs`,headers:other})).statusCode,404);
 }finally{await e.cleanup();}
});


test('agent runtime settings: authenticated private persistence, CSRF and strict bounds',async()=>{
 const e=await fixture();try{
 const a=await e.login(),b=await e.login('models-b');
 // 研究能力位与预算上限缺省值（设置→研究分区）
 const researchDefaults={researchMcpTools:true,researchSkillMethods:true,researchMemory:true,researchHostVerify:true,researchModelRequestLimit:240,researchToolRequestLimit:480};
 const defaults=await e.fx.app.inject({url:'/api/v1/agent-settings',headers:a});assert.deepEqual(defaults.json().data,{autoCompaction:true,keepRecentTurns:3,memoryEnabled:true,subagent:DEFAULT_SUBAGENT_SETTINGS,askUserQuestionAutoResolutionEnabled:true,...researchDefaults});
 const saved=await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:false,keepRecentTurns:2}});assert.equal(saved.statusCode,200);
 assert.deepEqual((await e.fx.app.inject({url:'/api/v1/agent-settings',headers:a})).json().data,{autoCompaction:false,keepRecentTurns:2,memoryEnabled:true,subagent:DEFAULT_SUBAGENT_SETTINGS,askUserQuestionAutoResolutionEnabled:true,...researchDefaults});
 assert.equal((await e.fx.app.inject({url:'/api/v1/agent-settings',headers:b})).json().data.keepRecentTurns,3);
 for(const payload of [{autoCompaction:true,keepRecentTurns:0},{autoCompaction:true,keepRecentTurns:21},{autoCompaction:true,keepRecentTurns:1.5},{autoCompaction:true,keepRecentTurns:2,mcp:true}])assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload})).statusCode,400);
 // 研究键：合法写入回读；布尔非布尔/越界数字/未知键 400（路由要求 autoCompaction/keepRecentTurns 恒在场）
 assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3,researchMcpTools:false,researchHostVerify:false,researchModelRequestLimit:200,researchToolRequestLimit:300}})).statusCode,200);
 const researchRead=await e.fx.app.inject({url:'/api/v1/agent-settings',headers:a});assert.equal(researchRead.json().data.researchMcpTools,false);assert.equal(researchRead.json().data.researchModelRequestLimit,200);assert.equal(researchRead.json().data.researchToolRequestLimit,300);
 for(const payload of [{autoCompaction:true,keepRecentTurns:3,researchMcpTools:'yes'},{autoCompaction:true,keepRecentTurns:3,researchModelRequestLimit:39},{autoCompaction:true,keepRecentTurns:3,researchModelRequestLimit:401},{autoCompaction:true,keepRecentTurns:3,researchToolRequestLimit:59},{autoCompaction:true,keepRecentTurns:3,researchToolRequestLimit:601},{autoCompaction:true,keepRecentTurns:3,researchModelRequestLimit:80.5},{autoCompaction:true,keepRecentTurns:3,unknownKey:1}])assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload})).statusCode,400);
 const changed={autoCompaction:true,keepRecentTurns:3,subagent:{enabled:false,maxSteps:5,timeoutSeconds:10}};
 assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:changed})).statusCode,200);
 assert.deepEqual((await e.fx.app.inject({url:'/api/v1/agent-settings',headers:a})).json().data.subagent,changed.subagent);
 for(const subagent of [{enabled:true,maxSteps:0,timeoutSeconds:10},{enabled:true,maxSteps:2,timeoutSeconds:0},{enabled:'yes',maxSteps:2,timeoutSeconds:10}])assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3,subagent}})).statusCode,400);
 assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:{cookie:a.cookie},payload:{autoCompaction:true,keepRecentTurns:1}})).statusCode,403);
 }finally{await e.cleanup();}
});

test('agent prompt settings: prompts persist per user, whitespace-only clears, invalid payloads fail closed',async()=>{
 const e=await fixture();try{
 const a=await e.login(),b=await e.login('models-b');
 // 全空 prompts 键被丢弃：保存后响应形状与默认一致（含研究能力位缺省）
 const cleared=await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3,prompts:{subagent:'   ',compaction:''}}});
 assert.equal(cleared.statusCode,200);assert.deepEqual(cleared.json().data,{autoCompaction:true,keepRecentTurns:3,memoryEnabled:true,subagent:DEFAULT_SUBAGENT_SETTINGS,askUserQuestionAutoResolutionEnabled:true,researchMcpTools:true,researchSkillMethods:true,researchMemory:true,researchHostVerify:true,researchModelRequestLimit:240,researchToolRequestLimit:480});
 // 合法保存：trim 后回读
 const saved=await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3,prompts:{mainAppend:' 输出一律用中文 ',subagent:'只查 data/ 目录'} }});
 assert.equal(saved.statusCode,200);assert.deepEqual(saved.json().data.prompts,{mainAppend:'输出一律用中文',subagent:'只查 data/ 目录'});
 assert.deepEqual((await e.fx.app.inject({url:'/api/v1/agent-settings',headers:a})).json().data.prompts,{mainAppend:'输出一律用中文',subagent:'只查 data/ 目录'});
 // 按用户隔离
 assert.equal((await e.fx.app.inject({url:'/api/v1/agent-settings',headers:b})).json().data.prompts,undefined);
 // 清除：不传 prompts 键=整体清除
 const removed=await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3}});
 assert.equal(removed.statusCode,200);assert.equal(removed.json().data.prompts,undefined);
 // 校验失败闭环：非字符串 / 未知键 / 超长 / prompts 非对象
 const long='x'.repeat(8001);
 for(const prompts of [{subagent:42},{subagent:'ok',mainAppend:'ok',compaction:'ok',hacker:'x'},{mainAppend:long},{subagent:long},'not-an-object'])assert.equal((await e.fx.app.inject({method:'PUT',url:'/api/v1/agent-settings',headers:a,payload:{autoCompaction:true,keepRecentTurns:3,prompts}})).statusCode,400);
 }finally{await e.cleanup();}
});
