const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtempSync,writeFileSync,rmSync}=require('node:fs');
const {join}=require('node:path');
const {tmpdir}=require('node:os');
const {execFileSync}=require('node:child_process');
const script=join(__dirname,'../../scripts/release/publish-release.mjs');
test('发行dry-run不连接远端；拒绝把非发行文件当附件上传',()=>{
 const dir=mkdtempSync(join(tmpdir(),'prism-publish-'));
 try{
  const asset=join(dir,'Prism-0.0.5-beta-mac-arm64.dmg'),notes=join(dir,'notes.md');writeFileSync(asset,'synthetic');writeFileSync(notes,'notes');
  const args=[script,'--repo','Example/prism-releases','--tag','v0.0.5-beta','--title','棱镜 Prism 0.0.5-beta','--notes-file',notes,'--assets',asset];
  const output=execFileSync(process.execPath,args,{encoding:'utf8',env:{...process.env,PATH:'/missing-gh-cli'}});assert.match(output,/dry-run/);
  const bad=join(dir,'credential-master.key');writeFileSync(bad,'synthetic');
  assert.throws(()=>execFileSync(process.execPath,[...args.slice(0,-1),bad],{stdio:'pipe'}),/Command failed/);
  const pack=join(__dirname,'../../scripts/release/build-update-pack.mjs');
  assert.throws(()=>execFileSync(process.execPath,[pack,'--business-version','0.0.6-beta','--release-id','invalid-source','--update-sequence','2','--source-sha','e5b3028','--key',asset],{stdio:'pipe'}),error=>error.status===2&&String(error.stderr).includes('40位'));
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('草稿无Git标签时按发行ID定位并继续；禁止覆盖正式发行或夹带附件',()=>{
 const fs=require('node:fs'),{createHash}=require('node:crypto');
 const dir=mkdtempSync(join(tmpdir(),'prism-draft-'));
 try{
  const asset=join(dir,'SHA256SUMS.txt'),notes=join(dir,'notes.md'),state=join(dir,'state.json'),calls=join(dir,'calls.jsonl');
  writeFileSync(asset,'synthetic');writeFileSync(notes,'notes\n');
  const release={id:7,tag_name:'v0.0.5-beta',draft:true,name:'棱镜 Prism 0.0.5-beta',body:'notes\n',prerelease:true,assets:[{name:'SHA256SUMS.txt',state:'uploaded',size:9,digest:'sha256:'+createHash('sha256').update('synthetic').digest('hex')}]};
  writeFileSync(state,JSON.stringify(release));
  const fake=join(dir,'gh');
  writeFileSync(fake,'#!'+process.execPath+'\n'+`
const fs=require('node:fs'),args=process.argv.slice(2),state=${JSON.stringify(state)},calls=${JSON.stringify(calls)};
fs.appendFileSync(calls,JSON.stringify(args)+'\\n');
if(args[0]==='api'&&args[1].includes('/releases?'))process.stdout.write('7\\n');
else if(args[0]==='api'&&args[1].endsWith('/releases/7'))process.stdout.write(fs.readFileSync(state));
else if(args[0]==='release'&&args[1]==='edit'){}
else {process.stderr.write('unexpected GH operation '+JSON.stringify(args));process.exit(8);}
`,{mode:0o755});
  const args=[script,'--repo','Example/prism-releases','--tag','v0.0.5-beta','--title','棱镜 Prism 0.0.5-beta','--notes-file',notes,'--assets',asset,'--resume-draft','--publish'];
  const run=extra=>execFileSync(process.execPath,args,{encoding:'utf8',stdio:'pipe',env:{...process.env,PATH:dir,...extra}});
  assert.match(run({}),/已发布/);
  let operations=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(operations.filter(a=>a[0]==='release'&&a[1]==='edit').length,1);
  assert.equal(operations.some(a=>a.includes('upload')||a[1]?.includes('/releases/tags/')),false);
  for(const changed of [{...release,draft:false},{...release,assets:[...release.assets,{name:'credential-master.key',state:'uploaded'}]}]){
   writeFileSync(calls,'');writeFileSync(state,JSON.stringify(changed));
   assert.throws(()=>run({}),/Command failed/);
   operations=fs.readFileSync(calls,'utf8').trim().split('\n').map(JSON.parse);
   assert.equal(operations.some(a=>a[0]==='release'),false);
  }
 }finally{rmSync(dir,{recursive:true,force:true})}
});
