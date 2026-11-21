import {test} from 'node:test';
import assert from 'node:assert/strict';
import {popupLayout} from '../web/ui/popupLayout.js';

test('下拉选择：上下均放得下时向下，靠近底部时向上',()=>{
 const viewport={left:0,top:0,width:1280,height:720};
 const top=popupLayout({left:300,right:500,top:100,bottom:132},viewport,{width:280,height:140});
 assert.equal(top.side,'bottom');assert.equal(top.top,136);
 const bottom=popupLayout({left:300,right:500,top:660,bottom:692},viewport,{width:280,height:240});
 assert.equal(bottom.side,'top');assert.equal(bottom.top,416);
});
test('下拉选择：长菜单、边界和带偏移视口始终容纳弹层',()=>{
 const view={left:32,top:90,width:390,height:500};
 for(const x of [-100,32,200,380,1000])for(const y of [0,90,300,550,900]){
  const p=popupLayout({left:x,right:x+160,top:y,bottom:y+32},view,{width:600,height:2000});
  assert.ok(p.left>=40);assert.ok(p.left+p.width<=414);assert.ok(p.top>=98);assert.ok(p.top+p.maxHeight<=582);assert.ok(p.width>=0&&p.maxHeight>=0);
 }
});
test('下拉选择：低高度窗口可覆盖触发器，避免弹层只剩无法操作的边',()=>{
 const p=popupLayout({left:16,right:180,top:45,bottom:77},{left:0,top:0,width:320,height:120},{width:280,height:300});
 assert.ok(p.maxHeight>=64);assert.ok(p.top>=8&&p.top+p.maxHeight<=112);
});
test('下拉选择：零尺寸与小于边距的视口不产生负尺寸',()=>{
 for(const size of [0,8,15]){
  const p=popupLayout({left:0,right:28,top:0,bottom:28},{left:0,top:0,width:size,height:size},{width:280,height:200});
  assert.ok(Number.isFinite(p.left)&&Number.isFinite(p.top));assert.equal(p.width,0);assert.equal(p.maxHeight,0);
 }
});
