import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRenderer, h } from 'vue';
import { createReasoningScrollFollow, isReasoningScrollAtBottom } from '../web/conversation/reasoningScroll.js';
import { useDisclosureMotion } from '../web/conversation/useDisclosureMotion.js';

// No browser, server or data access: deterministic geometry and host APIs only.
test('reasoning bottom lock follows ZCode 2px tolerance, including fractional/overscroll geometry', () => {
  const metrics = { clientHeight: 240, scrollHeight: 1000, scrollTop: 758 };
  assert.equal(isReasoningScrollAtBottom(metrics), true);
  assert.equal(isReasoningScrollAtBottom({ ...metrics, scrollTop: 757.9 }), false);
  assert.equal(isReasoningScrollAtBottom({ ...metrics, scrollTop: 770 }), true);
  assert.equal(isReasoningScrollAtBottom({ clientHeight: 240, scrollHeight: 120, scrollTop: 0 }), true);
});

test('append follows only the local bottom lock; upward scroll yields until reader returns to bottom', () => {
  const follow = createReasoningScrollFollow();
  const viewport = { clientHeight: 240, scrollHeight: 1000, scrollTop: 0 };
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 760);
  viewport.scrollHeight = 1200;
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 960, 'use lock from before content growth');
  viewport.scrollTop = 400;
  follow.onScroll(viewport);
  viewport.scrollHeight = 1500;
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 400, 'never yank a reader back down');
  viewport.scrollTop = 1259;
  follow.onScroll(viewport);
  viewport.scrollHeight = 1600;
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 1360);
});

test('upward intent before a scroll event wins against an arriving delta; tiny upward moves yield too', () => {
  const follow = createReasoningScrollFollow();
  const viewport = { clientHeight: 240, scrollHeight: 1000, scrollTop: 0 };
  follow.sync(viewport, true);
  follow.pause();
  follow.onScroll(viewport); // queued programmatic event must not rearm the lock
  viewport.scrollHeight = 1100;
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 760);
  viewport.scrollTop = 860;
  follow.onScroll(viewport);
  viewport.scrollTop = 859;
  follow.onScroll(viewport);
  viewport.scrollHeight = 1200;
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 859);
});

test('hidden updates do not scroll; reopening preserves paused readers and blocks are isolated', () => {
  const follow = createReasoningScrollFollow(), other = createReasoningScrollFollow();
  const viewport = { clientHeight: 240, scrollHeight: 1000, scrollTop: 0 };
  follow.sync(viewport, false);
  assert.equal(viewport.scrollTop, 0);
  follow.sync(viewport, true);
  viewport.scrollTop = 100;
  follow.onScroll(viewport);
  viewport.scrollHeight = 1500;
  follow.sync(viewport, false);
  follow.sync(viewport, true);
  assert.equal(viewport.scrollTop, 100);
  const second = { ...viewport };
  other.sync(second, true);
  assert.equal(second.scrollTop, 1260);
  assert.equal(viewport.scrollTop, 100);
});

function mountMotion() {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    original.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  const media = new EventTarget() as EventTarget & { matches: boolean };
  media.matches = false;
  const doc = new EventTarget() as EventTarget & { hidden: boolean; documentElement: { dataset: { reduceMotion?: string } } };
  doc.hidden = false;
  doc.documentElement = { dataset: {} };
  let mutation: (() => void) | undefined;
  let observed: unknown;
  let disconnected = false;
  let mediaRemoved = false, visibilityRemoved = false;
  const removeMedia = media.removeEventListener.bind(media);
  media.removeEventListener = (...args: Parameters<typeof removeMedia>) => { mediaRemoved = true; removeMedia(...args); };
  const removeDoc = doc.removeEventListener.bind(doc);
  doc.removeEventListener = (...args: Parameters<typeof removeDoc>) => { visibilityRemoved = true; removeDoc(...args); };
  setGlobal('window', { matchMedia: () => media });
  setGlobal('document', doc);
  setGlobal('getComputedStyle', () => ({ opacity: '0.4' }));
  setGlobal('MutationObserver', class {
    constructor(callback: () => void) { mutation = callback; }
    observe(target: unknown, options: unknown) { observed = { target, options }; }
    disconnect() { disconnected = true; mutation = undefined; }
  });
  const renderer = createRenderer<object, object>({
    patchProp() {}, insert() {}, remove() {}, createElement: () => ({}),
    createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {},
    parentNode: () => null, nextSibling: () => null,
  });
  let motion!: ReturnType<typeof useDisclosureMotion>;
  const app = renderer.createApp({ setup() { motion = useDisclosureMotion(); return () => h('div'); } });
  app.mount({});
  const animations: { cancelled: boolean; onfinish?: () => void; cancel: () => void }[] = [];
  const frames: unknown[] = [];
  const removedStyles: string[] = [];
  const makeElement = () => ({
    style: { overflow: '', removeProperty: (name: string) => { removedStyles.push(name); } },
    getBoundingClientRect: () => ({ height: 120 }),
    animate(keyframes: unknown) {
      frames.push(keyframes);
      const animation = { cancelled: false, onfinish: undefined as (() => void) | undefined, cancel() { this.cancelled = true; } };
      animations.push(animation);
      return animation;
    },
  });
  const inner = makeElement(), shell = { ...makeElement(), firstElementChild: inner };
  let unmounted = false;
  return {
    motion, shell: shell as unknown as Element, doc, media, animations, frames, removedStyles,
    mutate: () => mutation?.(),
    get observed() { return observed; },
    get disconnected() { return disconnected; },
    get listenersRemoved() { return mediaRemoved && visibilityRemoved; },
    unmount() { app.unmount(); unmounted = true; },
    restore() {
      if (!unmounted) app.unmount();
      for (const [name, descriptor] of original) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test('disclosure suppresses WAAPI for product setting, system preference, and hidden documents', () => {
  const env = mountMotion();
  try {
    let done = 0;
    env.doc.documentElement.dataset.reduceMotion = 'true';
    env.motion.enter(env.shell, () => done++);
    env.doc.documentElement.dataset.reduceMotion = 'false';
    env.media.matches = true;
    env.motion.leave(env.shell, () => done++);
    env.media.matches = false;
    env.doc.hidden = true;
    env.motion.enter(env.shell, () => done++);
    assert.equal(done, 3);
    assert.equal(env.animations.length, 0);
    env.doc.hidden = false;
    env.motion.enter(env.shell, () => done++);
    assert.equal(env.animations.length, 2, 'normal motion remains available');
    env.animations[0]!.onfinish!();
    assert.equal(done, 4);
  } finally { env.restore(); }
});

for (const opening of [true, false]) {
  test(`product reduce-motion dynamically settles ${opening ? 'enter' : 'leave'} once and cancels both WAAPI effects`, () => {
    const env = mountMotion();
    try {
      let done = 0;
      (opening ? env.motion.enter : env.motion.leave)(env.shell, () => done++);
      assert.deepEqual(env.observed, { target: env.doc.documentElement, options: { attributes: true, attributeFilter: ['data-reduce-motion'] } });
      env.doc.documentElement.dataset.reduceMotion = 'true';
      env.mutate();
      assert.equal(done, 1);
      assert.ok(env.animations.every(animation => animation.cancelled));
      assert.deepEqual(env.removedStyles, ['height', 'overflow', 'opacity']);
      env.animations[0]!.onfinish!();
      env.mutate();
      assert.equal(done, 1, 'stale completion/observer callbacks cannot finish twice');
      delete env.doc.documentElement.dataset.reduceMotion;
      env.mutate();
      assert.equal(env.animations.length, 2, 'turning motion back on does not replay settled effects');
      env.motion.enter(env.shell, () => done++);
      assert.equal(env.animations.length, 4);
    } finally { env.restore(); }
  });
}

test('system preference changes settle in-flight motion and discard interrupted geometry', () => {
  const env = mountMotion();
  try {
    let done = 0;
    env.motion.enter(env.shell, () => done++);
    env.motion.cancel();
    env.media.matches = true;
    env.media.dispatchEvent(new Event('change'));
    env.media.matches = false;
    env.media.dispatchEvent(new Event('change'));
    env.motion.enter(env.shell, () => done++);
    assert.deepEqual(env.frames[2], [{ height: '0px' }, { height: '120px' }]);
    env.media.matches = true;
    env.media.dispatchEvent(new Event('change'));
    assert.equal(done, 1);
    assert.ok(env.animations.every(animation => animation.cancelled));
  } finally { env.restore(); }
});

test('unmount cancels active effects and disconnects attribute/media/visibility listeners', () => {
  const env = mountMotion();
  try {
    let done = 0;
    env.motion.leave(env.shell, () => done++);
    env.unmount();
    assert.ok(env.disconnected);
    assert.ok(env.listenersRemoved);
    assert.ok(env.animations.every(animation => animation.cancelled));
    env.animations[0]!.onfinish!();
    assert.equal(done, 0, 'unmounted transition must not run a stale done callback');
  } finally { env.restore(); }
});

test('component wiring retains collapsed plain-text 240px region, SVG and observer cleanup', () => {
  const source = readFileSync(resolve('web/conversation/ReasoningBlock.vue'), 'utf8');
  assert.match(source, /const open=ref\(false\)/);
  assert.match(source, /box-sizing:border-box;max-height:240px/);
  assert.match(source, /<svg class="reasoning-chevron"/);
  assert.match(source, /<div ref="content">\{\{ row.text \}\}<\/div>/);
  assert.doesNotMatch(source, /v-html|Markdown|scrollIntoView/);
  assert.match(source, /@scroll="onScroll"/);
  assert.match(source, /@wheel.stop="onWheel"/);
  assert.match(source, /@touchmove.stop="onTouchMove"/);
  assert.match(source, /@keydown.stop="onKeydown"/);
  assert.match(source, /watch\(\(\) => props.row.text, syncScroll, \{flush:'post'\}\)/);
  assert.match(source, /resizeObserver.observe\(viewport.value\)/);
  assert.match(source, /resizeObserver.observe\(content.value\)/);
  assert.match(source, /onBeforeUnmount\(\(\) => resizeObserver\?\.disconnect\(\)\)/);
});

test('UserInput CSS transition already obeys product reduce-motion via global important override', () => {
  const input = readFileSync(resolve('web/conversation/UserInput.vue'), 'utf8');
  const css = readFileSync(resolve('web/style.css'), 'utf8');
  const main = readFileSync(resolve('web/main.ts'), 'utf8');
  assert.match(main, /import\s+['"]\.\/style.css['"]/);
  assert.match(input, /transition:max-height 300ms/);
  assert.doesNotMatch(input, /\.animate\(/);
  assert.match(css, /\[data-reduce-motion=true\] \*[^{}]*\{[^}]*transition:none!important/);
  assert.match(input, /@media\(prefers-reduced-motion:reduce\)\{\.user-body\{transition:none\}\}/);
});
