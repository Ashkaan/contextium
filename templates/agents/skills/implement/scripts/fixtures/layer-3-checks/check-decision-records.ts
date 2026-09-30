// layer-3.test.ts fixture: a check that passes only when handed the change
// since the base the close measures from, so its PASS line also proves the
// arguments layer-3.ts gives it. The test names that base in
// LAYER3_EXPECTED_SINCE (the trunk merge-base); with none named it is HEAD,
// the fallback for a tree that has no trunk to measure from.
const want = `--since ${process.env.LAYER3_EXPECTED_SINCE || "HEAD"}`;
process.exit(process.argv.slice(2).join(" ") === want ? 0 : 1);
