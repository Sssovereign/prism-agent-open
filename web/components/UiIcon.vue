<script lang="ts">
export type UiIconName = 'model' | 'package' | 'folder' | 'folder-plus' | 'plus' | 'arrow-up' | 'arrow-left' | 'arrow-right' | 'chevron-down' | 'chevron-up' | 'chevron-left' | 'chevron-right' | 'search' | 'check' | 'x' | 'stop' | 'hand' | 'shield-check' | 'shield-alert' | 'settings' | 'image' | 'copy' | 'pencil' | 'fork' | 'list-end' | 'refresh' | 'undo' | 'download' | 'paperclip' | 'target' | 'info' | 'messages';
</script>

<script setup lang="ts">
// Lucide-compatible 24px geometry; all consumers share the same stroke and optical box.
withDefaults(defineProps<{ name: UiIconName; size?: number; strokeWidth?: number; label?: string }>(), {
  size: 16,
  strokeWidth: 2,
});
</script>

<template>
  <svg class="ui-icon" :width="size" :height="size" :style="{ width: `${size}px`, height: `${size}px` }" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : true" focusable="false">
    <title v-if="label">{{ label }}</title>
    <template v-if="name === 'model'">
      <path d="m7.5 4.27 9 5.15M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5M12 22V12" />
    </template>
    <!-- lucide package：ZCode ProviderLogo 的无 logo 兜底（供应商行/新供应商） -->
    <template v-else-if="name === 'package'">
      <path d="M16.5 9.4 7.55 4.24" />
      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="M3.29 7 12 12l8.71-5" />
      <path d="M12 22V12" />
    </template>
    <template v-else-if="name === 'folder' || name === 'folder-plus'">
      <path d="M20 20H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2A2 2 0 0 0 12.06 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2Z" />
      <path v-if="name === 'folder-plus'" d="M12 10v6m-3-3h6" />
    </template>
    <path v-else-if="name === 'paperclip'" d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5L13.6 2.4a4 4 0 0 1 5.7 5.7l-9.9 9.9a2 2 0 0 1-2.8-2.8l9.2-9.2" />
    <template v-else-if="name === 'target'"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></template>
    <template v-else-if="name === 'info'"><circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10h.01"/></template>
    <path v-else-if="name === 'plus'" d="M12 5v14M5 12h14" />
    <path v-else-if="name === 'arrow-up'" d="m5 12 7-7 7 7M12 19V5" />
    <path v-else-if="name === 'arrow-left'" d="m12 19-7-7 7-7M19 12H5" />
    <path v-else-if="name === 'arrow-right'" d="m12 5 7 7-7 7M5 12h14" />
    <path v-else-if="name === 'chevron-down'" d="m6 9 6 6 6-6" />
    <path v-else-if="name === 'chevron-up'" d="m18 15-6-6-6 6" />
    <path v-else-if="name === 'chevron-left'" d="m15 18-6-6 6-6" />
    <path v-else-if="name === 'chevron-right'" d="m9 18 6-6-6-6" />
    <template v-else-if="name === 'search'"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></template>
    <path v-else-if="name === 'undo'" d="M3 10h11a6 6 0 0 1 0 12M3 10l6-6M3 10l6 6" />
    <path v-else-if="name === 'download'" d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" />
    <path v-else-if="name === 'refresh'" d="M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7" />
    <path v-else-if="name === 'list-end'" d="M4 5h16M4 10h16M4 15h4m4 0h8m-4-4 4 4-4 4" />
    <path v-else-if="name === 'check'" d="m20 6-11 11-5-5" />
    <path v-else-if="name === 'x'" d="m18 6-12 12M6 6l12 12" />
    <rect v-else-if="name === 'stop'" x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    <path v-else-if="name === 'hand'" d="M18 11V7a2 2 0 0 0-4 0M14 10V5a2 2 0 0 0-4 0v5m0-2a2 2 0 0 0-4 0v6m12-5a2 2 0 0 1 4 0v5a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-3l-3.6-4.8a2 2 0 0 1 3.2-2.4L7 14" />
    <template v-else-if="name === 'shield-check' || name === 'shield-alert'">
      <path d="M20 13c0 5-8 9-8 9s-8-4-8-9V5l8-3 8 3Z" />
      <path v-if="name === 'shield-check'" d="m9 12 2 2 4-4" />
      <path v-else d="M12 8v4m0 4h.01" />
    </template>
    <template v-else-if="name === 'settings'">
      <path d="M12 8v13M12 3v1M5 3v10M5 17v4M19 3v2M19 9v12M2 13h6m1-9h6m1 5h6" />
    </template>
    <template v-else-if="name === 'image'">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="m21 15-5-5L5 21" />
    </template>
    <template v-else-if="name === 'copy'">
      <rect x="8" y="8" width="14" height="14" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </template>
    <path v-else-if="name === 'pencil'" d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    <template v-else-if="name === 'fork'">
      <circle cx="6" cy="5" r="3"/><path d="M6 8v8a3 3 0 0 0 3 3h3M6 12h7a5 5 0 0 0 5-5"/><circle cx="18" cy="4" r="3"/><circle cx="15" cy="19" r="3"/>
    </template>
    <!-- lucide messages-square：会话引用候选（上游 ContextMentionOptionContent 用 MessagesSquare） -->
    <template v-else-if="name === 'messages'">
      <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
    </template>
  </svg>
</template>

<style scoped>
.ui-icon { display: block; flex: none; vertical-align: middle; pointer-events: none; }
</style>
