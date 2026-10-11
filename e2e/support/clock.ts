import type { Page } from "@playwright/test";

/**
 * Pin the page's wall clock (Date only) to a fixed instant; it then ticks forward normally.
 *
 * Playwright's page.clock (install or setFixedTime) also fakes performance.now / animation frames, which
 * stalls motion's AnimatePresence when leaving a place browser. Only Date matters for what the UI shows
 * (file dates, "Backed up today"), so we override just that.
 */
export async function pinClock(page: Page, at: Date) {
  await page.addInitScript((startMs: number) => {
    const RealDate = Date;
    const realStart = RealDate.now();
    const state = { offset: startMs - realStart };
    const now = () => RealDate.now() + state.offset;
    class PinnedDate extends RealDate {
      constructor(...args: unknown[]) {
        if (args.length === 0) super(now());
        else super(...(args as [string]));
      }
      static now() {
        return now();
      }
    }
    (window as unknown as { Date: DateConstructor }).Date = PinnedDate as unknown as DateConstructor;
    (window as unknown as { __memoriesSetNow: (ms: number) => void }).__memoriesSetNow = (ms: number) => {
      state.offset = ms - RealDate.now();
    };
  }, at.getTime());
}

/** Move the pinned clock (takes effect immediately; persists only until the next navigation). */
export async function setNow(page: Page, at: Date) {
  await page.evaluate((ms) => (window as unknown as { __memoriesSetNow: (ms: number) => void }).__memoriesSetNow(ms), at.getTime());
}
