<script setup lang="ts">
// 阶段④执行交接：可编辑执行草稿（目标/依据/范围/验收项）——用户确认后填回普通输入，
// 结构化验收项经 create 的 researchHandoff 下发（正文注入与快照冻结由后端完成）。
import{ref}from'vue';
import type{ResearchHandoffPrefill}from'./ResearchPanel.vue';
const props=defineProps<{prefill:ResearchHandoffPrefill;sourceRunId:string}>(),emit=defineEmits<{(e:'close'):void;(e:'confirm',payload:{objectiveText:string;sourceRunId:string;items:string[]}):void}>();
const goal=ref(props.prefill.goal),basis=ref(props.prefill.basis),scope=ref(props.prefill.scope);
const items=ref<string[]>(props.prefill.items.length?props.prefill.items:['']);
function addItem(){if(items.value.length<20)items.value=[...items.value,''];}
function removeItem(index:number){items.value=items.value.length>1?items.value.filter((_,i)=>i!==index):[''];}
function confirm(){
 const clean=items.value.map(item=>item.trim()).filter(item=>item);
 if(!goal.value.trim()||!clean.length)return;
 const sections=[goal.value.trim()];
 if(basis.value.trim())sections.push(`依据：${basis.value.trim()}`);
 if(scope.value.trim())sections.push(`范围：${scope.value.trim()}`);
 emit('confirm',{objectiveText:sections.join('\n\n'),sourceRunId:props.sourceRunId,items:clean});
}
</script>
<template>
 <div class="handoff-scrim" @click.self="emit('close')">
  <section class="handoff-dialog" role="dialog" aria-modal="true" aria-label="执行草稿交接">
   <header><h2>交接执行草稿</h2><button class="icon-btn" type="button" aria-label="关闭" @click="emit('close')">×</button></header>
   <p class="handoff-note">草稿可编辑；确认后填入普通任务输入，验收项将进入任务正文与研究交接快照。</p>
   <label>目标<textarea v-model="goal" rows="2" maxlength="2000"></textarea></label>
   <label>依据与证据引用<textarea v-model="basis" rows="3" maxlength="2000" placeholder="来自研究结论的主张与证据引用，可编辑"></textarea></label>
   <label>范围<textarea v-model="scope" rows="2" maxlength="2000" placeholder="限范围试验或实施边界，可留空"></textarea></label>
   <fieldset><legend>验收条件</legend>
    <div v-for="(item,index) in items" :key="index" class="handoff-item">
     <input v-model="items[index]!" maxlength="2000" :aria-label="`验收项${index+1}`" placeholder="验收项：完成什么、如何检查">
     <button class="icon-btn" type="button" :aria-label="`删除验收项${index+1}`" :disabled="items.length<=1" @click="removeItem(index)">−</button>
    </div>
    <button class="text-btn" type="button" :disabled="items.length>=20" @click="addItem">＋ 添加验收项</button>
   </fieldset>
   <footer><button class="btn" type="button" @click="emit('close')">取消</button><button class="btn btn-solid" type="button" :disabled="!goal.trim()||!items.some(item=>item.trim())" @click="confirm">确认并填入任务</button></footer>
  </section>
 </div>
</template>
<style scoped>
.handoff-scrim{position:fixed;inset:0;background:rgba(0,0,0,.4);display:grid;place-items:center;z-index:60}
.handoff-dialog{width:min(560px,92vw);max-height:86vh;overflow:auto;background:var(--bg-panel);border:1px solid var(--border);border-radius:var(--radius-l,14px);padding:18px;display:grid;gap:12px}
.handoff-dialog header{display:flex;align-items:center;justify-content:space-between}.handoff-dialog h2{margin:0;font-size:var(--text-ui-lg,16px)}
.handoff-note{margin:0;color:var(--fg-subtle);font-size:var(--text-ui-sm)}
.handoff-dialog label{display:grid;gap:4px;font-size:var(--text-ui-sm);color:var(--fg-subtle)}
.handoff-dialog textarea,.handoff-dialog input{box-sizing:border-box;width:100%;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--fg);font:inherit;font-size:var(--text-ui-base);resize:vertical}
.handoff-dialog fieldset{border:1px solid var(--border);border-radius:8px;padding:10px;display:grid;gap:8px;margin:0}
.handoff-dialog legend{font-size:var(--text-ui-sm);color:var(--fg-subtle);padding:0 4px}
.handoff-item{display:flex;gap:6px;align-items:center}
.handoff-item input{flex:1}
.icon-btn{flex:none;width:28px;height:28px;border-radius:6px;border:1px solid var(--border);background:transparent;color:var(--fg);cursor:pointer}
.handoff-dialog footer{display:flex;justify-content:flex-end;gap:8px}
.text-btn{background:transparent;border:0;color:var(--fg-subtle);cursor:pointer;font:inherit;font-size:var(--text-ui-sm);text-align:left}
.text-btn:disabled{opacity:.5}
</style>
