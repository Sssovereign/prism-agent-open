<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import MarkdownText from './MarkdownText.vue';
const props = defineProps<{ artifact: { id: string; display_name: string } }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const content = ref(''), error = ref(''), loading = ref(false);
let controller: AbortController | undefined, generation = 0;
async function load() {
  const ticket = ++generation, c = new AbortController(); controller?.abort(); controller = c;
  loading.value = true; content.value = ''; error.value = '';
  try {
    const response = await fetch(`/api/v1/artifacts/${encodeURIComponent(props.artifact.id)}/download`, { signal: c.signal });
    if (!response.ok) { const body = await response.json().catch(() => null); throw new Error(body?.error?.message ?? '读取文件失败'); }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > 1024 * 1024) throw new Error('文件超过1 MB，请下载查看');
    if (ticket === generation) content.value = new TextDecoder().decode(bytes);
  } catch (e) { if (ticket === generation && !c.signal.aborted) error.value = e instanceof Error ? e.message : '读取文件失败'; }
  finally { if (ticket === generation) loading.value = false; }
}
watch(() => props.artifact.id, load, { immediate: true });
onBeforeUnmount(() => { generation++; controller?.abort(); });
</script>
<template>
  <section class="artifact-preview" :aria-label="`文件预览：${artifact.display_name}`">
    <header class="artifact-preview-head"><button type="button" @click="emit('close')">← 返回输出列表</button><a :href="`/api/v1/artifacts/${artifact.id}/download`">下载</a></header>
    <h2>{{ artifact.display_name }}</h2>
    <p v-if="loading" role="status">正在读取文档…</p>
    <p v-else-if="error" role="alert">{{error}} <button type="button" @click="load">重试</button></p>
    <template v-else><MarkdownText v-if="/\.(md|markdown)$/i.test(artifact.display_name)" :text="content"/><pre v-else>{{content}}</pre></template>
  </section>
</template>
<style scoped>
.artifact-preview{padding:16px 20px 32px;min-width:0;color:var(--fg)}
.artifact-preview-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px;font-size:var(--text-ui-sm)}
.artifact-preview-head button{padding:4px 0;border:0;background:transparent;color:var(--fg-subtle);font:inherit;cursor:pointer}
.artifact-preview-head a{color:var(--fg-subtle);text-decoration:none;padding:4px 8px;border:1px solid var(--border);border-radius:6px}
h2{margin:0 0 20px;font-size:var(--text-ui-base);font-weight:600;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:var(--text-ui-sm)/1.7 var(--font-mono)}
[role=alert]{color:var(--danger)}
</style>
