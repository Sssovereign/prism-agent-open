<script setup lang="ts">
import {computed,ref,nextTick,onMounted,onBeforeUnmount,watch,type ComponentPublicInstance} from 'vue';
import type {ConversationTurn} from '../../contracts/conversation';
import {virtualTurnWindow,anchorFor,anchorTop,measuredHeight,cacheHeight,type TurnAnchor} from './virtualHistory';
const props=defineProps<{turns:ConversationTurn[];scopeKey:string;following?:boolean}>();
const root=ref<HTMLElement>(),width=ref(0),scrollTop=ref(0),viewport=ref(800),revision=ref(0);
const metrics=computed(()=>{void revision.value;return props.turns.map(t=>({id:t.id,height:measuredHeight(props.scopeKey,t.id,width.value)}));});
const mounted=computed(()=>virtualTurnWindow(metrics.value,scrollTop.value,viewport.value,props.turns.at(-1)?.id));
let region:HTMLElement|null=null,observer:ResizeObserver|undefined,widthObserver:ResizeObserver|undefined,raf=0,restoring:TurnAnchor|undefined;
const elements=new Map<string,HTMLElement>();
function relativeTop(){if(!root.value||!region)return 0;return region.scrollTop+root.value.getBoundingClientRect().top-region.getBoundingClientRect().top;}
function sync(){if(region){scrollTop.value=Math.max(0,region.scrollTop-relativeTop());viewport.value=region.clientHeight;}}
function schedule(){cancelAnimationFrame(raf);raf=requestAnimationFrame(sync);}
function setElement(id:string,el:Element|ComponentPublicInstance|null){const old=elements.get(id);if(old&&old!==el){observer?.unobserve(old);elements.delete(id);}if(el instanceof HTMLElement){elements.set(id,el);observer?.observe(el);}}
function capture(following:boolean){sync();return anchorFor(metrics.value,scrollTop.value,following);}
async function restore(anchor:TurnAnchor){restoring=anchor;const top=anchorTop(metrics.value,anchor);if(top===undefined||!region)return false;region.scrollTop=relativeTop()+top;sync();await nextTick();return true;}
function releaseRestore(){restoring=undefined;}
defineExpose({capture,restore,releaseRestore});
onMounted(()=>{
 region=root.value?.closest('.timeline-scroll') as HTMLElement|null;if(!region)return;width.value=root.value?.clientWidth??0;
 observer=new ResizeObserver(entries=>{
  const saved=props.following?undefined:restoring??capture(false);let changed=false;
  for(const entry of entries){const el=entry.target as HTMLElement,id=el.dataset.virtualTurn;if(!id)continue;const height=el.getBoundingClientRect().height;if(Math.abs(measuredHeight(props.scopeKey,id,width.value)-height)>1){cacheHeight(props.scopeKey,id,width.value,height);changed=true;}}
  if(changed){revision.value++;void nextTick(()=>{if(saved&&region){const top=anchorTop(metrics.value,saved);if(top!==undefined)region.scrollTop=relativeTop()+top;}sync();});}
 });
 for(const el of elements.values())observer.observe(el);
 widthObserver=new ResizeObserver(()=>{const next=root.value?.clientWidth??0;if(Math.abs(next-width.value)>1){const saved=capture(false);width.value=next;void nextTick(()=>{if(saved&&region){const top=anchorTop(metrics.value,saved);if(top!==undefined)region.scrollTop=relativeTop()+top;}sync();});}});if(root.value)widthObserver.observe(root.value);
 region.addEventListener('scroll',schedule,{passive:true});sync();
});
watch(()=>props.turns.map(t=>t.id).join('|'),()=>void nextTick(sync));
onBeforeUnmount(()=>{cancelAnimationFrame(raf);observer?.disconnect();widthObserver?.disconnect();region?.removeEventListener('scroll',schedule);});
</script>
<template><div ref="root" class="virtual-history"><template v-for="turn in turns" :key="turn.id"><div v-if="mounted.has(turn.id)" :ref="el=>setElement(turn.id,el)" :data-virtual-turn="turn.id" class="mounted-turn"><slot :turn="turn"/></div><div v-else class="turn-placeholder" :data-placeholder-turn="turn.id" :style="{height:`${metrics.find(m=>m.id===turn.id)?.height??360}px`}" aria-hidden="true"/></template></div></template>
<style scoped>
.virtual-history,.mounted-turn{display:flow-root;min-width:0;overflow-anchor:none}.turn-placeholder{width:100%;pointer-events:none;overflow-anchor:none}
</style>
