import test from 'node:test';
import assert from 'node:assert/strict';
import { BUBBLE_TINT_DURATION_MS, bubbleAgeMs, bubbleAgeColor, previewBubbleAgeMs, bubbleAgeLabel } from '../dist/bubble-history.mjs';

test('saved ages handle unknown history and backwards clocks without inventing dates', () => {
  assert.equal(bubbleAgeMs(null, 1000), null);
  assert.equal(bubbleAgeMs(undefined, 1000), null);
  assert.equal(bubbleAgeMs(NaN, 1000), null);
  assert.equal(bubbleAgeMs(-1, 1000), null);
  assert.equal(bubbleAgeMs(9e15, 1000), null);
  assert.equal(bubbleAgeMs(0, 1000), 1000);
  assert.equal(bubbleAgeMs(2000, 1000), 0);
  assert.equal(bubbleAgeMs(1000, 61000), 60000);
});

test('new-bubble tint fades monotonically into each chosen color after one day', () => {
  for (const base of ['#c3f774', '#77d6ae', '#73a7ed', '#b894ea', '#ee92b4', '#eec078']) {
    const distance = color => [1, 3, 5].reduce((sum, offset) => sum + Math.abs(parseInt(color.slice(offset, offset + 2), 16) - parseInt(base.slice(offset, offset + 2), 16)), 0);
    let previous = Infinity;
    for (let hour = 0; hour <= 24; hour++) {
      const color = bubbleAgeColor(base, hour * 3600000);
      assert.match(color, /^#[0-9a-f]{6}$/i);
      assert.ok(distance(color) <= previous);
      previous = distance(color);
    }
    assert.notEqual(bubbleAgeColor(base, 0), base);
    assert.equal(bubbleAgeColor(base, BUBBLE_TINT_DURATION_MS), base);
    assert.equal(bubbleAgeColor(base, 10 * BUBBLE_TINT_DURATION_MS), base);
    assert.equal(bubbleAgeColor(base, null), base);
  }
});

test('preview dates remain relative and span the illustrated growth timeline', () => {
  for (const [count, seconds] of [[23, 3600], [180, 25 * 3600]]) {
    let previous = seconds * 1000;
    for (let id = 1; id <= count; id++) {
      const age = previewBubbleAgeMs(id, count, seconds);
      assert.ok(age >= 0 && age <= previous);
      previous = age;
    }
    assert.equal(previewBubbleAgeMs(1, count, seconds), seconds * 1000);
    assert.equal(previewBubbleAgeMs(count, count, seconds), 0);
  }
  assert.equal(bubbleAgeLabel(null), 'Age unknown');
  assert.equal(bubbleAgeLabel(59000), 'Just created');
  assert.equal(bubbleAgeLabel(90000), '1m old');
  assert.equal(bubbleAgeLabel(3660000), '1h 1m old');
  assert.equal(bubbleAgeLabel(3 * BUBBLE_TINT_DURATION_MS), '3d old');
});
