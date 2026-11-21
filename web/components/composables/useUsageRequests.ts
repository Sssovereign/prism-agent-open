import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue';
import type { UsageRequest, UsageRequestPage } from '../../../contracts/usage';
import { v1 } from '../../api';
import type { UsageView } from '../../view-model/usage';

/** Load older ledger pages only on demand; page state never feeds the aggregate. */
export function useUsageRequests(runId: Ref<string>, usage: Ref<UsageView>) {
  const older = ref<UsageRequest[]>([]), page = ref<UsageRequestPage | null>(null), busy = ref(false), error = ref('');
  let controller: AbortController | undefined;
  const rows = computed(() => {
    const seen = new Set<string>();
    return [...usage.value.recentRequests, ...older.value].filter(row => !seen.has(row.requestId) && !!seen.add(row.requestId));
  });
  const cursor = computed(() => page.value ?? usage.value.requestPage);
  watch(runId, () => { controller?.abort(); older.value = []; page.value = null; error.value = ''; busy.value = false; });
  async function more() {
    if (busy.value || !cursor.value?.hasMore || !cursor.value.nextBefore) return;
    const id = runId.value, abort = new AbortController(); controller = abort; busy.value = true; error.value = '';
    try {
      const result = await v1<{ requests: UsageRequest[]; requestPage: UsageRequestPage }>(`/api/v1/runs/${encodeURIComponent(id)}/usage/requests?limit=100&before=${encodeURIComponent(cursor.value.nextBefore)}`, { signal: abort.signal });
      if (runId.value === id && !abort.signal.aborted) { older.value.push(...result.requests); page.value = result.requestPage; }
    } catch (e) { if (!abort.signal.aborted) error.value = e instanceof Error ? e.message : '请求明细加载失败'; }
    finally { if (controller === abort) busy.value = false; }
  }
  onBeforeUnmount(() => controller?.abort());
  return { rows, cursor, busy, error, more };
}
