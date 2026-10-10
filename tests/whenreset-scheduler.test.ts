import { it, vi, expect, afterEach } from "vitest";

const jobs = new Map<string, () => Promise<void>>();
const stop = vi.fn();
vi.mock("../src/server/scheduler.js", () => ({
  scheduleDaily: (run: () => Promise<void>, expression: string) => {
    jobs.set(expression, run);
    return { stop };
  },
}));
const runWatch = vi.fn();
vi.mock("../src/server/runWhenResetWatch.js", () => ({
  runWhenResetWatch: (...args: unknown[]) => runWatch(...args),
}));
const createProcess = vi.fn(async () => async () => {});
vi.mock("../src/server/createProcessCandidate.js", () => ({
  createProcessCandidate: (..._args: unknown[]) => createProcess(),
}));
const { scheduleWhenResetWatch } = await import("../src/server/scheduleWhenResetWatch.js");
const fire = () => jobs.get("*/5 * * * *")!();
afterEach(() => {
  vi.clearAllMocks();
  jobs.clear();
});

it("runs on startup/every5m, suppresses and redacts error streaks, survives failed owner notifications", async () => {
  runWatch
    .mockRejectedValueOnce(new Error("https://secret.test/?token=do-not-log"))
    .mockRejectedValueOnce(new Error("down"))
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("new streak"));
  const notifyOwner = vi.fn(async (_text: string) => {}).mockRejectedValue(new Error("owner down"));
  const watch = scheduleWhenResetWatch({
    store: {} as never,
    autoPublish: async () => {},
    sendRawCard: async () => {},
    inWatchSlot: async (task) => task(),
    notifyOwner,
  });
  await watch.idle();
  expect(jobs.has("*/5 * * * *")).toBe(true);
  expect(runWatch).toHaveBeenCalledTimes(1);
  await expect(fire()).resolves.toBeUndefined();
  expect(notifyOwner).toHaveBeenCalledTimes(1);
  expect(notifyOwner.mock.calls[0]?.[0]).toContain("WhenReset");
  expect(notifyOwner.mock.calls[0]?.[0]).not.toContain("secret");
  await fire();
  await fire();
  expect(notifyOwner).toHaveBeenCalledTimes(2);
  watch.stop();
});

it("does not overlap, stop blocks more work and idle waits out the ongoing sweep", async () => {
  let finish!: () => void;
  runWatch.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const watch = scheduleWhenResetWatch({
    store: {} as never,
    autoPublish: async () => {},
    sendRawCard: async () => {},
    inWatchSlot: async (task) => task(),
    notifyOwner: async () => {},
  });
  await vi.waitFor(() => expect(runWatch).toHaveBeenCalledTimes(1));
  await fire();
  expect(runWatch).toHaveBeenCalledTimes(1);
  let idle = false;
  const draining = watch.idle().then(() => {
    idle = true;
  });
  watch.stop();
  expect(stop).toHaveBeenCalledTimes(1);
  await fire();
  expect(idle).toBe(false);
  expect(runWatch.mock.calls[0]?.[2]()).toBe(true);
  finish();
  await draining;
  expect(idle).toBe(true);
});

it("retries baseline at the next tick if the shared collection slot was busy at startup", async () => {
  let busy = true;
  runWatch.mockResolvedValue({});
  const inWatchSlot = vi.fn(async (task: () => Promise<void>) => {
    if (!busy) await task();
  });
  const watch = scheduleWhenResetWatch({
    store: {} as never,
    autoPublish: async () => {},
    sendRawCard: async () => {},
    inWatchSlot,
    notifyOwner: async () => {},
  });
  await watch.idle();
  expect(runWatch).not.toHaveBeenCalled();
  busy = false;
  await fire();
  expect(runWatch).toHaveBeenCalledTimes(1);
  watch.stop();
});
