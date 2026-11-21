<script setup lang="ts">
import {ref,onMounted,onUnmounted,nextTick,useId} from 'vue';
const props=withDefaults(defineProps<{title:string;description?:string;confirmLabel:string;danger?:boolean;busy?:boolean;focusInput?:boolean;confirmDisabled?:boolean}>(),{danger:false,busy:false,focusInput:false,confirmDisabled:false});
const emit=defineEmits<{(e:'close'):void;(e:'confirm'):void}>();
const dialog=ref<HTMLElement>(),titleId=useId(),previous=document.activeElement as HTMLElement|null;
function key(event:KeyboardEvent){
 if(event.key==='Escape'){event.preventDefault();event.stopPropagation();if(!props.busy)emit('close');return;}
 if(event.key!=='Tab')return;const nodes=[...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled)')||[])];
 if(event.shiftKey&&document.activeElement===nodes[0]){event.preventDefault();nodes.at(-1)?.focus();}
 else if(!event.shiftKey&&document.activeElement===nodes.at(-1)){event.preventDefault();nodes[0]?.focus();}
}
onMounted(async()=>{await nextTick();dialog.value?.querySelector<HTMLElement>(props.focusInput?'input':'[data-cancel]')?.focus();});
onUnmounted(()=>{if(previous?.isConnected)void nextTick(()=>previous.focus());});
</script>
<template><Teleport to="body"><div class="settings-confirm-backdrop" @click.self="!busy&&emit('close')"><section ref="dialog" class="settings-confirm" :role="danger?'alertdialog':'dialog'" aria-modal="true" :aria-labelledby="titleId" @keydown="key"><h2 :id="titleId">{{title}}</h2><p v-if="description">{{description}}</p><slot/><div><button class="btn" type="button" data-cancel :disabled="busy" @click="emit('close')">取消</button><button class="btn" type="button" :class="{'danger-solid':danger}" :disabled="busy||confirmDisabled" @click="emit('confirm')">{{confirmLabel}}</button></div></section></div></Teleport></template>
