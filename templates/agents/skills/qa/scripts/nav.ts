// nav.ts — a page.goto that survives the host's network changing under it.
//
// Chrome aborts a navigation in flight with `net::ERR_NETWORK_CHANGED` whenever
// an interface on the host gains or loses an address — on a Docker host, every
// container start attaches one. A check that loses its page that way reports a
// failure the app never had. Chrome has no switch to ignore the change, and the
// change is over by the time the error surfaces, so the fix is to load the page
// again, once.
// Only that one error is retried. A timeout, a DNS failure or a refused
// connection is a real answer about the target, and a second attempt would hide
// it or double its cost.

/** The error Chrome raises when the host's network changed mid-navigation. */
export const NETWORK_CHANGED = "net::ERR_NETWORK_CHANGED";

/** How long to let the host's interfaces settle before the second attempt. */
export const SETTLE_MS = 2_000;

/** The one method this needs, so any Playwright build's Page satisfies it. */
export interface Navigable<R, O> {
  goto(url: string, options?: O): Promise<R>;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `page.goto(url, options)`, retried once after `settleMs` when the first attempt
 * fails with {@link NETWORK_CHANGED}. Any other error, and a second
 * NETWORK_CHANGED, is thrown unchanged.
 */
export async function gotoSurvivingNetworkChange<R, O>(
  page: Navigable<R, O>,
  url: string,
  options?: O,
  settleMs: number = SETTLE_MS,
): Promise<R> {
  try {
    return await page.goto(url, options);
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes(NETWORK_CHANGED)) throw e;
    console.error(`nav: ${NETWORK_CHANGED} loading ${url}; retrying once in ${settleMs}ms`);
    await sleep(settleMs);
    return page.goto(url, options);
  }
}
