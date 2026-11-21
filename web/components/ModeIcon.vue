<script setup lang="ts">
import type { WorkMode } from '../modes';
defineProps<{ mode: WorkMode }>();
</script>

<template>
  <svg class="mode-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <template v-if="mode === 'ordinary'">
      <circle cx="12" cy="12" r="8.5" />
      <path d="m15.8 8.2-2.4 5.2-5.2 2.4 2.4-5.2 5.2-2.4Z" />
    </template>
    <template v-else-if="mode === 'debate'">
      <path d="M14 4H5a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h1v3l3-3h5a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Z" />
      <path d="M19 8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-1v3l-3-3h-4a2 2 0 0 1-2-2" />
    </template>
    <template v-else>
      <path d="M12 3v18M8 21h8M4 7h16M6 7l-3 7m3-7 3 7m9-7-3 7m3-7 3 7M3 14c0 3 6 3 6 0m6 0c0 3 6 3 6 0" />
    </template>
  </svg>
</template>
