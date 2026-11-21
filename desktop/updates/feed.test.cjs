const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createServer}=require('node:http');
const {mkdtempSync,rmSync,existsSync}=require('node:fs');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {fetchBuffer,downloadToFile,downloadGuardFor}=require('./feed.cjs');
async function serve(t,handler){const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close()});return `http://127.0.0.1:${server.address().port}`;}
test('响应头之后停止发送正文仍按总截止时间失败',async t=>{
 const base=await serve(t,(_req,res)=>{res.writeHead(200);res.write('partial')});
 await assert.rejects(fetchBuffer(base,{},()=>{},1024,80),/FEED_TIMEOUT/);
 const dir=mkdtempSync(join(tmpdir(),'update-timeout-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'pack');await assert.rejects(downloadToFile(base,()=>{},path,1024,null,80),/FEED_TIMEOUT/);assert.equal(existsSync(path),false);
});
test('下载重定向越过白名单正常拒绝，不抛出事件回调异常',async t=>{
 const base=await serve(t,(_req,res)=>res.writeHead(302,{location:'http://evil.invalid/file'}).end());
 const guard=downloadGuardFor({localFeedUrl:base});
 await assert.rejects(downloadToFile(base,guard,join(tmpdir(),'unused-prism-update'),100),/FEED_REDIRECT_DENIED/);
 assert.throws(()=>downloadGuardFor({localFeedUrl:'http://127.0.0.1.evil.invalid/feed'}),/FEED_LOCAL_SOURCE_INVALID/);
});
test('弱网断点续传：断流后Range续传，前缀重算哈希与整包校验一致',async t=>{
 const {createHash}=require('node:crypto');
 const payload=Buffer.from('A'.repeat(600)+'B'.repeat(400));
 const calls=[];
 const base=await serve(t,(req,res)=>{
  calls.push(String(req.headers.range??''));
  if(calls.length===1){res.writeHead(200,{'content-length':String(payload.length)});res.write(payload.subarray(0,300));setTimeout(()=>res.destroy(),20);return;}
  const range=/^bytes=(\d+)-$/.exec(String(req.headers.range??''));
  const start=range?Number(range[1]):0;
  res.writeHead(206,{'content-range':`bytes ${start}-${payload.length-1}/${payload.length}`,'content-length':String(payload.length-start)});
  res.end(payload.subarray(start));
 });
 const dir=mkdtempSync(join(tmpdir(),'update-resume-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'pack');
 const result=await downloadToFile(base,()=>{},path,1024,null,2000);
 assert.equal(result.size,1000);assert.equal(result.resumed,true);
 assert.equal(calls[1],'bytes=300-');
 assert.equal(result.sha256,createHash('sha256').update(payload).digest('hex'));
});
test('服务端不支持Range（200全量）：丢弃部分文件整包重来，digest仍正确',async t=>{
 const {createHash}=require('node:crypto');
 const payload=Buffer.from('C'.repeat(1000));
 const calls=[];
 const base=await serve(t,(req,res)=>{
  calls.push(String(req.headers.range??''));
  if(calls.length===1){res.writeHead(200,{'content-length':String(payload.length)});res.write(payload.subarray(0,300));setTimeout(()=>res.destroy(),20);return;}
  res.writeHead(200,{'content-length':String(payload.length)});res.end(payload);
 });
 const dir=mkdtempSync(join(tmpdir(),'update-restart-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'pack');
 const result=await downloadToFile(base,()=>{},path,1024,null,2000);
 assert.equal(result.size,1000);assert.equal(result.resumed,false);
 assert.ok(calls[1].startsWith('bytes=300-'),'续传尝试仍带Range头');
 assert.equal(result.sha256,createHash('sha256').update(payload).digest('hex'));
});
test('Range错位持续发生：尝试上限后放弃并清理部分文件',async t=>{
 const payload=Buffer.from('D'.repeat(800));
 const base=await serve(t,(req,res)=>{
  if(req.headers.range){res.writeHead(206,{'content-range':`bytes 0-${payload.length-1}/${payload.length}`,'content-length':String(payload.length)});res.end(payload);return;}
  res.writeHead(200,{'content-length':String(payload.length)});res.write(payload.subarray(0,300));setTimeout(()=>res.destroy(),20);
 });
 const dir=mkdtempSync(join(tmpdir(),'update-mismatch-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const path=join(dir,'pack');
 await assert.rejects(downloadToFile(base,()=>{},path,1024,null,2000),/FEED_RANGE_MISMATCH/);
 assert.equal(existsSync(path),false);
});
