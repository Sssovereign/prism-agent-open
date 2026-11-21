<script setup lang="ts">
import ControlHintTooltip from '../components/ControlHintTooltip.vue';
withDefaults(defineProps<{copied:boolean;label?:string}>(),{label:'复制正文'});
defineEmits<{(event:'copy'):void}>();
</script>
<template><ControlHintTooltip :text="copied?'已复制':label" side="bottom" v-slot="{describedby}"><button type="button" class="icon-btn copy-action" :aria-label="copied?'已复制':label" :aria-describedby="describedby" @click="$emit('copy')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path v-if="copied" d="m5 12 4 4L19 6"/><template v-else><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></template></svg><span class="copy-announcement" role="status">{{copied?'已复制':''}}</span></button></ControlHintTooltip></template>
<style scoped>
.copy-action{width:28px;height:28px;flex:none;color:var(--fg-subtlest)}.copy-action:hover{color:var(--fg);background:var(--hover)}.copy-action:focus-visible{outline:2px solid var(--primary);outline-offset:2px}.copy-announcement{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
</style>
