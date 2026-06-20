import { afterEach, describe, expect, it, vi } from 'vitest';

import { listModels, pingModel } from '../src/models.js';
import { PROVIDERS } from '../src/providers.js';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('listModels', () => {
  it('returns model ids from the /models API when it succeeds (openai-compat)', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { listModels: list } = await import('../src/models.js');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [{ id: 'glm-4.7' }, { id: 'glm-4.7-flash' }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const models = await list('glm');
    // Live ids are merged after the fallback (which holds the free models); the
    // duplicate 'glm-4.7-flash' is de-duped, and 'glm-4.7' (paid, live) appears.
    expect(models).toContain('glm-4.7'); // from live
    expect(models).toContain('glm-4.7-flash'); // from fallback, once
    expect(models.filter((m) => m === 'glm-4.7-flash')).toHaveLength(1);
    expect(models.indexOf('glm-4.7-flash')).toBeLessThan(models.indexOf('glm-4.7'));
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain('api.z.ai');
    expect(url).toContain('/models');
  });

  it('falls back to the static list on a non-OK response', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { listModels: list } = await import('../src/models.js');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403 }));
    const models = await list('glm');
    expect(models).toEqual(PROVIDERS.glm.fallbackModels);
  });

  it('falls back when the API returns an empty list', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'k');
    vi.resetModules();
    const { listModels: list } = await import('../src/models.js');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }));
    const models = await list('deepseek');
    expect(models).toEqual(PROVIDERS.deepseek.fallbackModels);
  });

  it('falls back on a network error', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { listModels: list } = await import('../src/models.js');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
    expect(await list('glm')).toEqual(PROVIDERS.glm.fallbackModels);
  });

  it('returns the static list without calling fetch when the key is missing', async () => {
    // no GLM_API_KEY stubbed → fallback, no network
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const models = await listModels('glm');
    expect(models).toEqual(PROVIDERS.glm.fallbackModels);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the static list for anthropic without hitting a /models endpoint', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const models = await listModels('anthropic');
    expect(models).toEqual(PROVIDERS.anthropic.fallbackModels);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns the static list for mock', async () => {
    expect(await listModels('mock')).toEqual(PROVIDERS.mock.fallbackModels);
  });

  it('caps a huge live list so the keyboard stays renderable', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { listModels: list } = await import('../src/models.js');

    const many = Array.from({ length: 200 }, (_, i) => ({ id: `m-${i}` }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: many }) }));
    const models = await list('glm');
    expect(models.length).toBeLessThanOrEqual(50);
  });
});

describe('pingModel', () => {
  it('returns ok on a 2xx chat response (openai-compat)', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { pingModel: ping } = await import('../src/models.js');

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await ping('glm', 'glm-4.7-flash');
    expect(res.ok).toBe(true);
    // the probe must send the model under test
    const opts = fetchMock.mock.calls[0]![1] as { body: string };
    expect(JSON.parse(opts.body).model).toBe('glm-4.7-flash');
  });

  it('returns a labeled error on a non-OK chat response', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { pingModel: ping } = await import('../src/models.js');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'bad key' })
    );
    const res = await ping('glm', 'glm-4.7-flash');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/GLM.*401/);
  });

  it('returns an error when the key is missing, without calling fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await pingModel('glm', 'glm-4.7-flash');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/ключ/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok for the mock provider without any network call', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await pingModel('mock', 'mock');
    expect(res.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts anthropic when a key is present (no probe, so Claude is selectable)', async () => {
    // setup.ts sets ANTHROPIC_API_KEY, so the default import has a key.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const res = await pingModel('anthropic', 'claude-haiku-4-5');
    expect(res.ok).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a 2xx whose body lacks the chat shape (misrouted gateway)', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { pingModel: ping } = await import('../src/models.js');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ error: 'nope' }) })
    );
    const res = await ping('glm', 'glm-4.7-flash');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/choices/i);
  });

  it('reports a timeout distinctly', async () => {
    vi.stubEnv('GLM_API_KEY', 'k');
    vi.resetModules();
    const { pingModel: ping } = await import('../src/models.js');

    const timeoutErr = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    const res = await ping('glm', 'glm-4.7-flash');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Таймаут/);
  });
});
