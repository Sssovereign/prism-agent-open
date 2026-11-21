import{test}from'node:test';import assert from'node:assert/strict';import{ChannelEndpoint,MAX_FRAME_BYTES}from'../src/agent/protocol.js';
test('验收：过大控制响应立即返回明确错误，而非丢帧等待超时',async()=>{
 let caller:ChannelEndpoint;const peer=new ChannelEndpoint('agent',data=>caller.feed(data),(_frame,respond)=>respond(true,{text:'x'.repeat(MAX_FRAME_BYTES)}));
 caller=new ChannelEndpoint('agent',data=>peer.feed(data),()=>{});
 try{await assert.rejects(caller.request('heartbeat',{},1000),(e:unknown)=>!!e&&typeof e==='object'&&'code'in e&&e.code==='INPUT_TOO_LARGE');}finally{caller.close();peer.close();}
});
