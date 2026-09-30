import { it, vi, expect, describe, afterEach } from "vitest";

vi.stubEnv("CHANNEL_DIGEST_CRON", "0 11,19 * * *");
vi.stubEnv("CHANNEL_WATCH_CRON", "15 8-22 * * *");
const jobs = new Map<string, () => Promise<void>>();
const stop = vi.fn();
vi.mock("../src/server/scheduler.js", () => ({
  scheduleDaily: (run: () => Promise<void>, expression: string) => {
    jobs.set(expression, run);
    return { stop };
  },
}));
vi.mock("../src/server/runChannelWatch.js", () => ({ runChannelWatch: async () => {} }));

const { scheduleChannelWatch } = await import("../src/server/scheduleChannelWatch.js");

const fire = () => jobs.get("0 11,19 * * *")!();

function schedule(runChannelIssue: () => Promise<void>) {
  const notifyOwner = vi.fn(async (_text: string) => {});
  const channelJobs = scheduleChannelWatch({
    store: {} as never,
    inWatchSlot: async (task) => task(),
    notifyOwner,
    runChannelIssue,
  });
  return { notifyOwner, channelJobs };
}

afterEach(() => {
  jobs.clear();
  vi.clearAllMocks();
});

describe("scheduleChannelWatch: digest issue job", () => {
  it("a failing issue never throws out of the cron and pings the owner once per streak", async () => {
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("no card fits"))
      .mockRejectedValueOnce(new Error("still no card"))
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("new streak"));
    const { notifyOwner } = schedule(run);

    await expect(fire()).resolves.toBeUndefined();
    await expect(fire()).resolves.toBeUndefined();
    expect(notifyOwner).toHaveBeenCalledTimes(1);
    expect(notifyOwner.mock.calls[0]![0]).toContain("no card fits");

    await fire();
    await fire();
    expect(notifyOwner).toHaveBeenCalledTimes(2);
    expect(notifyOwner.mock.calls[1]![0]).toContain("new streak");
  });

  it("survives a failing owner note", async () => {
    const { notifyOwner } = schedule(() => Promise.reject(new Error("boom")));
    notifyOwner.mockRejectedValue(new Error("telegram down"));

    await expect(fire()).resolves.toBeUndefined();
  });

  it("skips a tick while the previous issue is still running, and idle() waits for it", async () => {
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { channelJobs } = schedule(run);

    const first = fire();
    await fire();
    expect(run).toHaveBeenCalledTimes(1);

    let idle = false;
    void channelJobs.idle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    finish();
    await first;
    await channelJobs.idle();
    expect(idle).toBe(true);

    void fire();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("runs outside the watch slot", async () => {
    const inWatchSlot = vi.fn(async (task: () => Promise<void>) => task());
    const run = vi.fn(async () => {});
    scheduleChannelWatch({
      store: {} as never,
      inWatchSlot,
      notifyOwner: async () => {},
      runChannelIssue: run,
    });

    await fire();

    expect(run).toHaveBeenCalledTimes(1);
    expect(inWatchSlot).not.toHaveBeenCalled();
  });

  it("stop() stops both crons", () => {
    const { channelJobs } = schedule(async () => {});
    channelJobs.stop();
    expect(stop).toHaveBeenCalledTimes(2);
  });
});
