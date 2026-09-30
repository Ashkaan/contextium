#!/usr/bin/env -S node --experimental-strip-types
// stub-prose.ts — CODEX_BIN stub: returns unparseable prose and no sentinel.
//
// Models a reviewer that ignored the strict output format. A review whose
// output could not be parsed has not happened, so the gate must exit 1 with the
// prose diverted to stderr and stdout left empty.
import { writeSync } from "node:fs";

writeSync(1, "I took a look at the changes and they seem reasonable overall.\n");
writeSync(1, "Nothing jumped out at me as a serious problem.\n");
