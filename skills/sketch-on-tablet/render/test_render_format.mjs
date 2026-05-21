import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatIterationLabel } from './render.mjs';

test('two-digit iteration with no subtopic', () => {
  assert.equal(formatIterationLabel('00', undefined), '#00');
  assert.equal(formatIterationLabel('01', undefined), '#01');
  assert.equal(formatIterationLabel('05', undefined), '#05');
  assert.equal(formatIterationLabel('99', undefined), '#99');
});

test('two-digit iteration with subtopic', () => {
  assert.equal(formatIterationLabel('00', 'preview'), ': preview #00');
  assert.equal(formatIterationLabel('05', 'cancel button'), ': cancel button #05');
});

test('empty-string subtopic is equivalent to undefined', () => {
  assert.equal(formatIterationLabel('05', ''), '#05');
});

test('rejects single-digit, non-numeric, and seed legacy', () => {
  assert.throws(() => formatIterationLabel('5', undefined), /two decimal digits/);
  assert.throws(() => formatIterationLabel('seed', undefined), /two decimal digits/);
  assert.throws(() => formatIterationLabel('iter05', undefined), /two decimal digits/);
});

test('accepts three-or-more-digit iterations (sessions past 99)', () => {
  // Mirrors ITER_NN_RE = `\d{2,}` in _chrome_boxes.py.
  assert.equal(formatIterationLabel('001', undefined), '#001');
  assert.equal(formatIterationLabel('100', undefined), '#100');
});

test('subtopic with single quote does not break HTML escape', () => {
  // Caller is responsible for HTML-escaping; this function returns the
  // raw composite. The render pipeline escapes downstream.
  assert.equal(formatIterationLabel('03', "user's choice"), ": user's choice #03");
});
