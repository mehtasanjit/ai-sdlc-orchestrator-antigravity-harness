/**
 * The oldest Node the plugin supports, and the one CI tests on. Kept equal to
 * `engines` in both package.json files and the CI node-version, and inside
 * every locked package's engines.node range; tools/test/node-floor.test.mjs
 * checks all four.
 */
export const MIN_NODE = "22.19.0";

export function meetsNodeFloor(version, floor = MIN_NODE) {
  const parse = (v) => String(v).replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const [a, b] = [parse(version), parse(floor)];
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}
