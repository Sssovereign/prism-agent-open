<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { fileIconName, languageIconName, fileIconUrl } from '../fileIcons';
const props=withDefaults(defineProps<{folder?:boolean;name?:string;language?:string;size?:number}>(),{size:16});
const failed=ref(false);
const icon=computed(()=>props.folder?'folder':props.language!==undefined?languageIconName(props.language):fileIconName(props.name??''));
watch(icon,()=>failed.value=false);
</script>
<template>
 <svg v-if="failed" class="file-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M14 3H6v18h14V9Zm0 0v6h6"/></svg>
 <span v-else class="file-icon" :data-file-icon="icon" :style="{width:`${size}px`,height:`${size}px`}" aria-hidden="true"><img class="file-icon-dark" :src="fileIconUrl(icon)" alt="" :width="size" :height="size" @error="failed=true" draggable="false"><img class="file-icon-light" :src="fileIconUrl(icon,true)" alt="" :width="size" :height="size" @error="failed=true" draggable="false"></span>
</template>
<style scoped>.file-icon{display:inline-flex;vertical-align:middle;flex:none;object-fit:contain}.file-icon img{width:100%;height:100%;object-fit:contain}.file-icon-dark{display:none}.file-icon-light{display:block}[data-theme="dark"] .file-icon-dark{display:block}[data-theme="dark"] .file-icon-light{display:none}</style>
