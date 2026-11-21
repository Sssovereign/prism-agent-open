<script setup lang="ts">
// 上游 RollingToolbarLabel 移植：标签变化时旧行向上滚出（-0.75em）、新行自下滚入（+0.75em），
// 200ms cubic-bezier(.4,0,.2,1)，popLayout 语义=进出同时进行（离场行绝对定位）；
// prefers-reduced-motion 下退化为直接切换。
defineProps<{ label: string }>();
</script>

<template>
  <span class="roll-label" :title="label">
    <Transition name="roll">
      <span :key="label" class="roll-line">{{ label }}</span>
    </Transition>
  </span>
</template>

<style scoped>
.roll-label { position: relative; display: inline-flex; align-items: center; overflow: hidden; height: 1.3em; min-width: 0; max-width: 100%; }
.roll-line { display: inline-flex; min-width: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; line-height: 1.25; }
.roll-enter-active, .roll-leave-active { transition: transform .2s cubic-bezier(.4, 0, .2, 1), opacity .2s cubic-bezier(.4, 0, .2, 1); }
.roll-enter-from { transform: translateY(0.75em); opacity: 0; }
.roll-leave-to { transform: translateY(-0.75em); opacity: 0; }
.roll-leave-active { position: absolute; }
@media (prefers-reduced-motion: reduce) { .roll-enter-active, .roll-leave-active { transition: none; } }
</style>
