<script setup lang="ts">
// Adapted from DSH StatsPills/stat-dialog (rc.1 reference + installed rc.2 source). MIT: ../vendor/dsh/LICENSE.
import { ref, useId } from 'vue';
import MetricTooltip from './MetricTooltip.vue';
import { useStatDialog } from './composables/useStatDialog';
defineProps<{ title: string; text: string; stat: string }>();
const trigger = ref<HTMLElement | null>(null), panel = ref<HTMLElement | null>(null);
const { open, position, close } = useStatDialog(trigger, panel); const id = useId();
</script>
<template>
  <span ref="trigger" class="stat-anchor" :data-composer-stat="stat">
    <MetricTooltip :text="text" :disabled="open" v-slot="{ describedby }">
      <button type="button" class="stat-pill" :aria-label="text" aria-haspopup="dialog" :aria-expanded="open" :aria-controls="open ? id : undefined" :aria-describedby="describedby" @click="open = !open">
        <slot name="icon" /><span class="stat-label" data-metric-label><slot name="label">{{ text }}</slot></span>
      </button>
    </MetricTooltip>
    <Teleport to="body">
      <section v-if="open" :id="id" ref="panel" class="stat-panel" :style="position" role="dialog" :aria-label="title" tabindex="-1">
        <header class="stat-title"><span>{{ title }}</span><button class="stat-close" type="button" aria-label="关闭详情" @click="close(true)">×</button></header>
        <slot />
      </section>
    </Teleport>
  </span>
</template>
<style scoped>
.stat-anchor{display:inline-flex;min-width:0;max-width:100%;font:13px/20px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif)}
.stat-pill{display:inline-flex;align-items:center;gap:6px;box-sizing:border-box;max-width:100%;min-width:0;padding:1px 8px;margin:0;border:0;border-radius:var(--dsw-radius-sm,8px);background:transparent;color:var(--dsw-alias-label-tertiary,#737373);font:inherit;line-height:20px;font-variant-numeric:tabular-nums;white-space:nowrap;cursor:pointer;box-shadow:none}
.stat-pill :deep(svg){width:14px;height:14px;flex:none}
.stat-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover,#0000000a);color:var(--dsw-alias-label-secondary,#525252)}
@media(hover:hover){.stat-pill:hover{background:var(--dsw-alias-interactive-bg-hover,#0000000a);color:var(--dsw-alias-label-secondary,#525252)}}
.stat-pill:focus-visible,.stat-close:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4d6bfe);outline-offset:2px}
.stat-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.stat-panel{position:fixed;z-index:1100;box-sizing:border-box;width:max-content;min-width:min(300px,calc(100vw - 24px));max-width:min(440px,calc(100vw - 24px));max-height:calc(100dvh - 24px);overflow:auto;padding:16px;border:0;border-radius:var(--dsw-radius-lg,16px);background:var(--dsw-specific-menu,#fff);backdrop-filter:var(--dsw-menu-backdrop-filter,none);box-shadow:var(--dsw-elevation-prominent,0 0 0 .5px #0002,0 8px 32px #0002);color:var(--dsw-alias-label-secondary,#555);font:13px/20px var(--dsw-font-family,-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif);font-variant-numeric:tabular-nums;outline:none}
.stat-title{display:flex;align-items:center;justify-content:space-between;gap:16px;margin:0 0 10px;padding-bottom:8px;border-bottom:.5px solid var(--dsw-alias-border-l2,#e6e6e6);font-weight:500;color:var(--dsw-alias-label-primary,#262626)}
.stat-close{display:grid;place-items:center;width:24px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:inherit;font:18px/20px inherit;cursor:pointer}
.stat-panel :deep(dl){display:grid;grid-template-columns:minmax(90px,auto) minmax(0,1fr);gap:6px 16px;margin:0}
.stat-panel :deep(dt),.stat-panel :deep(dd){min-width:0;margin:0;overflow-wrap:anywhere}
.stat-panel :deep(dt){color:var(--dsw-alias-label-tertiary,#777)}
.stat-panel :deep(dd){text-align:right}
.stat-panel :deep(p){margin:12px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,#777)}
.stat-panel :deep(.stat-action){border:0;background:var(--dsw-alias-interactive-bg-hover,#0000000a);color:inherit;border-radius:8px;padding:5px 10px;font:inherit;cursor:pointer;margin-top:12px}
.stat-panel :deep(.stat-action:disabled){opacity:.5;cursor:not-allowed}
</style>
