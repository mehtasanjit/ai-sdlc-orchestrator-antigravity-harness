import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node resolves symlinks in the main module's import.meta.url but leaves
// argv[1] as typed, so a script run through the .agents/plugins/mmo mount
// only matches itself once both sides are realpath'd.
export function isMain(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
