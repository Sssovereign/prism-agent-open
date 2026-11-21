<script setup lang="ts">
import {ref,onBeforeUnmount} from 'vue';
import {SHORTCUT_COMMANDS,loadShortcutState,saveShortcuts,shortcutFromEvent,shortcutProblem,defaultBindings,formatShortcut,ignoredKeyEvent,type ShortcutId} from '../keyboardShortcuts';
const props=defineProps<{username:string}>(),emit=defineEmits<{(e:'changed'):void}>();
const initial=loadShortcutState(props.username),bindings=ref(initial.bindings),notices=ref(initial.notices),recording=ref<ShortcutId>(),error=ref('');
function save(){try{saveShortcuts(props.username,bindings.value);notices.value=[];error.value='';emit('changed');}catch(e){error.value=String(e);bindings.value=loadShortcutState(props.username).bindings;}}
function record(e:KeyboardEvent){
 if(!recording.value||ignoredKeyEvent(e))return;
 if(e.key==='Escape'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!e.shiftKey){e.preventDefault();e.stopImmediatePropagation();recording.value=undefined;return;}
 const combo=shortcutFromEvent(e);if(!combo)return;
 const issue=shortcutProblem(bindings.value,recording.value,combo);
 // Keep native editing/browser combinations native even during recording.
 e.stopImmediatePropagation();if(issue){error.value=issue;return;}
 e.preventDefault();bindings.value[recording.value]=combo;recording.value=undefined;save();
}
window.addEventListener('keydown',record,true);onBeforeUnmount(()=>window.removeEventListener('keydown',record,true));
</script>
<template><section aria-label="快捷键设置" :data-shortcut-recording="recording||undefined"><p class="settings-description">点击录制后按下组合键，Esc 取消。Mod 在 macOS 为 ⌘，Windows/Linux 为 Ctrl；发送快捷键在“常规”中设置。搜索及其备用键独立配置，清除后即停用。原生编辑与系统组合键不能分配。</p><p v-for="notice in notices" :key="notice" role="status">{{notice}}</p><p v-if="error" role="alert">{{error}}</p><div class="settings-group"><div v-for="c in SHORTCUT_COMMANDS" :key="c.id" class="setting-row"><strong>{{c.label}}</strong><div class="binding"><kbd>{{recording===c.id?'请按组合键…':formatShortcut(bindings[c.id])||'未分配'}}</kbd><button class="text-btn" :aria-label="`录制${c.label}快捷键`" @click="recording=c.id;error=''">录制</button><button class="text-btn" :aria-label="`清除${c.label}快捷键`" @click="recording=undefined;bindings[c.id]='';save()">清除</button></div></div></div><button class="btn" @click="recording=undefined;bindings=defaultBindings();save()">恢复默认快捷键</button></section></template>
<style scoped>.binding{display:flex;gap:12px;align-items:center;flex-wrap:wrap}kbd{background:var(--hover);border:1px solid var(--border);border-radius:6px;padding:4px 8px;font:12px var(--font-mono)}[role=alert]{color:var(--danger)}</style>
