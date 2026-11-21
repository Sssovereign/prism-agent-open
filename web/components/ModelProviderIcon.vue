<script setup lang="ts">
// Lucide geometry used by upstream model-provider-section (Apache-2.0).
defineProps<{ name: 'plus' | 'refresh' | 'back' | 'server' | 'eye' | 'eye-off' | 'test' | 'trash' | 'chevron' | 'save' | 'loader' | 'check' | 'alert' | 'close' | 'pencil' | 'info' }>();
</script>
<template>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <path v-if="name==='loader'" d="M21 12a9 9 0 1 1-6.219-8.56"/>
    <template v-else-if="name==='check'"><circle cx="12" cy="12" r="10"/><path d="m8 12 3 3 5-6"/></template>
    <template v-else-if="name==='alert'"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></template>
    <path v-else-if="name==='close'" d="m6 6 12 12M6 18 18 6"/>
    <path v-else-if="name==='plus'" d="M12 5v14M5 12h14"/>
    <template v-else-if="name==='refresh'"><path d="M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M8 16H3v5"/></template>
    <path v-else-if="name==='back'" d="m12 19-7-7 7-7M5 12h14"/>
    <template v-else-if="name==='server'"><rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><path d="M6 7h.01M6 17h.01"/></template>
    <template v-else-if="name==='eye'||name==='eye-off'"><path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/><path v-if="name==='eye-off'" d="m3 3 18 18"/></template>
    <template v-else-if="name==='test'"><path d="m19 5 3-3M2 22l3-3m1-9 8 8m-9-7 3-3m8 8-3 3M9 3l3 3m6 6 3 3M5 13a5 5 0 0 0 6 6l3-3-6-6Z"/></template>
    <template v-else-if="name==='trash'"><path d="M3 6h18M19 6v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M10 10v7M14 10v7"/></template>
    <path v-else-if="name==='chevron'" d="m9 18 6-6-6-6"/>
    <template v-else-if="name==='save'"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM17 21v-8H7v8M7 3v5h8"/></template>
    <template v-else-if="name==='pencil'"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></template>
    <template v-else-if="name==='info'"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></template>
  </svg>
</template>
<style scoped>
svg { width:14px;height:14px;flex:none;pointer-events:none; }
</style>
