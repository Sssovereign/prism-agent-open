<script setup lang="ts">
import {computed,onBeforeUnmount,ref} from 'vue';
import {v1} from '../api.js';
const props=defineProps<{runId:string;invocationId:string}>();
interface Page {available:boolean;offset:number;text:string;total:number;nextOffset:number|null;sourceTruncated:boolean}
const page=ref<Page>(),busy=ref(false),error=ref(''),visible=ref(false);let generation=0,abort:AbortController|undefined;
const base=computed(()=>`/api/v1/runs/${encodeURIComponent(props.runId)}/conversation/tools/${encodeURIComponent(props.invocationId)}/result`);
async function load(offset=0){const current=++generation;abort?.abort();const controller=new AbortController();abort=controller;busy.value=true;error.value='';visible.value=true;try{const result=await v1<Page>(`${base.value}?offset=${offset}&limit=16384`,{signal:abort.signal});if(current===generation)page.value=result;}catch(e){if(current===generation&&!controller.signal.aborted)error.value=e instanceof Error?e.message:'完整结果读取失败';}finally{if(current===generation)busy.value=false;}}
function close(){generation++;abort?.abort();page.value=undefined;visible.value=false;busy.value=false;error.value='';}
onBeforeUnmount(close);
</script>
<template><section class="full-result"><button v-if="!visible" type="button" @click="load()">查看完整持久化结果（分页）</button><template v-else><header><strong>完整持久化结果 · JSON</strong><button type="button" @click="close">关闭</button></header><p>每页最多16384个字符，翻页替换当前页，不累积加载。</p><p v-if="page?.sourceTruncated" role="status">执行时已截断采集。这是全部已保存结果，不包含当时未捕获的内容，无法从历史恢复。</p><p v-if="error" role="alert">{{error}} <button type="button" @click="load(page?.offset??0)">重试</button></p><p v-if="busy" role="status">正在读取…</p><template v-if="page"><pre v-if="page.available" tabindex="0">{{page.text}}</pre><p v-else>尚无持久化结果。</p><nav aria-label="工具结果分页"><button type="button" :disabled="busy||page.offset===0" @click="load(Math.max(0,page.offset-16384))">上一页</button><span>第{{Math.floor(page.offset/16384)+1}}页 / {{Math.max(1,Math.ceil(page.total/16384))}}页 · {{page.total}}字符</span><button type="button" :disabled="busy||page.nextOffset===null" @click="load(page.nextOffset??0)">下一页</button></nav><a v-if="page.available" :href="`${base}/download`" download>下载全部已保存结果（JSON）</a></template></template></section></template>
<style scoped>
.full-result{border-top:1px solid #8883;margin-top:14px;padding-top:12px;font-size:12px;min-width:0}header,nav{display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap}p{opacity:.75}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:420px;overflow:auto;background:#8881;padding:12px;border-radius:6px}button,a{cursor:pointer}nav{margin:10px 0}a{color:inherit;text-decoration:underline}
</style>
