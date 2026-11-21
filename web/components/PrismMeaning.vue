<script setup lang="ts">
import { PRISM_MEANING } from '../brand';
</script>

<template>
  <dl class="prism-meaning" aria-label="PRISM 品牌释义">
    <div v-for="item in PRISM_MEANING" :key="item.letter" class="prism-meaning-item">
      <dt :aria-label="item.word"><span class="prism-initial" aria-hidden="true">{{ item.letter }}</span><span aria-hidden="true">{{ item.word.slice(1) }}</span></dt>
      <dd>{{ item.meaning }}</dd>
    </div>
  </dl>
</template>

<style scoped>
.prism-meaning{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:24px;margin:0;text-align:left}
.prism-meaning-item{min-width:0}
.prism-meaning dt{display:flex;align-items:baseline;color:var(--fg-subtle);font-size:13px;white-space:nowrap;letter-spacing:-.2px}
.prism-initial{font-size:26px;font-weight:550;line-height:1.4;color:var(--fg);letter-spacing:-.7px}
.prism-meaning dd{margin:4px 0 0;color:var(--fg-subtlest);font-size:12px}
@media(max-width:700px){.prism-meaning{grid-template-columns:1fr;gap:7px}.prism-meaning-item{display:flex;align-items:baseline;justify-content:space-between;gap:20px}.prism-initial{font-size:18px}.prism-meaning dd{margin:0}}
</style>
