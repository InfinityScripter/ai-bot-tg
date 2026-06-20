import { describe, expect, it } from 'vitest';

import {
  CB,
  encodeModel,
  encodeProvider,
  modelButtons,
  parseCallback,
  providerButtons,
  statusText,
} from '../src/bot-model.js';

describe('callback data round-trip', () => {
  it('encodes and parses a provider pick', () => {
    const data = encodeProvider('glm');
    expect(parseCallback(data)).toEqual({ kind: 'provider', provider: 'glm' });
  });

  it('encodes and parses a model pick, preserving dotted model ids', () => {
    const data = encodeModel('glm', 'glm-4.7-flash');
    expect(parseCallback(data)).toEqual({
      kind: 'model',
      provider: 'glm',
      model: 'glm-4.7-flash',
    });
  });

  it('parses reset and back', () => {
    expect(parseCallback(CB.RESET)).toEqual({ kind: 'reset' });
    expect(parseCallback(CB.BACK)).toEqual({ kind: 'back' });
  });

  it('returns null for unrelated callback data (e.g. approve_/skip_)', () => {
    expect(parseCallback('approve_12')).toBeNull();
    expect(parseCallback('skip_3')).toBeNull();
    expect(parseCallback('whatever')).toBeNull();
  });

  it('returns null for an unknown provider name', () => {
    expect(parseCallback('mp_bogus')).toBeNull();
    expect(parseCallback('mm_bogus__x')).toBeNull();
  });

  it('returns null for a model pick with no model part', () => {
    expect(parseCallback('mm_glm__')).toBeNull();
  });

  it('keeps every callback under Telegram 64-byte limit for known providers', () => {
    for (const b of providerButtons()) {
      expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64);
    }
    const longModel = encodeModel('deepseek', 'deepseek-v4-flash-preview-extended');
    expect(Buffer.byteLength(longModel, 'utf8')).toBeLessThanOrEqual(64);
  });
});

describe('button specs', () => {
  it('providerButtons marks providers without a key using 🔑', () => {
    const buttons = providerButtons();
    const labels = buttons.map((b) => b.text);
    // mock always has a "key"; it is never marked
    expect(labels.find((l) => l.startsWith('Mock'))).not.toContain('🔑');
    // every button carries a provider callback
    for (const b of buttons) expect(b.data.startsWith(CB.PROVIDER)).toBe(true);
  });

  it('modelButtons lists models and appends a back button', () => {
    const buttons = modelButtons('glm', ['glm-4.7-flash', 'glm-4.7']);
    expect(buttons.map((b) => b.text)).toEqual(['glm-4.7-flash', 'glm-4.7', '← Провайдеры']);
    expect(buttons.at(-1)!.data).toBe(CB.BACK);
  });

  it('modelButtons drops a model whose callback data would exceed 64 bytes', () => {
    const tooLong = 'x'.repeat(70); // 'mm_glm__' + 70 > 64
    const buttons = modelButtons('glm', ['glm-4.7-flash', tooLong]);
    expect(buttons.map((b) => b.text)).toEqual(['glm-4.7-flash', '← Провайдеры']);
    // every surviving button is within the limit
    for (const b of buttons) {
      expect(Buffer.byteLength(b.data, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});

describe('statusText', () => {
  it('reports env source when no override', () => {
    const text = statusText({ provider: 'glm', model: 'glm-4.7-flash' }, false);
    expect(text).toContain('GLM / glm-4.7-flash');
    expect(text).toContain('env');
  });

  it('reports override source when overridden', () => {
    const text = statusText({ provider: 'deepseek', model: 'deepseek-v4-flash' }, true);
    expect(text).toContain('override');
  });
});
