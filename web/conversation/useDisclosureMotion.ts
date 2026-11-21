import { onMounted, onBeforeUnmount } from 'vue';
import { DISCLOSURE_DURATION_MS, DISCLOSURE_EASING } from './motion.js';

/** Vue port of ZCode CollapsibleContent: measured height outside, opacity on direct child.
 * No appear animation: history/virtual remounts start at their final layout. No transition:all.
 * Keep children throughout leave; cancelling/reversing starts from the currently drawn height.
 */
export function useDisclosureMotion() {
  let active: { element: HTMLElement; inner: HTMLElement; animations: Animation[]; done: () => void } | undefined;
  let interrupted: { height: number; opacity: string } | undefined;
  let media: MediaQueryList | undefined;
  let motionObserver: MutationObserver | undefined;
  // WAAPI is not disabled by the global CSS reduce-motion override.
  const suppressed = () => document.documentElement.dataset.reduceMotion === 'true' || media?.matches || document.hidden;
  const clearStyles = (element: HTMLElement, inner: HTMLElement) => {
    element.style.removeProperty('height');
    element.style.removeProperty('overflow');
    inner.style.removeProperty('opacity');
  };
  function finish() {
    if (!active) return;
    const current = active;
    active = undefined;
    current.animations.forEach(animation => animation.cancel());
    clearStyles(current.element, current.inner);
    current.done();
  }
  function cancel() {
    if (!active) return;
    const current = active;
    interrupted = { height: current.element.getBoundingClientRect().height, opacity: getComputedStyle(current.inner).opacity };
    active = undefined;
    current.animations.forEach(animation => animation.cancel());
    clearStyles(current.element, current.inner);
  }
  function animate(element: Element, opening: boolean, done: () => void) {
    const shell = element as HTMLElement;
    const inner = shell.firstElementChild as HTMLElement | null;
    if (!inner || suppressed() || typeof shell.animate !== 'function') {
      interrupted = undefined;
      done();
      return;
    }
    const from = interrupted?.height ?? (opening ? 0 : shell.getBoundingClientRect().height);
    const opacity = interrupted?.opacity ?? (opening ? '0' : '1');
    interrupted = undefined;
    const to = opening ? inner.getBoundingClientRect().height : 0;
    shell.style.overflow = 'hidden';
    const options: KeyframeAnimationOptions = { duration: DISCLOSURE_DURATION_MS, easing: DISCLOSURE_EASING, fill: 'both' };
    const heightAnimation = shell.animate([{ height: `${from}px` }, { height: `${to}px` }], options);
    const fadeAnimation = inner.animate([{ opacity }, { opacity: opening ? '1' : '0' }], options);
    const current = { element: shell, inner, animations: [heightAnimation, fadeAnimation], done };
    active = current;
    heightAnimation.onfinish = () => { if (active === current) finish(); };
  }
  function settleIfSuppressed() { if (suppressed()) { finish(); interrupted = undefined; } }
  onMounted(() => {
    media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (typeof MutationObserver !== 'undefined') {
      motionObserver = new MutationObserver(settleIfSuppressed);
      motionObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reduce-motion'] });
    }
    media?.addEventListener('change', settleIfSuppressed);
    document.addEventListener('visibilitychange', settleIfSuppressed);
  });
  onBeforeUnmount(() => {
    cancel();
    interrupted = undefined;
    motionObserver?.disconnect();
    media?.removeEventListener('change', settleIfSuppressed);
    document.removeEventListener('visibilitychange', settleIfSuppressed);
  });
  return {
    enter: (element: Element, done: () => void) => animate(element, true, done),
    leave: (element: Element, done: () => void) => animate(element, false, done),
    cancel,
  };
}
