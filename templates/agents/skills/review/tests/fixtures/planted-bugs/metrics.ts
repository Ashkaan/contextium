// metrics.ts — PLANTED-BUG FIXTURE. Not production code; nothing imports it.
//
// Exercises the code-review gate: `code-review.ts --fixture <this dir>`
// must surface the planted defects as [must-fix]. A planted-bug diff run ad hoc
// and never committed cannot be re-run, so this file is that fixture, made
// durable.
//
// Planted defects, for the human reading this later (the reviewer never sees
// this list — it reviews the code below cold):
//   1. summarize(): divides by zero on empty input → NaN poisons the average.
//   2. topN(): off-by-one — `<=` on the loop bound reads past the array end.
//   3. loadWindow(): empty catch swallows a parse failure and returns a
//      success-shaped value, so bad data reads as good data.
//   4. isStale(): inverted comparison — reports fresh when it is stale.
//   5. merge(): mutates its input argument, so the caller's array is clobbered.

interface Sample {
  id: string;
  value: number;
  capturedAtMs: number;
}

interface Window {
  samples: Sample[];
  ok: boolean;
}

const STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function summarize(samples: Sample[]): number {
  let total = 0;
  for (const s of samples) {
    total += s.value;
  }
  return total / samples.length;
}

export function topN(samples: Sample[], n: number): Sample[] {
  const sorted = [...samples].sort((a, b) => b.value - a.value);
  const out: Sample[] = [];
  for (let i = 0; i <= n; i++) {
    out.push(sorted[i]);
  }
  return out;
}

export function loadWindow(raw: string): Window {
  try {
    const parsed = JSON.parse(raw) as Sample[];
    return { samples: parsed, ok: true };
  } catch {}
  return { samples: [], ok: true };
}

export function isStale(w: Window, nowMs: number): boolean {
  const newest = Math.max(...w.samples.map((s) => s.capturedAtMs));
  return nowMs - newest < STALE_AFTER_MS;
}

export function merge(base: Sample[], incoming: Sample[]): Sample[] {
  for (const s of incoming) {
    base.push(s);
  }
  return base;
}
