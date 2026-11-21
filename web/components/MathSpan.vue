<script setup lang="ts">
/** KaTeX 公式桥（块E1）：katex 动态分包加载；throwOnError:false 保证流式未完成/非法
 *  TeX 回退为可读文本而非错误面板（对齐上游数学插件容错语义）。 */
import { ref, watch, onMounted } from 'vue';
const props = defineProps<{ tex: string; display: boolean }>();
const host = ref<HTMLElement | null>(null);
const failed = ref(false);
let renderSeq = 0;
async function render(): Promise<void> {
  const ticket = ++renderSeq;
  const target = host.value;
  if (!target) return;
  try {
    const { default: katex } = await import('katex');
    if (ticket !== renderSeq) return;
    target.innerHTML = katex.renderToString(props.tex, { displayMode: props.display, throwOnError: false, output: 'html', strict: false });
    failed.value = false;
  } catch {
    if (ticket === renderSeq) { failed.value = true; target.textContent = props.tex; }
  }
}
onMounted(render);
watch(() => [props.tex, props.display], render);
</script>
<template>
  <span v-if="!display" ref="host" class="math-span math-inline" data-math-kind="inline"></span>
  <span v-else ref="host" class="math-span math-display" data-math-kind="display"></span>
</template>
<style scoped>
.math-span{overflow-wrap:anywhere}
.math-display{display:block;margin:12px 0;text-align:center}
.math-span :deep(.katex-display){margin:0}
</style>
