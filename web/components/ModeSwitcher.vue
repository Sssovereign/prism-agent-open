<script setup lang="ts">
import {computed} from 'vue';
import {WORK_MODES,modeInfo,type WorkMode} from '../modes';
import {t} from '../ui/i18n/index';
import ComposerSelect from './ComposerSelect.vue';
import ModeIcon from './ModeIcon.vue';
const props=defineProps<{mode:WorkMode}>();
const emit=defineEmits<{(e:'change',mode:WorkMode):void}>();
const options=computed(()=>WORK_MODES.map(item=>{const info=modeInfo(item.id);return {value:item.id,label:info.label,description:info.description};}));
function select(value:string){const mode=WORK_MODES.find(mode=>mode.id===value);if(mode)emit('change',mode.id);}
</script>
<template><ComposerSelect class="work-mode-picker" :value="mode" :options="options" :label="t('mode.pickerLabel')" :width="304" @change="select"><template #leading><ModeIcon :mode="mode"/></template><template #option-leading="{option}"><ModeIcon :mode="option.value as WorkMode"/></template></ComposerSelect></template>
<style scoped>.work-mode-picker{flex:none;max-width:240px}.work-mode-picker :deep(.composer-select-trigger){height:32px;gap:8px;font-weight:500}.work-mode-picker :deep(.mode-icon){flex:none}</style>
