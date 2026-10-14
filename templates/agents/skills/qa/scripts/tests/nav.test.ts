import assert from "node:assert/strict";
import { test } from "node:test";

import { NETWORK_CHANGED, gotoSurvivingNetworkChange } from "../nav.ts";

// A page whose goto fails with each queued error in turn, then succeeds.
function fakePage(errors: Error[]) {
  const calls: { url: string; options: unknown }[] = [];
  return {
    calls,
    async goto(url: string, options?: { timeout: number }): Promise<string> {
      calls.push({ url, options });
      const e = errors.shift();
      if (e) throw e;
      return `loaded ${url}`;
    },
  };
}

const changed = () =>
  new Error(`page.goto: ${NETWORK_CHANGED} at https://www.linkedin.com/feed/\nCall log:\n  - navigating`);

test("a page that loads first time is loaded once", async () => {
  const page = fakePage([]);
  assert.equal(await gotoSurvivingNetworkChange(page, "https://a.test/", { timeout: 5 }, 0), "loaded https://a.test/");
  assert.equal(page.calls.length, 1);
});

test("a network change mid-load is retried once with the same url and options", async () => {
  const page = fakePage([changed()]);
  assert.equal(await gotoSurvivingNetworkChange(page, "https://a.test/", { timeout: 5 }, 0), "loaded https://a.test/");
  assert.deepEqual(page.calls, [
    { url: "https://a.test/", options: { timeout: 5 } },
    { url: "https://a.test/", options: { timeout: 5 } },
  ]);
});

test("a second network change is thrown, not retried again", async () => {
  const page = fakePage([changed(), changed()]);
  await assert.rejects(gotoSurvivingNetworkChange(page, "https://a.test/", undefined, 0), /ERR_NETWORK_CHANGED/);
  assert.equal(page.calls.length, 2);
});

test("any other navigation error is thrown on the first attempt", async () => {
  for (const msg of [
    "page.goto: Timeout 45000ms exceeded",
    "page.goto: net::ERR_NAME_NOT_RESOLVED at https://a.test/",
  ]) {
    const page = fakePage([new Error(msg)]);
    await assert.rejects(gotoSurvivingNetworkChange(page, "https://a.test/", undefined, 0), { message: msg });
    assert.equal(page.calls.length, 1, msg);
  }
});

test("a thrown non-Error is passed through untouched", async () => {
  const page = {
    async goto(): Promise<string> {
      throw NETWORK_CHANGED;
    },
  };
  await assert.rejects(gotoSurvivingNetworkChange(page, "https://a.test/", undefined, 0), (e) => e === NETWORK_CHANGED);
});
