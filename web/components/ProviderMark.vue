<script setup lang="ts">
// 供应商品牌标识位（对齐 ZCode ProviderLogo 用法）：pi 目录 provider 身份 → ZCode provider-icons
// 资产（明暗变体按 data-theme 由 CSS 切换，同上游 openrouter/opencode 双素材语义）；无资产走
// slot 兜底（调用方放 package 图标，同上游 ProviderLogo 兜底）。
import { computed } from 'vue';
import { resolveProviderAssetFor } from '../providerBrands';

const props = defineProps<{ providerId: string | null | undefined; baseUrl?: string | null }>();
const asset = computed(() => resolveProviderAssetFor(props.providerId, props.baseUrl));
</script>

<template>
  <template v-if="asset">
    <img class="provider-mark-img provider-mark-light" :src="asset.light" alt="" aria-hidden="true" />
    <img v-if="asset.dark" class="provider-mark-img provider-mark-dark" :src="asset.dark" alt="" aria-hidden="true" />
  </template>
  <slot v-else />
</template>

<style scoped>
.provider-mark-img { display: block; flex: none; width: 16px; height: 16px; border-radius: 2px; object-fit: contain; }
.provider-mark-dark { display: none; }
:global([data-theme="dark"]) .provider-mark-light { display: none; }
:global([data-theme="dark"]) .provider-mark-dark { display: block; }
</style>
