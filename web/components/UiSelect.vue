<script lang="ts">
export interface SelectOption<T extends string|number=string>{value:T;label:string;description?:string;group?:string;disabled?:boolean}
</script>
<script setup lang="ts" generic="T extends string|number">
import {computed} from 'vue';
import ComposerSelect from './ComposerSelect.vue';
const props=withDefaults(defineProps<{modelValue:T|null|undefined;options:readonly SelectOption<T>[];label:string;disabled?:boolean;searchable?:boolean;placeholder?:string;width?:number}>(),{searchable:undefined});
const emit=defineEmits<{(e:'update:modelValue',value:T):void;(e:'change',value:T):void}>();
const choices=computed(()=>props.options.map(option=>({...option,value:String(option.value)})));
function change(value:string){const option=props.options.find(option=>String(option.value)===value&&!option.disabled);if(!option)return;emit('update:modelValue',option.value);emit('change',option.value);}
</script>
<template><ComposerSelect class="ui-select" variant="field" :value="String(modelValue??'')" :options="choices" :label="label" :disabled="disabled" :searchable="searchable??options.length>10" :placeholder="placeholder" :width="width??280" @change="change"/></template>
