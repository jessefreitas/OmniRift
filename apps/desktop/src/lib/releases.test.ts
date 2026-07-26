import { strict as assert } from "node:assert";

import { RELEASES } from "./releases";

assert.equal(RELEASES[0]?.version, "0.1.145");
assert.equal(new Set(RELEASES.map((release) => release.version)).size, RELEASES.length);

for (const release of RELEASES) {
  assert.match(release.version, /^\d+\.\d+\.\d+$/);
  assert.match(release.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(release.title.trim().length > 0);
  assert.ok(release.highlights.length > 0);
  assert.ok(release.highlights.every((highlight) => highlight.trim().length > 0));
}

for (let index = 1; index < RELEASES.length; index += 1) {
  const previous = RELEASES[index - 1].version.split(".").map(Number);
  const current = RELEASES[index].version.split(".").map(Number);
  const previousValue = previous[0] * 1_000_000 + previous[1] * 1_000 + previous[2];
  const currentValue = current[0] * 1_000_000 + current[1] * 1_000 + current[2];
  assert.ok(previousValue > currentValue, `${RELEASES[index - 1].version} deve vir antes de ${RELEASES[index].version}`);
}

console.log(`releases: ${RELEASES.length} entradas válidas e ordenadas`);
