import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultBindings,formatShortcut,ignoredKeyEvent,isAppleKeyboardPlatform,loadShortcutState,matchesShortcut,normalizeShortcuts,saveShortcuts,shortcutFromEvent,shortcutProblem,shouldSend,globalShortcutBlocked} from '../web/keyboardShortcuts.js';
const base={key:'n',code:'KeyN',ctrlKey:false,metaKey:false,shiftKey:false,altKey:false,isComposing:false};
for(const platform of ['darwin','MacIntel','win32','Win32','linux','Linux x86_64']) {
 test(`${platform}: isolated primary modifier, labels, send and thinking`,()=>{
  const info={platform},apple=/darwin|Mac/.test(platform),primary={...base,metaKey:apple,ctrlKey:!apple};
  assert.equal(shortcutFromEvent(primary,info),'Mod+N');
  assert.equal(shortcutFromEvent({...primary,metaKey:!apple,ctrlKey:apple},info),null);
  assert.equal(shortcutFromEvent({...primary,metaKey:true,ctrlKey:true},info),null);
  assert.equal(formatShortcut('Mod+N',info),apple?'⌘ N':'Ctrl+N');
  assert.equal(formatShortcut('',info),'');
  assert.ok(matchesShortcut({...primary,key:'y',code:'KeyY',shiftKey:true},defaultBindings().thinking,info));
  assert.ok(!matchesShortcut({...primary,key:'t',code:'KeyT'},defaultBindings().thinking,info));
  assert.ok(shouldSend({...primary,key:'Enter',code:'Enter'},'modifier-enter',info));
  assert.ok(!shouldSend({...primary,key:'Enter',code:'Enter'},'enter',info));
  assert.ok(shouldSend({...base,key:'Enter',code:'Enter'},'enter',info));
  for(const patch of [{shiftKey:true},{altKey:true},{isComposing:true},{repeat:true},{keyCode:229},{getModifierState:(key:string)=>key==='AltGraph'}])
   assert.ok(!shouldSend({...primary,key:'Enter',code:'Enter',...patch},'modifier-enter',info));
 });
}
test('native editing, reserved keys and registered search conflicts',()=>{
 const bindings=defaultBindings();
 for(const combo of ['Mod+C','Mod+V','Mod+X','Mod+A','Mod+Z','Mod+Shift+Z','Mod+T','Mod+W','Mod+1','Alt+F4','Alt+N','Mod+Enter','Ctrl+N','Mod+Shift+Shift+N','Mod+💥']) assert.ok(shortcutProblem(bindings,'newTask',combo),combo);
 assert.match(shortcutProblem(bindings,'newTask','Mod+G')??'',/冲突/);
 assert.match(shortcutProblem(bindings,'newTask','Mod+K')??'',/冲突/);
 assert.match(shortcutProblem(bindings,'newTask','Mod+Shift+Y')??'',/冲突/);
 assert.equal(shortcutProblem(bindings,'newTask',''),null);
 assert.equal(shortcutProblem(bindings,'newTask','Mod+Shift+N'),null);
});
test('IME, repeats, AltGraph and prevented events never match',()=>{
 for(const patch of [{isComposing:true},{keyCode:229},{repeat:true},{defaultPrevented:true},{getModifierState:()=>true}]) {
  assert.ok(ignoredKeyEvent({...base,...patch}));
  assert.equal(shortcutFromEvent({...base,ctrlKey:true,...patch},{platform:'linux'}),null);
 }
 assert.equal(shortcutFromEvent({...base,ctrlKey:true,altKey:true,key:'ø',code:'KeyO'},{platform:'linux'}),'Mod+Alt+O');
});
test('legacy migration retains valid overrides and clears invalid or duplicate bindings',()=>{
 const result=normalizeShortcuts({newTask:'Mod+G',settings:'Mod+C',sidebar:'',find:'Mod+G',focusInput:42});
 assert.equal(result.bindings.newTask,'Mod+G');assert.equal(result.bindings.search,'');
 assert.equal(result.bindings.settings,'');assert.equal(result.bindings.sidebar,'');assert.equal(result.bindings.find,'');
 assert.ok(result.notices.length>=4);assert.equal(result.bindings.thinking,'Mod+Shift+Y');
 const swapped=normalizeShortcuts({version:2,bindings:{...defaultBindings(),newTask:'Mod+B',sidebar:'Mod+N'}});
 assert.equal(swapped.bindings.newTask,'Mod+B');assert.equal(swapped.bindings.sidebar,'Mod+N');assert.deepEqual(swapped.notices,[]);
 for(const raw of [null,[],true,{version:2,bindings:null}]) assert.deepEqual(normalizeShortcuts(raw).bindings,defaultBindings());
});
test('save/load cleared and custom bindings round trip; malformed config is explained',()=>{
 const original=Object.getOwnPropertyDescriptor(globalThis,'localStorage');const storage=new Map<string,string>();
 Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)}});
 try {
  const bindings={...defaultBindings(),search:'',searchAlternate:'',thinking:'Mod+Shift+U'};
  saveShortcuts('matrix',bindings);assert.deepEqual(loadShortcutState('matrix'),{bindings,notices:[]});
  storage.set('prism-shortcuts:matrix','{');assert.ok(loadShortcutState('matrix').notices.length);
  assert.throws(()=>saveShortcuts('matrix',{...bindings,find:'Mod+C'}));
 } finally { if(original)Object.defineProperty(globalThis,'localStorage',original);else Reflect.deleteProperty(globalThis,'localStorage'); }
});
test('host platform overrides browser fallback; modal guard detects local ownership',()=>{
 const win=Object.getOwnPropertyDescriptor(globalThis,'window'),nav=Object.getOwnPropertyDescriptor(globalThis,'navigator'),doc=Object.getOwnPropertyDescriptor(globalThis,'document');
 try {
  Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',userAgent:'Mac'}});
  Object.defineProperty(globalThis,'window',{configurable:true,value:{prismPlatform:Object.freeze({platform:'win32'})}});
  assert.equal(isAppleKeyboardPlatform(),false);
  Object.defineProperty(globalThis,'window',{configurable:true,value:{}});assert.equal(isAppleKeyboardPlatform(),true);
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:(selector:string)=>selector.includes('aria-modal')?{}:null}});assert.ok(globalShortcutBlocked());
  Object.defineProperty(globalThis,'document',{configurable:true,value:{querySelector:()=>null}});assert.ok(!globalShortcutBlocked());
 } finally { for(const [key,value] of [['window',win],['navigator',nav],['document',doc]] as const) {if(value)Object.defineProperty(globalThis,key,value);else Reflect.deleteProperty(globalThis,key);} }
});

test('Electron window accelerators cannot be assigned or restored from storage',()=>{
 const bindings=defaultBindings();
 for(const combo of ['Mod+M','Mod+Shift+M','Mod+-','Mod+Shift+-','Mod+=','Mod+Shift+=','Mod+0','Mod+Shift+0','F11','Mod+F11','Alt+F11','Ctrl+Meta+F']) {
  assert.ok(shortcutProblem(bindings,'newTask',combo),combo);
  const restored=normalizeShortcuts({version:2,bindings:{...bindings,newTask:combo}});
  assert.equal(restored.bindings.newTask,'');assert.ok(restored.notices.length,combo);
 }
 assert.equal(shortcutFromEvent({...base,key:'F11',code:'F11'},{platform:'win32'}),null);
 assert.equal(shortcutFromEvent({...base,key:'f',code:'KeyF',ctrlKey:true,metaKey:true},{platform:'darwin'}),null);
});
test('shifted punctuation records and matches canonical code on every platform',()=>{
 const punctuation=[['Slash','?','/'],['Comma','<',','],['Period','>','.'],['Semicolon',':',';'],['BracketLeft','{','['],['BracketRight','}',']'],['Backslash','|',String.fromCharCode(92)],['Backquote','~','`'],['Minus','_','-'],['Equal','+','=']];
 for(const platform of ['darwin','win32','linux']) for(const [code,key,canonical] of punctuation) {
  const event={...base,code,key:key!,ctrlKey:platform!=='darwin',metaKey:platform==='darwin',shiftKey:true};
  const binding=`Mod+Shift+${canonical}`;
  assert.equal(shortcutFromEvent(event,{platform}),binding);
  assert.ok(matchesShortcut(event,binding,{platform}));
  if(code==='Slash')assert.equal(shortcutProblem(defaultBindings(),'newTask',binding),null);
 }
});
