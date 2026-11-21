<script setup lang="ts">
import { computed, ref } from 'vue';
import type { UserQuestionRequest } from '../../contracts/userQuestions';
const props=defineProps<{request?:UserQuestionRequest;running:boolean;failed:boolean}>();
const open=ref(false);
const label=computed(()=>props.request?props.request.state==='pending'?'正在询问':'已询问':props.running?'正在询问':'已询问');
const empty=computed(()=>props.request?.state==='auto_continued'?'未回答，已自动继续':props.request?.state==='cancelled'?'问题已取消':'未回答');
</script>
<template>
 <div class="question-history"><button type="button" :aria-expanded="open" @click="open=!open"><span aria-hidden="true">⊙</span><strong>{{label}}</strong><small>{{request?.state==='pending'?'等待你的回答':request?.state==='auto_continued'?'未回答，已自动继续':request?`${request.questions.length} 个问题`:failed?'提问失败':''}}</small><span aria-hidden="true">{{open?'⌄':'›'}}</span></button><dl v-if="open&&request"><template v-for="q in request.questions" :key="q.question"><dt>{{q.question}}</dt><dd>{{request.state==='pending'?'等待回答':request.answers[q.question]?.join('，')||empty}}</dd></template></dl></div>
</template>
<style scoped>
.question-history{margin:2px 0;min-width:0}button{display:flex;gap:8px;align-items:center;border:0;background:transparent;color:var(--fg-subtle);padding:2px 0;text-align:left;cursor:pointer;font-size:var(--text-ui-caption);max-width:100%}button strong{font-weight:500;flex:none}button small{color:var(--fg-subtlest);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}button:focus-visible{outline:2px solid var(--fg-subtle);outline-offset:2px}dl{border-left:1px solid var(--border);margin:6px 0 12px 6px;padding-left:14px;font-size:var(--text-ui-base);overflow-wrap:anywhere}dt{font-weight:500;color:var(--fg)}dd{margin:4px 0 10px;color:var(--fg-subtle)}
</style>
