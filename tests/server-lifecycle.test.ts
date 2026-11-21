import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('服务关闭会释放真实监听端口，不留下已关闭DB的僵尸服务', async () => {
 const data=mkdtempSync(join(tmpdir(),'prism-lifecycle-'));
 const portProbe=createServer();await new Promise<void>(r=>portProbe.listen(0,'127.0.0.1',r));const port=(portProbe.address() as {port:number}).port;await new Promise<void>(r=>portProbe.close(()=>r()));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.js',import.meta.url))],{env:{...process.env,DEBATE_DATA_DIR:data,DEBATE_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 try {
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('START_TIMEOUT')),10000);child.stdout.on('data',chunk=>{if(String(chunk).includes('本地工作台')){clearTimeout(timer);resolve();}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);if(code)reject(new Error('START_FAILED'));});});
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/health`)).status,200);
  await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('SHUTDOWN_TIMEOUT')),5000);child.once('exit',code=>{clearTimeout(timer);assert.equal(code,0);resolve();});child.kill('SIGTERM');});
 }finally{if(child.exitCode===null)child.kill('SIGKILL');rmSync(data,{recursive:true,force:true});}
});
