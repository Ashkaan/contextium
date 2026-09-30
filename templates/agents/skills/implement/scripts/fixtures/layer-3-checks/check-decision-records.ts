// layer-3.test.ts fixture: a check that passes only when handed the change
// since HEAD, so its PASS line also proves the arguments layer-3.ts gives it.
const ok = process.argv.slice(2).join(" ") === "--since HEAD";
process.exit(ok ? 0 : 1);
