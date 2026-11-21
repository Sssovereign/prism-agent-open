import { test } from 'node:test';
import assert from 'node:assert/strict';
import { USER_INPUT_COLLAPSED_HEIGHT, DISCLOSURE_DURATION_MS, DISCLOSURE_EASING, userInputOverflows, userInputMaxHeight, resolveHistoryOpen, readDisclosureChoice, saveDisclosureChoice, claimToolEntrance } from '../web/conversation/motion.js';

test('restored tools never enter; new live identities animate once across replay and remount', () => {
  const session = {};
  assert.equal(claimToolEntrance(session, 'old-running', ['old-running', 'old-done'], true), false);
  assert.equal(claimToolEntrance(session, 'new', ['old-running', 'old-done', 'new'], true), true);
  assert.equal(claimToolEntrance(session, 'new', [], true), false);
  assert.equal(claimToolEntrance(session, 'older-page', [], false), false);
  assert.equal(claimToolEntrance(session, 'older-page', [], true), false);
});

test('user content uses upstream measured 120px height and 1px overflow tolerance', () => {
  assert.equal(USER_INPUT_COLLAPSED_HEIGHT, 120);
  assert.equal(userInputOverflows(120), false);
  assert.equal(userInputOverflows(121), false);
  assert.equal(userInputOverflows(122), true);
  assert.equal(userInputMaxHeight(false, 1500), '120px');
  assert.equal(userInputMaxHeight(true, 1500), '1500px');
  assert.equal(userInputMaxHeight(true, 42), '120px');
});
test('disclosure ports upstream duration and Tailwind ease-in-out without arbitrary timing', () => {
  assert.equal(DISCLOSURE_DURATION_MS, 300);
  assert.equal(DISCLOSURE_EASING, 'cubic-bezier(0.4, 0, 0.2, 1)');
});
test('automatic completion closes default history but preserves either explicit user choice', () => {
  assert.equal(resolveHistoryOpen(true), true);
  assert.equal(resolveHistoryOpen(false), false);
  assert.equal(resolveHistoryOpen(false, true), true);
  assert.equal(resolveHistoryOpen(true, false), false);
});
test('virtual remount keeps disclosure choice, isolated by session and tool or segment identity', () => {
  const session = {}, other = {};
  saveDisclosureChoice(session, 'tool:a', true);
  saveDisclosureChoice(session, 'segment:a', false);
  assert.equal(readDisclosureChoice(session, 'tool:a'), true);
  assert.equal(readDisclosureChoice(session, 'segment:a'), false);
  assert.equal(readDisclosureChoice(other, 'tool:a'), undefined);
  assert.equal(readDisclosureChoice(session, 'tool:b'), undefined);
  // Replayed completion uses the same key; it must not clear deliberate expansion.
  assert.equal(resolveHistoryOpen(false, readDisclosureChoice(session, 'tool:a')), true);
});
