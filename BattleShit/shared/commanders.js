// Commanders and the charge economy.
//
// Every commander has exactly one ultimate. Charge comes from two sources:
//   - UBI: a flat amount at the start of each of your turns.
//   - Damage taken: every hit on one of your ships, plus a bonus when one sinks.
// The second source is the rubber band. The player who is losing charges faster,
// so a lopsided match tends to produce a late ultimate from the underdog.

export const RULES = {
  UBI_PER_TURN: 1,
  CHARGE_PER_HIT_TAKEN: 1,
  CHARGE_PER_SINK_TAKEN: 1,
  SECOND_PLAYER_BONUS: 1,
  // Charge can bank past one ultimate (you still fire at most one per turn).
  CHARGE_CAP_MULT: 1,
  TURN_SECONDS: 45,
  PLACEMENT_SECONDS: 120,
};

export const COMMANDERS = [
  {
    id: 'kestrel',
    name: 'KESTREL',
    role: 'NAVAL AVIATION',
    color: '#5fd7ff',
    ult: {
      id: 'airstrike',
      name: 'AIRSTRIKE',
      cost: 10,
      desc: 'A 5-cell strafing run in a straight line. Flies over islands.',
      rotatable: true,
    },
    quote: 'Lines are honest. So are bombs.',
  },
  {
    id: 'leviathan',
    name: 'LEVIATHAN',
    role: 'SUBMARINE COMMAND',
    color: '#7dffb0',
    ult: {
      id: 'torpedo',
      name: 'TORPEDO RUN',
      cost: 8,
      desc: 'Launch from any water cell in 4 directions. Runs until it strikes a hull, land or the edge.',
      rotatable: true,
      directions: 4,
    },
    quote: 'The sea is wide. My lanes are not.',
  },
  {
    id: 'bastion',
    name: 'BASTION',
    role: 'COASTAL ARTILLERY',
    color: '#ffb347',
    ult: {
      id: 'bombard',
      name: 'BOMBARDMENT',
      cost: 12,
      desc: 'Saturate a 3x3 grid square.',
    },
    quote: 'Precision is a luxury. Volume is a plan.',
  },
  {
    id: 'wraith',
    name: 'WRAITH',
    role: 'SIGNALS INTELLIGENCE',
    color: '#c58cff',
    ult: {
      id: 'scan',
      name: 'DEEP SCAN',
      cost: 10,
      desc: 'Sonar sweep of a radius-2 diamond (13 cells). Reveals every hull inside. Deals no damage.',
    },
    quote: 'I do not miss. I simply have not looked yet.',
  },
  {
    id: 'vector',
    name: 'VECTOR',
    role: 'GUIDED MUNITIONS',
    color: '#ff6f91',
    ult: {
      id: 'homing',
      name: 'HUNTER-KILLER',
      cost: 6,
      desc: 'Strike a cell. On a miss the warhead reacquires the nearest intact hull within 2 cells.',
    },
    quote: 'Close enough is a direct hit.',
  },
];

export function getCommander(id) {
  return COMMANDERS.find((c) => c.id === id) || null;
}

// Direction vectors. Index matters: rotation cycles through them.
export const DIRS = [
  { id: 'E', dx: 1, dy: 0 },
  { id: 'S', dx: 0, dy: 1 },
  { id: 'W', dx: -1, dy: 0 },
  { id: 'N', dx: 0, dy: -1 },
];
