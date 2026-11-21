import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpsServer, type Server } from 'node:https';
import { streamingPinnedFetch, RUNTIME_STREAM_PROFILE, type StreamProfile } from '../src/models/streamNetwork.js';
import { ApiError } from '../contracts/errors.js';

// 受控本机HTTPS上游：独立测试证书（openssl自签，127.0.0.1 SAN）。
// allowLoopbackForTest 仅由测试显式注入（计划§12：受控上游通过可信测试构建注入，无环境/浏览器开关）。
interface Fixture { server: Server; url: (path: string) => string; certPem: string }

async function httpsFixture(t: { after(fn: () => unknown): unknown }): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), 't04-stream-'));
  const cert = join(dir, 'cert.pem'), key = join(dir, 'key.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', key, '-out', cert,
    '-days', '2', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const certPem = readFileSync(cert, 'utf8');
  const server = createHttpsServer({ key: readFileSync(key, 'utf8'), cert: certPem }, (_req, res) => {
    res.statusCode = 500; res.end('unhandled');
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const port = (server.address() as { port: number }).port;
  t.after(() => {
    server.closeAllConnections();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { server, certPem, url: (path: string) => `https://127.0.0.1:${port}${path}` };
}

const profile: StreamProfile = { ...RUNTIME_STREAM_PROFILE, caCertPem: '', allowLoopbackForTest: true };

test('受控上游真流式：首片在end之前到达、逐片转发、状态头即时返回', async t => {
  const f = await httpsFixture(t);
  let endedAt = 0;
  f.server.removeAllListeners('request');
  f.server.on('request', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"chunk":1}\n\n');
    setTimeout(() => { res.write('data: {"chunk":2}\n\n'); res.end(); endedAt = Date.now(); }, 300);
  });
  const { injectHeaders } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...profile, caCertPem: f.certPem });
  const fetcher = injectHeaders({ 'x-test': '1' });
  const controller = new AbortController();
  const response = await fetcher(f.url('/_runtime/v1/model/chat/completions'), {
    method: 'POST', body: '{"model":"m"}', signal: controller.signal,
    headers: { 'content-type': 'application/json' },
  } as RequestInit);
  assert.equal(response.status, 200);
  assert.ok(endedAt === 0 || Date.now() <= endedAt + 5, '响应头必须在end之前返回（endedAt仍为0或刚结束）');
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let firstTextAt = 0; const received: string[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!firstTextAt) firstTextAt = Date.now();
    received.push(decoder.decode(value));
  }
  assert.ok(firstTextAt <= endedAt + 5, '首片必须不晚于end到达');
  assert.ok(received.join('').includes('"chunk":1') && received.join('').includes('"chunk":2'), '逐片完整转发');
});

test('客户端取消：上游socket关闭（服务端连接终止）', async t => {
  const f = await httpsFixture(t);
  let clientClosed = false;
  f.server.removeAllListeners('request');
  f.server.on('request', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: start\n\n');
    res.on('close', () => { clientClosed = true; });
    // 服务端保持不end
  });
  const { fetch } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...profile, caCertPem: f.certPem });
  const controller = new AbortController();
  const response = await fetch(f.url('/_runtime/v1/model/chat/completions'), {
    method: 'POST', body: '{}', signal: controller.signal, headers: { 'content-type': 'application/json' },
  } as RequestInit);
  const reader = response.body!.getReader();
  await reader.read(); // 消费首片
  controller.abort();
  await assert.rejects(() => reader.read());
  await new Promise(r => setTimeout(r, 150));
  assert.equal(clientClosed, true, '取消必须终止上游连接');
});

test('空闲超时：有数据后停滞触发MODEL_TIMEOUT，收到数据即重置', async t => {
  const f = await httpsFixture(t);
  const idleProfile: StreamProfile = { ...profile, idleTimeoutMs: 400 };
  f.server.removeAllListeners('request');
  f.server.on('request', (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: one\n\n');
    setTimeout(() => res.write('data: two\n\n'), 250); // < 400ms：重置空闲计时
    // 之后不再发送
  });
  const { fetch } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...idleProfile, caCertPem: f.certPem });
  const controller = new AbortController();
  const response = await fetch(f.url('/_runtime/v1/model/chat/completions'), {
    method: 'POST', body: '{}', signal: controller.signal,
  } as RequestInit);
  const reader = response.body!.getReader();
  const start = Date.now();
  let readError: unknown;
  try {
    for (;;) { const { done } = await reader.read(); if (done) break; }
  } catch (e) { readError = e; }
  assert.ok(readError instanceof ApiError && readError.code === 'MODEL_TIMEOUT', `期望MODEL_TIMEOUT，实际 ${String(readError)}`);
  assert.ok(Date.now() - start >= 350 && Date.now() - start < 2000, '空闲超时按停滞时间触发');
});

test('响应大小上限：超过配置上限即中断', async t => {
  const f = await httpsFixture(t);
  const capProfile: StreamProfile = { ...profile, responseLimitBytes: 4096, idleTimeoutMs: 0 };
  f.server.removeAllListeners('request');
  f.server.on('request', (_req, res) => {
    res.writeHead(200);
    const chunk = Buffer.alloc(1024, 0x61);
    const timer = setInterval(() => { res.write(chunk); }, 5);
    res.on('close', () => clearInterval(timer));
  });
  const { fetch } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...capProfile, caCertPem: f.certPem });
  const response = await fetch(f.url('/_runtime/v1/model/chat/completions'), { method: 'POST', body: '{}' } as RequestInit);
  const reader = response.body!.getReader();
  let readError: unknown;
  try { for (;;) { const { done } = await reader.read(); if (done) break; } }
  catch (e) { readError = e; }
  assert.ok(readError instanceof ApiError && readError.code === 'INPUT_TOO_LARGE', `期望INPUT_TOO_LARGE，实际 ${String(readError)}`);
});

test('请求体上限与越界URL拒绝', async t => {
  const f = await httpsFixture(t);
  const smallProfile: StreamProfile = { ...profile, requestBodyLimitBytes: 64 };
  const { fetch } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...smallProfile, caCertPem: f.certPem });
  await assert.rejects(
    () => fetch(f.url('/_runtime/v1/model/chat/completions'), { method: 'POST', body: 'x'.repeat(65) } as RequestInit),
    (e: unknown) => e instanceof ApiError && e.code === 'INPUT_TOO_LARGE');
  await assert.rejects(
    () => fetch(f.url('/other/path'), { method: 'POST', body: '{}' } as RequestInit),
    (e: unknown) => e instanceof ApiError && e.code === 'POLICY_DENIED');
  await assert.rejects(
    () => fetch(`${f.url('/_runtime/v1/model')}?extra=1`, { method: 'POST', body: '{}' } as RequestInit),
    (e: unknown) => e instanceof ApiError && e.code === 'POLICY_DENIED');
});

test('回环地址作为上游host默认被策略拒绝（未注入测试放行时）', async t => {
  // 未设置allowLoopbackForTest的生产profile：127.0.0.1解析结果属受限地址。
  const f = await httpsFixture(t);
  const { fetch } = streamingPinnedFetch(f.url('/_runtime/v1/model'), { ...RUNTIME_STREAM_PROFILE, caCertPem: f.certPem, connectTimeoutMs: 3000 });
  await assert.rejects(
    () => fetch(f.url('/_runtime/v1/model/chat/completions'), { method: 'POST', body: '{}' } as RequestInit),
    (e: unknown) => e instanceof ApiError && e.code === 'POLICY_DENIED');
});


test('网关注入头保留Headers和Request中的认证与内容类型', async t => {
 const f=await httpsFixture(t);f.server.removeAllListeners('request');
 const received: Array<Record<string,unknown>>=[];
 f.server.on('request',(req,res)=>{received.push({auth:req.headers.authorization,key:req.headers['x-api-key'],type:req.headers['content-type'],id:req.headers['x-prism-request-id']});req.resume();res.end('ok');});
 const send=streamingPinnedFetch(f.url('/runtime/v1'),{...profile,caCertPem:f.certPem}).injectHeaders({'x-prism-request-id':'r-1'});
 const h=new Headers({'authorization':'Bearer fixture-secret','content-type':'application/json','x-api-key':'fixture-anthropic'});
 await (await send(f.url('/runtime/v1/chat/completions'),{method:'POST',headers:h,body:'{}'})).text();
 await (await send(new Request(f.url('/runtime/v1/chat/completions'),{method:'POST',headers:h,body:'{}'}))).text();
 assert.equal(received.length,2);
 for(const row of received)assert.deepEqual(row,{auth:'Bearer fixture-secret',key:'fixture-anthropic',type:'application/json',id:'r-1'});
});
