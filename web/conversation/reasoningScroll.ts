/** ZCode reasoning.tsx bottom lock: tolerate fractional layout by at most 2px. */
export interface ReasoningScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}
export function isReasoningScrollAtBottom(viewport: ReasoningScrollMetrics): boolean {
  return Math.max(0, viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) <= 2;
}

/** Local to one reasoning block; never scroll the conversation or reclaim a reader's position. */
export function createReasoningScrollFollow() {
  let following = true;
  let lastTop = 0;
  return {
    pause() { following = false; },
    onScroll(viewport: ReasoningScrollMetrics) {
      // Even a 1px upward gesture yields control; only returning downward to the bottom rearms.
      if (viewport.scrollTop < lastTop) following = false;
      else if (following || viewport.scrollTop > lastTop) following = isReasoningScrollAtBottom(viewport);
      lastTop = viewport.scrollTop;
    },
    sync(viewport: ReasoningScrollMetrics, visible: boolean) {
      if (!visible || !following) return;
      viewport.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
      lastTop = viewport.scrollTop;
    },
  };
}
