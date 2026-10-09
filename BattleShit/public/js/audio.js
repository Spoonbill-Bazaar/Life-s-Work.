// Tiny WebAudio synth. No samples, just blips and noise.

let ctx = null;
let master = null;
let muted = false;
try {
  muted = localStorage.getItem('bs-muted') === '1';
} catch {}

function ac() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.35;
    master.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

export function isMuted() {
  return muted;
}

export function setMuted(m) {
  muted = m;
  try {
    localStorage.setItem('bs-muted', m ? '1' : '0');
  } catch {}
}

function tone({ f0, f1 = f0, dur = 0.12, type = 'sine', gain = 0.4, delay = 0 }) {
  if (muted) return;
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function noise({ dur = 0.3, gain = 0.4, freq = 900, delay = 0 }) {
  if (muted) return;
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const len = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, len, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 2);
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = freq;
  const g = a.createGain();
  g.gain.value = gain;
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

export const sfx = {
  unlock: () => ac(),
  click: () => tone({ f0: 1400, dur: 0.03, type: 'square', gain: 0.06 }),
  hover: () => tone({ f0: 2200, dur: 0.015, type: 'square', gain: 0.02 }),
  place: () => tone({ f0: 520, f1: 780, dur: 0.07, type: 'triangle', gain: 0.18 }),
  bad: () => tone({ f0: 180, f1: 120, dur: 0.12, type: 'square', gain: 0.08 }),
  launch: (d = 0) => tone({ f0: 900, f1: 260, dur: 0.45, type: 'sawtooth', gain: 0.05, delay: d }),
  miss: (d = 0) => {
    tone({ f0: 300, f1: 140, dur: 0.18, type: 'sine', gain: 0.25, delay: d });
    noise({ dur: 0.25, gain: 0.12, freq: 1800, delay: d });
  },
  hit: (d = 0) => {
    noise({ dur: 0.6, gain: 0.6, freq: 700, delay: d });
    tone({ f0: 110, f1: 45, dur: 0.5, type: 'sine', gain: 0.5, delay: d });
  },
  sunk: (d = 0) => {
    noise({ dur: 1.4, gain: 0.5, freq: 400, delay: d });
    tone({ f0: 80, f1: 30, dur: 1.2, type: 'sine', gain: 0.5, delay: d });
    tone({ f0: 660, f1: 330, dur: 0.6, type: 'square', gain: 0.04, delay: d + 0.2 });
  },
  ping: (d = 0) => {
    tone({ f0: 1200, f1: 1180, dur: 0.9, type: 'sine', gain: 0.18, delay: d });
    tone({ f0: 1200, f1: 1180, dur: 0.6, type: 'sine', gain: 0.06, delay: d + 0.35 });
  },
  contact: (d = 0) => tone({ f0: 1600, dur: 0.06, type: 'square', gain: 0.05, delay: d }),
  charged: () => {
    [440, 660, 880].forEach((f, i) => tone({ f0: f, dur: 0.12, type: 'triangle', gain: 0.15, delay: i * 0.08 }));
  },
  yourTurn: () => tone({ f0: 880, f1: 990, dur: 0.1, type: 'triangle', gain: 0.12 }),
  win: () => [523, 659, 784, 1046].forEach((f, i) => tone({ f0: f, dur: 0.3, type: 'triangle', gain: 0.18, delay: i * 0.14 })),
  lose: () => [392, 330, 262, 196].forEach((f, i) => tone({ f0: f, dur: 0.35, type: 'triangle', gain: 0.18, delay: i * 0.18 })),
};
