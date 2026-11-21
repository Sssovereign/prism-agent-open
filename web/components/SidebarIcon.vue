<script setup lang="ts">
// Sidebar-only Lucide geometry: 24px viewBox, 2px strokes, round caps/joins.
// Mirrors the icons used by ZCode ProjectNodeContent / ProjectSidebarListHeader.
withDefaults(defineProps<{name:string;size?:number}>(),{size:16});
const paths:Record<string,string[]>={
 folder:['M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z'],
 'folder-open':['m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6A2 2 0 0 1 18.46 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v2'],
 plus:['M12 5v14','M5 12h14'],search:['m21 21-4.34-4.34'],
 filter:['M3 6h18','M7 12h10','M10 18h4'],
 hash:['M4 9h16','M3 15h16','M10 3 8 21','M16 3l-2 18'],
 clock:['M12 6v6l4 2'],bell:['M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9','M10 21h4'],
 check:['m9 12 2 2 4-4'],pin:['M16 9V4l1-1H7l1 1v5l-2 3v3h12v-3l-2-3','M12 15v7'],
 'list-tree':['M21 12h-8','M21 6H8','M21 18h-8','M3 6v12h4'],
 'message-plus':['M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9H13','M16 5h6','M19 2v6'],
 settings:['M12.22 2h-.44a2 2 0 0 0-2 1.72l-.12.87a2 2 0 0 1-1.18 1.52l-.2.09a2 2 0 0 1-1.9-.18l-.7-.54a2 2 0 0 0-2.62.44l-.22.38a2 2 0 0 0 .62 2.58l.7.53a2 2 0 0 1 .72 1.8v.22a2 2 0 0 1-.72 1.8l-.7.53a2 2 0 0 0-.62 2.58l.22.38a2 2 0 0 0 2.62.44l.7-.54a2 2 0 0 1 1.9-.18l.2.09a2 2 0 0 1 1.18 1.52l.12.87a2 2 0 0 0 2 1.72h.44a2 2 0 0 0 2-1.72l.12-.87a2 2 0 0 1 1.18-1.52l.2-.09a2 2 0 0 1 1.9.18l.7.54a2 2 0 0 0 2.62-.44l.22-.38a2 2 0 0 0-.62-2.58l-.7-.53a2 2 0 0 1-.72-1.8v-.22a2 2 0 0 1 .72-1.8l.7-.53a2 2 0 0 0 .62-2.58l-.22-.38a2 2 0 0 0-2.62-.44l-.7.54a2 2 0 0 1-1.9.18l-.2-.09a2 2 0 0 1-1.18-1.52l-.12-.87a2 2 0 0 0-2-1.72Z'],
 logout:['M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4','m16 17 5-5-5-5','M21 12H9'],
 pencil:['m16 3 5 5','M4 16 16.5 3.5a3.54 3.54 0 0 1 5 5L9 21H3l1-5'],
 archive:['M3 3h18v4H3z','M5 7v14h14V7','M10 12h4'],
 loader:['M12 2v4','m16.2 7.8 2.9-2.9','M18 12h4','m16.2 16.2 2.9 2.9','M12 18v4','m4.9 19.1 2.9-2.9','M2 12h4','m4.9 4.9 2.9 2.9'],
 x:['M18 6 6 18','m6 6 12 12']
};
</script>
<template>
 <svg class="sidebar-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
  <path v-for="(d,i) in paths[name]||[]" :key="i" :d="d"/>
  <template v-if="name==='ellipsis'"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></template>
  <circle v-if="name==='search'" cx="11" cy="11" r="8"/>
  <circle v-if="name==='clock'" cx="12" cy="12" r="10"/>
  <circle v-if="name==='settings'" cx="12" cy="11.5" r="3"/>
 </svg>
</template>
<style scoped>
.sidebar-icon{display:block;flex:none;pointer-events:none;}
</style>
