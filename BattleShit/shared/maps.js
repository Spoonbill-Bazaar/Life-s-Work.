// Theatre definitions.
//   '.' open water (ships may be placed here, shots may land here)
//   '#' land / island (blocks placement, blocks torpedoes, cannot be targeted)
//   ' ' outside the theatre (void)
// Rows are padded to the widest row; fully empty edge rows/columns are trimmed.

export const STANDARD_FLEET = [
  { id: 'carrier', name: 'CARRIER', len: 5 },
  { id: 'battleship', name: 'BATTLESHIP', len: 4 },
  { id: 'cruiser', name: 'CRUISER', len: 3 },
  { id: 'submarine', name: 'SUBMARINE', len: 3 },
  { id: 'destroyer', name: 'DESTROYER', len: 2 },
];

export const MAP_DEFS = [
  {
    id: 'open-water',
    name: 'OPEN WATER',
    blurb: 'Clipped corners, no cover. The honest one.',
    rows: [
      '   .....   ',
      '  .......  ',
      ' ......... ',
      '...........',
      '...........',
      '...........',
      '...........',
      '...........',
      ' ......... ',
      '  .......  ',
      '   .....   ',
    ],
  },
  {
    id: 'atoll',
    name: 'ATOLL',
    blurb: 'A ring reef with a sealed lagoon. Small hulls hide inside.',
    rows: [
      '    .....    ',
      '  .........  ',
      ' ........... ',
      ' ...#####... ',
      '....#...#....',
      '....#...#....',
      '....#...#....',
      ' ...#####... ',
      ' ........... ',
      '  .........  ',
      '    .....    ',
    ],
  },
  {
    id: 'strait',
    name: 'THE STRAIT',
    blurb: 'Two basins and a choke point. Torpedoes love a narrow lane.',
    rows: [
      '......     ......',
      '.......   .......',
      '..#.....  ....#..',
      '.................',
      '.................',
      '..#.....  ....#..',
      '.......   .......',
      '......     ......',
    ],
  },
  {
    id: 'archipelago',
    name: 'ARCHIPELAGO',
    blurb: 'Scattered islands break every line of fire.',
    rows: [
      '.............',
      '..#......##..',
      '.###.........',
      '..#....#.....',
      '.......##..#.',
      '....#.......#',
      '...###..#....',
      '....#........',
      '.........##..',
      '.##..........',
    ],
  },
  {
    id: 'fjords',
    name: 'FJORDS',
    blurb: 'Deep inlets carved into a mountain coast. Pick your lane.',
    rows: [
      '...............',
      '...............',
      '.#...##.##...#.',
      '.#...#...#...#.',
      '.##..#...#..##.',
      '..#..#.#.#..#..',
      '..#..#.#.#..#..',
      '..#....#....#..',
      '..##..###..##..',
      '...#...#...#...',
    ],
  },
  {
    id: 'crescent',
    name: 'CRESCENT',
    blurb: 'A thin moon of water. Nowhere is far from the edge.',
    rows: [
      '     .......     ',
      '   ...........   ',
      '  .......        ',
      ' ......          ',
      ' .....       ... ',
      '......      .....',
      '......      .....',
      '......       ... ',
      ' .....           ',
      ' ......          ',
      '  .......        ',
      '   ...........   ',
      '     .......     ',
    ],
  },
  {
    id: 'twin-lakes',
    name: 'TWIN LAKES',
    blurb: 'Two bodies of water that never touch. Split or stack?',
    rows: [
      ' .......          ',
      '.........   ..... ',
      '....#....  .......',
      '.........  ...#...',
      ' .......   .......',
      '  .....    .......',
      '           .......',
      '  ....      ..... ',
      ' ......           ',
      '  ....            ',
    ],
  },
];

export const VOID = 0;
export const WATER = 1;
export const LAND = 2;

export function parseMap(def) {
  let rows = def.rows.slice();
  // trim empty rows
  while (rows.length && !rows[0].trim()) rows.shift();
  while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
  const w0 = Math.max(...rows.map((r) => r.length));
  rows = rows.map((r) => r.padEnd(w0, ' '));
  // trim empty columns
  let left = 0;
  while (left < w0 && rows.every((r) => r[left] === ' ')) left++;
  let right = w0 - 1;
  while (right > left && rows.every((r) => r[right] === ' ')) right--;
  rows = rows.map((r) => r.slice(left, right + 1));
  const w = right - left + 1;
  const h = rows.length;
  const cells = new Array(w * h);
  let water = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = rows[y][x];
      const t = c === '.' ? WATER : c === '#' ? LAND : VOID;
      if (t === WATER) water++;
      cells[y * w + x] = t;
    }
  }
  return {
    id: def.id,
    name: def.name,
    blurb: def.blurb,
    w,
    h,
    cells,
    water,
    fleet: (def.fleet || STANDARD_FLEET).map((s) => ({ ...s })),
  };
}

const cache = new Map();
export function getMap(id) {
  if (!cache.has(id)) {
    const def = MAP_DEFS.find((m) => m.id === id);
    if (!def) return null;
    cache.set(id, parseMap(def));
  }
  return cache.get(id);
}

export function cellAt(map, x, y) {
  if (x < 0 || y < 0 || x >= map.w || y >= map.h) return VOID;
  return map.cells[y * map.w + x];
}

export function isWater(map, x, y) {
  return cellAt(map, x, y) === WATER;
}
