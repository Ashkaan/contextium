// The repo a generator serves, from the generator's own location.
//
// Installed, the generators sit at <repo>/.agents/generators/; in the repo that
// authors the layer they sit at <repo>/templates/agents/generators/. A fixed
// "../../.." fits only the second, and in an installed repo it read the folder
// ABOVE the repo — so every index came back "cannot read <parent>/projects".

import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function repoRoot(moduleUrl: string): string {
  const generators = dirname(fileURLToPath(moduleUrl));
  const layer = dirname(generators);
  return basename(layer) === ".agents" ? dirname(layer) : join(layer, "../..");
}
