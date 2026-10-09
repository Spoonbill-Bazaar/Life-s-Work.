// Print every theatre with water counts and check the fleet fits.
import { MAP_DEFS, getMap } from '../shared/maps.js';
import { randomPlacements } from '../shared/engine.js';
for (const d of MAP_DEFS) {
  const m = getMap(d.id);
  const ship = m.fleet.reduce((a, s) => a + s.len, 0);
  console.log(`${m.name.padEnd(12)} ${m.w}x${m.h} water=${m.water} density=${(ship / m.water * 100).toFixed(1)}%`);
  for (let y = 0; y < m.h; y++) console.log('  ' + m.cells.slice(y * m.w, y * m.w + m.w).map((c) => ' .#'[c]).join(''));
  randomPlacements(m);
}
