// SF 감청 단말 절차적 Web Audio 효과음 모듈 (외부 오디오 에셋 없음).
// 첫 사용자 제스처에서 AudioContext를 지연 생성하고, 음소거 상태를 localStorage에 저장한다.

const MUTE_KEY = "crispy-octo-umbrella/muted";

let ctx = null;
let noiseBuf = null;
let muted = false;
try {
  muted = localStorage.getItem(MUTE_KEY) === "1";
} catch {
  muted = false;
}

function ensureCtx() {
  if (muted) return null;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  if (!ctx) ctx = new AC();
  if (ctx.state === "suspended") {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function getNoiseBuffer(ac) {
  if (noiseBuf && noiseBuf.sampleRate === ac.sampleRate) return noiseBuf;
  const len = Math.floor(ac.sampleRate * 0.45);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuf = buf;
  return buf;
}

function tone(freq, dur, { type = "triangle", gain = 0.08, endFreq = null, delay = 0, attack = 0.005 } = {}) {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const g = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq !== null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + dur);
  }
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur, { gain = 0.09, freq = 1400, q = 1.2, filter = "bandpass", delay = 0 } = {}) {
  const ac = ensureCtx();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const src = ac.createBufferSource();
  src.buffer = getNoiseBuffer(ac);
  const filt = ac.createBiquadFilter();
  filt.type = filter;
  filt.frequency.setValueAtTime(freq, t0);
  filt.Q.setValueAtTime(q, t0);
  const g = ac.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filt);
  filt.connect(g);
  g.connect(ac.destination);
  src.start(t0);
  src.stop(t0 + dur + 0.02);
}

export const sfx = {
  isMuted: () => muted,
  setMuted(v) {
    muted = !!v;
    try {
      localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
    } catch {}
  },
  toggleMute() {
    this.setMuted(!muted);
    if (!muted) this.uiClick();
    return muted;
  },

  uiClick() {
    tone(680, 0.045, { type: "square", gain: 0.035, endFreq: 520 });
  },
  select() {
    tone(520, 0.05, { type: "triangle", gain: 0.055, endFreq: 740 });
  },
  lock() {
    tone(880, 0.045, { type: "square", gain: 0.04 });
    tone(1180, 0.06, { type: "square", gain: 0.04, delay: 0.04 });
  },
  invalid() {
    tone(180, 0.09, { type: "sawtooth", gain: 0.055, endFreq: 115 });
    tone(140, 0.09, { type: "sawtooth", gain: 0.05, delay: 0.06, endFreq: 95 });
  },
  step(empire = false) {
    tone(empire ? 170 : 230, 0.035, { type: "triangle", gain: 0.03, endFreq: 95 });
  },
  shot(slow = false) {
    const dur = slow ? 0.16 : 0.09;
    noise(dur, { gain: 0.11, freq: slow ? 950 : 1850, q: 0.8, filter: "highpass" });
    tone(slow ? 260 : 420, dur, { type: "sawtooth", gain: 0.065, endFreq: 85 });
  },
  hit(crit = false) {
    if (crit) {
      noise(0.18, { gain: 0.14, freq: 720, q: 0.9, filter: "lowpass" });
      tone(220, 0.16, { type: "sawtooth", gain: 0.11, endFreq: 58 });
      tone(920, 0.12, { type: "square", gain: 0.055, endFreq: 1320, delay: 0.02 });
    } else {
      noise(0.11, { gain: 0.1, freq: 900, q: 1.0, filter: "bandpass" });
      tone(190, 0.1, { type: "triangle", gain: 0.085, endFreq: 70 });
    }
  },
  miss() {
    tone(1450, 0.09, { type: "sine", gain: 0.045, endFreq: 420 });
  },
  kill() {
    noise(0.24, { gain: 0.14, freq: 520, q: 0.7, filter: "lowpass" });
    tone(150, 0.24, { type: "sawtooth", gain: 0.1, endFreq: 42 });
    tone(310, 0.11, { type: "square", gain: 0.04, endFreq: 180, delay: 0.05 });
  },
  grenade() {
    tone(380, 0.09, { type: "triangle", gain: 0.05, endFreq: 210 });
    noise(0.36, { gain: 0.17, freq: 420, q: 0.6, filter: "lowpass", delay: 0.08 });
    tone(125, 0.32, { type: "sawtooth", gain: 0.12, endFreq: 34, delay: 0.08 });
    noise(0.2, { gain: 0.08, freq: 2400, q: 1.4, filter: "bandpass", delay: 0.12 });
  },
  overwatchSet() {
    tone(540, 0.06, { type: "triangle", gain: 0.055 });
    tone(810, 0.09, { type: "triangle", gain: 0.055, delay: 0.055 });
  },
  overwatchTrigger() {
    // 슬로모 저음 드롭 + 감청 레이더 핑
    tone(210, 0.36, { type: "sawtooth", gain: 0.09, endFreq: 52 });
    tone(1240, 0.12, { type: "square", gain: 0.05, delay: 0.05 });
    tone(1640, 0.14, { type: "sine", gain: 0.055, delay: 0.15 });
  },
  hunker() {
    tone(260, 0.08, { type: "triangle", gain: 0.07, endFreq: 165 });
    tone(390, 0.09, { type: "sine", gain: 0.055, delay: 0.04, endFreq: 280 });
  },
  burrow() {
    noise(0.16, { gain: 0.08, freq: 520, q: 1.2, filter: "lowpass" });
    tone(190, 0.14, { type: "triangle", gain: 0.06, endFreq: 85 });
  },
  smoke() {
    noise(0.28, { gain: 0.075, freq: 1800, q: 0.7, filter: "bandpass" });
  },
  mark() {
    tone(980, 0.06, { type: "sine", gain: 0.055 });
    tone(1480, 0.12, { type: "sine", gain: 0.06, delay: 0.055 });
  },
  suppress() {
    for (let i = 0; i < 3; i++) {
      noise(0.06, { gain: 0.08, freq: 1400, q: 0.9, filter: "highpass", delay: i * 0.055 });
      tone(290, 0.05, { type: "sawtooth", gain: 0.05, endFreq: 120, delay: i * 0.055 });
    }
  },
  regen() {
    tone(440, 0.08, { type: "sine", gain: 0.055 });
    tone(660, 0.09, { type: "sine", gain: 0.06, delay: 0.06 });
    tone(880, 0.13, { type: "sine", gain: 0.055, delay: 0.12 });
  },
  retreat() {
    tone(620, 0.07, { type: "triangle", gain: 0.05, endFreq: 420 });
    tone(420, 0.1, { type: "triangle", gain: 0.05, delay: 0.06, endFreq: 280 });
  },
  turnEnd() {
    tone(420, 0.06, { type: "triangle", gain: 0.045, endFreq: 310 });
  },
  dayTick() {
    tone(520, 0.03, { type: "sine", gain: 0.025 });
  },
  clashAlert() {
    tone(740, 0.11, { type: "square", gain: 0.065 });
    tone(560, 0.11, { type: "square", gain: 0.065, delay: 0.12 });
    tone(880, 0.16, { type: "square", gain: 0.07, delay: 0.24 });
  },
  victory() {
    tone(440, 0.11, { type: "triangle", gain: 0.07 });
    tone(554, 0.11, { type: "triangle", gain: 0.07, delay: 0.1 });
    tone(659, 0.12, { type: "triangle", gain: 0.075, delay: 0.2 });
    tone(880, 0.28, { type: "triangle", gain: 0.08, delay: 0.31 });
  },
  defeat() {
    tone(330, 0.16, { type: "sawtooth", gain: 0.065, endFreq: 290 });
    tone(262, 0.18, { type: "sawtooth", gain: 0.065, delay: 0.15, endFreq: 220 });
    tone(196, 0.34, { type: "sawtooth", gain: 0.07, delay: 0.32, endFreq: 146 });
  },
};
