// Electron自检入口：真实桌面主进程＋隔离资料；测试钩子不进入正式业务包。
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const {app,session}=require('electron');
const arg=name=>process.argv[process.argv.indexOf(name)+1];
const source=path.resolve(arg('--workspace')),out=path.resolve(arg('--out')),node=path.resolve(arg('--node')),hostInfo=JSON.parse(fs.readFileSync(arg('--host-info')));
if(!out.replaceAll('\\','/').includes('/.cache/verification/'))throw new Error('自检仅允许隔离目录');
const workspace=path.join(out,'workspace');fs.mkdirSync(workspace,{recursive:true});
for(const name of ['dist','web-dist','resources','desktop','package.json','pnpm-lock.yaml'])fs.cpSync(path.join(source,name),path.join(workspace,name),{recursive:true});
fs.symlinkSync(path.resolve(arg('--dependencies')),path.join(workspace,'node_modules'),process.platform==='win32'?'junction':'dir');
const receipt=JSON.parse(fs.readFileSync(path.join(source,'../receipt.json'))),pkg=JSON.parse(fs.readFileSync(path.join(source,'package.json')));
fs.writeFileSync(path.join(workspace,'desktop/build-info.json'),JSON.stringify({...hostInfo,businessVersion:pkg.version,sourceSha:receipt.gitHead})+'\n');
const data=path.join(out,'data'),profile=path.join(out,'profile');fs.mkdirSync(data,{recursive:true});fs.mkdirSync(profile,{recursive:true});
const seed=path.join(out,'seed.json');
execFileSync(node,[path.join(__dirname,'seed-downloads.mjs'),workspace,data,seed],{stdio:'inherit',env:{...process.env,PRISM_DESKTOP_TOKEN:''}});
const fixtures=JSON.parse(fs.readFileSync(seed));
process.env.PRISM_DATA_DIR=data;process.env.PRISM_DESKTOP_PROFILE=profile;process.env.PRISM_NODE_PATH=node;process.env.PRISM_UPDATES_ACCEPTANCE=path.join(out,'result.json');
app.getAppPath=()=>workspace;app.getVersion=()=>hostInfo.hostVersion;
const hook=path.join(workspace,'desktop/updates/acceptance.cjs');
require.cache[hook]={id:hook,filename:hook,loaded:true,exports:run};
require(path.join(workspace,'desktop/main.cjs'));
async function run({window}){
 const report={pass:false,productVersion:pkg.version,sourceSha:receipt.gitHead,layout:[],downloads:[]};
 const evaluate=script=>window.webContents.executeJavaScript(script);
 const wait=async predicate=>{const deadline=Date.now()+45000;while(Date.now()<deadline){try{if(await predicate())return;}catch{}await new Promise(r=>setTimeout(r,100));}throw new Error('等待页面状态超时');};
 const frame=()=>evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
 const fill=(selector,value)=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)throw Error('找不到输入项');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const loginReady=()=>wait(()=>evaluate("!!document.querySelector('#login-password')&&!document.querySelector('.login-form fieldset').disabled"));
 try{
  await loginReady();window.setMinimumSize(0,0);
  for(const theme of ['dark','light']){
   await evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
   for(const [width,height,zoom] of [[1470,825,1],[1320,800,1],[780,560,1],[1320,880,1.25],[390,640,1]]){
    window.setContentSize(width,height);window.webContents.setZoomFactor(zoom);await frame();
    for(const mode of ['login','register']){
     const creating=await evaluate("!!document.querySelector('#login-confirmation')");
     if(creating!==(mode==='register')){await evaluate("document.querySelector('.login-mode button').click()");await wait(()=>evaluate(`!!document.querySelector('#login-confirmation')===${mode==='register'}`));}
     await evaluate("document.querySelector('#login-username').focus()");await frame();
     const metrics=await evaluate(`(()=>{const entry=document.querySelector('.login-entry'),input=document.querySelector('#login-username'),e=entry.getBoundingClientRect(),i=input.getBoundingClientRect(),button=document.querySelector('.login-submit');button.scrollIntoView({block:'center'});const b=button.getBoundingClientRect();return {viewport:[innerWidth,innerHeight],entryOverflow:getComputedStyle(entry).overflowY,entryScrollHeight:entry.scrollHeight,entryHeight:entry.clientHeight,focusClearance:[i.left-e.left,e.right-i.right],buttonVisible:b.top>=0&&b.bottom<=innerHeight+1,horizontalOverflow:document.querySelector('.login-screen').scrollWidth>innerWidth+1};})()`);
     assert.equal(metrics.entryOverflow,'visible');assert.ok(metrics.focusClearance.every(n=>n>=4));assert.equal(metrics.buttonVisible,true);assert.equal(metrics.horizontalOverflow,false);
     report.layout.push({theme,mode,width,height,zoom,...metrics});
     if(width===1470||width===390){await evaluate("document.querySelector('.login-screen').scrollTop=0");await frame();fs.writeFileSync(path.join(out,`${theme}-${mode}-${width}.png`),(await window.webContents.capturePage()).toPNG());}
    }
   }
  }
  window.setContentSize(1320,880);window.webContents.setZoomFactor(1);
  if(!await evaluate("!!document.querySelector('#login-confirmation')"))await evaluate("document.querySelector('.login-mode button').click()");
  await fill('#login-username','flow-new');await fill('#login-password','中');await fill('#login-confirmation','中');await evaluate("document.querySelector('.login-form').requestSubmit()");
  await wait(()=>evaluate("document.querySelector('#login-error')?.textContent.includes('汉字')"));
  await fill('#login-password','!');await fill('#login-confirmation','?');await evaluate("document.querySelector('.login-form').requestSubmit()");
  await wait(()=>evaluate("document.querySelector('#login-error')?.textContent.includes('两次密码')"));
  await fill('#login-confirmation','!');await evaluate("document.querySelector('.login-form').requestSubmit()");
  await wait(()=>evaluate("!document.querySelector('.login-screen')&&document.body.innerText.includes('flow-new')"));
  const denied=await evaluate(`fetch(${JSON.stringify(fixtures.entries[2].url)}).then(r=>r.status)`);assert.equal(denied,404);
  await evaluate("fetch('/api/v1/auth/me').then(r=>r.json()).then(j=>fetch('/api/v1/auth/logout',{method:'POST',headers:{'x-csrf-token':j.data.csrfToken}}))");
  await window.webContents.reload();await loginReady();await fill('#login-username','flow-user');await fill('#login-password','1');await evaluate("document.querySelector('.login-form').requestSubmit()");
  await wait(()=>evaluate("!document.querySelector('.login-screen')&&document.body.innerText.includes('flow-user')"));
  report.auth={oneCharacterRegister:true,oneCharacterLogin:true,hanRejected:true,confirmationMismatchRejected:true,otherAccountArtifactStatus:denied};
  let pending;
  const downloads=path.join(out,'downloads');fs.mkdirSync(downloads);
  session.defaultSession.on('will-download',(event,item)=>{
   if(!pending){event.preventDefault();return;}
   const task=pending;pending=null;const actualName=item.getFilename();
   item.setSavePath(path.join(downloads,task.name));
   item.once('done',(_event,state)=>{try{assert.equal(state,'completed');assert.equal(actualName,task.name);const bytes=fs.readFileSync(item.getSavePath()),sha256=crypto.createHash('sha256').update(bytes).digest('hex');if(task.sha256)assert.equal(sha256,task.sha256);task.resolve({kind:task.kind,name:actualName,bytes:bytes.length,sha256});}catch(error){task.reject(error);}});
  });
  async function download(entry,trigger){
   const completed=new Promise((resolve,reject)=>{pending={...entry,resolve,reject};});
   await evaluate(trigger??`(()=>{const a=document.createElement('a');a.href=${JSON.stringify(entry.url)};a.download=${JSON.stringify(entry.name)};document.body.append(a);a.click();a.remove();})()`);
   let timer;try{const result=await Promise.race([completed,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('下载超时：'+entry.kind)),45000);})]);report.downloads.push(result);console.log('DOWNLOAD_PASS',result.kind,result.bytes);}finally{clearTimeout(timer);}
  }
  for(const entry of fixtures.entries.slice(0,2))await download(entry);
  await evaluate("[...document.querySelectorAll('.ps-task-select')].find(el=>el.textContent.includes('下载功能验收')).click()");
  await wait(()=>evaluate("document.querySelectorAll('.artifact-card').length===2"));
  for(const entry of fixtures.entries.slice(2,4))await download(entry,`[...document.querySelectorAll('.artifact-card')].find(el=>el.textContent.includes(${JSON.stringify(entry.name)})).click()`);
  for(const entry of fixtures.entries.slice(4)){
   if(entry.kind==='研究导出'){
    const canonical=await evaluate(`fetch('/api/v1/runs/${fixtures.research.runId}/research').then(r=>r.json()).then(j=>JSON.stringify(j.data,null,2))`);
    entry.sha256=crypto.createHash('sha256').update(canonical).digest('hex');
   }
   await download(entry);
  }
  window.webContents.send('updates:menu');await wait(()=>evaluate("document.body.innerText.includes('应用内更新')"));
  await evaluate("[...document.querySelectorAll('.settings-nav-item,button')].find(el=>el.textContent.trim()==='账号与数据')?.click()");
  const configButton=await evaluate("[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='导出 JSON')?.textContent || ''");
  if(!configButton)throw Error('找不到设置导出入口');
  await download({kind:'设置导出',name:'Prism-设置.json'},"[...document.querySelectorAll('button')].find(el=>el.textContent.trim()==='导出 JSON').click()");
  const settings=JSON.parse(fs.readFileSync(path.join(downloads,'Prism-设置.json'),'utf8'));assert.equal(JSON.stringify(settings).includes('synthetic-only'),false);
  report.pass=true;console.log('AUTH_LAYOUT_AND_DOWNLOAD_FLOWS_PASS');
 }finally{fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)+'\n');}
 app.quit();
}
