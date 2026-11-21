<script setup lang="ts">
// Vue adaptation of upstream ProviderDetailFeedback: viewport-local pending/result feedback.
import { watch, onBeforeUnmount } from 'vue';
import ModelProviderIcon from './ModelProviderIcon.vue';
const props=defineProps<{feedback?:{id:number;state:'pending'|'success'|'failure';message:string;detail?:string;emphasis?:boolean};canRetry?:boolean}>();
const emit=defineEmits<{(e:'dismiss'):void;(e:'retry'):void}>();
let timer:ReturnType<typeof setTimeout>|undefined;
watch(()=>props.feedback,item=>{
 clearTimeout(timer);
 if(item&&item.state!=='pending')timer=setTimeout(()=>emit('dismiss'),item.state==='failure'?8000:3500);
},{immediate:true});
onBeforeUnmount(()=>clearTimeout(timer));
</script>
<template>
 <div class="provider-feedback-overlay"><div class="provider-feedback-viewport" aria-live="polite" aria-atomic="true">
  <Transition name="provider-feedback">
   <div v-if="feedback" :key="feedback.id" class="provider-feedback" :class="{'is-emphasized':feedback.emphasis}" :data-state="feedback.state" :role="feedback.state==='failure'?'alert':'status'">
    <ModelProviderIcon :name="feedback.state==='pending'?'loader':feedback.state==='success'?'check':'alert'" class="feedback-icon" :class="{'is-spinning':feedback.state==='pending'}"/>
    <div class="feedback-copy"><strong>{{feedback.message}}</strong><span v-if="feedback.detail">{{feedback.detail}}</span></div>
    <button v-if="feedback.state==='failure'&&canRetry" type="button" class="feedback-action" @click="emit('retry')">重试</button>
    <button v-if="feedback.state!=='pending'" type="button" class="feedback-close" aria-label="关闭操作提示" @click="emit('dismiss')"><ModelProviderIcon name="close"/></button>
   </div>
  </Transition>
 </div></div>
</template>
<style scoped>
.provider-feedback-overlay{position:absolute;inset:16px;display:flex;flex-direction:column;justify-content:flex-end;pointer-events:none}
.provider-feedback-viewport{position:sticky;bottom:16px;z-index:20;min-width:0}
.provider-feedback{display:flex;align-items:center;gap:12px;min-height:44px;padding:10px 12px;border:1px solid var(--border);border-radius:12px;background:color-mix(in srgb,var(--bg-card) 95%,transparent);color:var(--fg);box-shadow:0 4px 14px #0002;backdrop-filter:blur(8px);pointer-events:auto;font-size:var(--text-ui-sm,12px);line-height:1.5}
.provider-feedback[data-state=failure]{border-color:color-mix(in srgb,var(--danger) 30%,transparent);background:color-mix(in srgb,var(--danger) 10%,var(--bg-card));color:var(--color-destructive-surface-foreground,var(--danger))}
.provider-feedback.is-emphasized{border-color:color-mix(in srgb,var(--success) 30%,transparent);background:color-mix(in srgb,var(--success) 10%,var(--bg-card));color:var(--success)}
.feedback-icon{width:16px;height:16px;flex:none}.provider-feedback[data-state=success]>.feedback-icon{color:var(--success)}
.feedback-copy{flex:1;min-width:0;overflow-wrap:anywhere}.feedback-copy strong{display:block;font-weight:500}.feedback-copy span{display:block;color:var(--fg-subtle);font-size:11px;margin-top:2px}
.feedback-action,.feedback-close{display:inline-flex;align-items:center;justify-content:center;flex:none;border:0;background:transparent;color:inherit;border-radius:6px;cursor:pointer;font:inherit;min-height:24px}.feedback-action{padding:0 6px}.feedback-close{width:24px;padding:0}.feedback-action:hover,.feedback-close:hover{background:var(--hover)}button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.is-spinning{animation:provider-feedback-spin .85s linear infinite}@keyframes provider-feedback-spin{to{transform:rotate(360deg)}}
.provider-feedback-enter-active{transition:opacity .18s ease-out,transform .18s ease-out}.provider-feedback-leave-active{position:absolute;inset-inline:0;bottom:0;transition:opacity .12s ease-in,transform .12s ease-in;pointer-events:none}.provider-feedback-enter-from,.provider-feedback-leave-to{opacity:0;transform:translateY(6px) scale(.98)}
@media(max-width:767px){.provider-feedback-overlay{inset:12px}.provider-feedback-viewport{bottom:12px}}
@media(prefers-reduced-motion:reduce){.is-spinning{animation:none}.provider-feedback-enter-active,.provider-feedback-leave-active{transition:none}.provider-feedback-enter-from,.provider-feedback-leave-to{transform:none}}
</style>
