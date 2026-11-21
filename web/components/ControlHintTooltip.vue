<script setup lang="ts">
/** Vue adaptation of ZCode ControlHintTooltip + ui/tooltip: portal, compact label, 2px offset, motion and focus support. */
import {nextTick,onBeforeUnmount,ref,useId,watch} from 'vue';
const props=withDefaults(defineProps<{text:string;side?:'top'|'bottom';focusable?:boolean}>(),{side:'top',focusable:false});
const anchor=ref<HTMLElement>(),tip=ref<HTMLElement>(),shown=ref(false),position=ref({left:'0px',top:'0px'}),resolvedSide=ref(props.side),id=useId();
function hide(){shown.value=false;}
async function show(){
 if(!props.text)return;shown.value=true;await nextTick();if(!shown.value||!anchor.value||!tip.value)return;
 const rect=anchor.value.getBoundingClientRect(),box=tip.value.getBoundingClientRect(),zoom=parseFloat(getComputedStyle(document.body).zoom||'1')||1;
 let top=props.side==='bottom'?rect.bottom+2:rect.top-box.height-2;resolvedSide.value=props.side;
 if(top<8){top=rect.bottom+2;resolvedSide.value='bottom';}else if(top+box.height>innerHeight-8){top=rect.top-box.height-2;resolvedSide.value='top';}
 position.value={left:`${Math.max(8,Math.min(rect.left+rect.width/2-box.width/2,innerWidth-box.width-8))/zoom}px`,top:`${Math.max(8,top)/zoom}px`};
}
watch(()=>props.text,()=>{if(shown.value)void show();});
watch(shown,value=>{const method=value?'addEventListener':'removeEventListener';window[method]('resize',hide);window[method]('scroll',hide,true);});
onBeforeUnmount(()=>{window.removeEventListener('resize',hide);window.removeEventListener('scroll',hide,true);});
</script>
<template><span ref="anchor" class="control-hint-trigger" :tabindex="focusable?0:undefined" :aria-label="focusable?text:undefined" @pointerenter="show" @pointerleave="hide" @focusin="show" @focusout="hide" @pointerdown="hide" @keydown.esc="hide">
 <slot :describedby="shown?id:undefined" />
 <Teleport to="body"><div v-if="shown" :id="id" ref="tip" role="tooltip" class="control-hint" :data-side="resolvedSide" :style="position">{{text}}</div></Teleport>
</span></template>
<style scoped>
.control-hint-trigger{display:inline-flex;flex:none;align-items:center;vertical-align:middle;min-width:0}
.control-hint{position:fixed;z-index:1400;pointer-events:none;width:max-content;max-width:min(448px,calc(100vw - 16px));padding:4px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-panel);color:var(--fg);box-shadow:0 4px 16px rgb(0 0 0 / .14);font:500 12px/18px var(--font-ui);white-space:pre-line;overflow-wrap:anywhere;animation:hint-in .12s ease-out;transform-origin:center bottom}
.control-hint[data-side=bottom]{transform-origin:center top}
@keyframes hint-in{from{opacity:0;transform:translateY(2px) scale(.95)}to{opacity:1;transform:none}}
@media(prefers-reduced-motion:reduce){.control-hint{animation:none}}
</style>
