import { afterEach, describe, expect, it, vi } from 'vitest';

import { CandidateStore } from '../src/store.js';

// CONFIG is parsed from process.env at import time, so cases that depend on
// REWRITE_PROVIDER / REWRITE_MOCK stub the env then re-import the module.
async function importProviders() {
  return import('../src/providers.js');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('PROVIDERS registry', () => {
  it('lists the expected providers', async () => {
    const { providerNames } = await importProviders();
    expect(providerNames()).toEqual(
      expect.arrayContaining(['anthropic', 'gemini', 'glm', 'deepseek', 'mock'])
    );
  });

  it('every non-mock provider has a default model and a non-empty fallback list', async () => {
    const { PROVIDERS, providerNames } = await importProviders();
    for (const name of providerNames()) {
      const spec = PROVIDERS[name];
      expect(spec.label.length).toBeGreaterThan(0);
      if (name !== 'mock') {
        expect(spec.defaultModel.length).toBeGreaterThan(0);
        expect(spec.fallbackModels.length).toBeGreaterThan(0);
      }
    }
  });

  it('openai-compat providers expose an https baseUrl', async () => {
    const { PROVIDERS, providerNames } = await importProviders();
    for (const name of providerNames()) {
      const spec = PROVIDERS[name];
      if (spec.kind === 'openai-compat') {
        expect(spec.baseUrl).toMatch(/^https:\/\//);
      }
    }
  });
});

describe('resolveActiveProvider', () => {
  it('falls back to the env provider + its default model when no override', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { PROVIDERS, resolveActiveProvider } = await importProviders();
    const s = new CandidateStore(':memory:');
    const active = resolveActiveProvider(s);
    expect(active.provider).toBe('glm');
    expect(active.model).toBe(PROVIDERS.glm.defaultModel);
    s.close();
  });

  it('a stored override wins over the env provider', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { resolveActiveProvider } = await importProviders();
    const s = new CandidateStore(':memory:');
    s.setModelOverride('deepseek', 'deepseek-v4-pro');
    const active = resolveActiveProvider(s);
    expect(active.provider).toBe('deepseek');
    expect(active.model).toBe('deepseek-v4-pro');
    s.close();
  });

  it('ignores an override naming an unknown provider, falling back to env', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { resolveActiveProvider } = await importProviders();
    const s = new CandidateStore(':memory:');
    s.setModelOverride('totally-made-up', 'x');
    const active = resolveActiveProvider(s);
    expect(active.provider).toBe('glm');
    s.close();
  });

  it('REWRITE_MOCK forces mock regardless of override', async () => {
    vi.stubEnv('REWRITE_MOCK', '1');
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.resetModules();
    const { resolveActiveProvider } = await importProviders();
    const s = new CandidateStore(':memory:');
    s.setModelOverride('deepseek', 'deepseek-v4-flash');
    const active = resolveActiveProvider(s);
    expect(active.provider).toBe('mock');
    s.close();
  });
});

describe('hasActiveOverride', () => {
  it('is false with no override, true with a valid one', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { hasActiveOverride } = await importProviders();
    const s = new CandidateStore(':memory:');
    expect(hasActiveOverride(s)).toBe(false);
    s.setModelOverride('deepseek', 'deepseek-v4-flash');
    expect(hasActiveOverride(s)).toBe(true);
    s.close();
  });

  it('is false when the override names an unknown provider (stale row)', async () => {
    vi.stubEnv('REWRITE_PROVIDER', 'glm');
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { hasActiveOverride } = await importProviders();
    const s = new CandidateStore(':memory:');
    s.setModelOverride('removed-provider', 'x');
    expect(hasActiveOverride(s)).toBe(false);
    s.close();
  });
});
