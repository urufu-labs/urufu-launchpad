/**
 * Procedural SFX via WebAudio. No asset deps — every sound is synthesized
 * from oscillators + noise routed through gain envelopes.
 *
 * Lazy-inits on first user interaction (browser autoplay policy).
 * Persists opt-in state in localStorage as `urufu-audio`.
 *
 * To play: import { playSfx } from '@/lib/audio/sfx'; playSfx('click')
 *
 * Sounds: click | hover | stamp | coin | flip | pop | trade-buy | trade-sell | error | notif
 *
 * Ported 1:1 from chibi-wolf-game/lib/audio/sfx.ts — same synthesis primitives,
 * different sound palette tuned for a launchpad (buy/sell instead of bleat/growl).
 */

export type SfxName =
  | 'click'
  | 'hover'
  | 'stamp'
  | 'coin'
  | 'flip'
  | 'pop'
  | 'trade-buy'
  | 'trade-sell'
  | 'error'
  | 'notif';

const STORAGE_KEY = 'urufu-audio';
const STORAGE_VOLUME = 'urufu-audio-vol';

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;

function getAudioEnabled(): boolean {
  if (typeof window === 'undefined') return false;
  return window.localStorage.getItem(STORAGE_KEY) === 'on';
}

function getVolume(): number {
  if (typeof window === 'undefined') return 0.4;
  const stored = window.localStorage.getItem(STORAGE_VOLUME);
  if (!stored) return 0.4;
  const n = Number(stored);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.4;
}

export function setAudioEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(STORAGE_KEY, enabled ? 'on' : 'off');
  window.dispatchEvent(new CustomEvent('urufu-audio-toggle'));
  if (enabled) ensureCtx();
}

export function isAudioEnabled(): boolean {
  return getAudioEnabled();
}

export function setVolume(v: number): void {
  if (typeof window === 'undefined') return;
  const clamped = Math.max(0, Math.min(1, v));
  window.localStorage.setItem(STORAGE_VOLUME, String(clamped));
  if (masterGain) masterGain.gain.value = clamped;
}

function ensureCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) {
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  }
  try {
    const Ctx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return null;
    ctx = new Ctx();
    masterGain = ctx.createGain();
    masterGain.gain.value = getVolume();
    masterGain.connect(ctx.destination);
    return ctx;
  } catch {
    return null;
  }
}

function playTone({
  freq,
  type = 'sine',
  duration = 0.1,
  attack = 0.005,
  release = 0.08,
  pitchTo,
  filterFreq,
  delay = 0,
}: {
  freq: number;
  type?: OscillatorType;
  duration?: number;
  attack?: number;
  release?: number;
  pitchTo?: number;
  filterFreq?: number;
  delay?: number;
}) {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const env = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (pitchTo != null) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(1, pitchTo), t0 + duration);
  }

  let dest: AudioNode = env;
  if (filterFreq) {
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = filterFreq;
    dest = filter;
    filter.connect(env);
  }

  osc.connect(dest);
  env.connect(masterGain);

  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(1, t0 + attack);
  env.gain.linearRampToValueAtTime(0.001, t0 + duration + release);
  osc.start(t0);
  osc.stop(t0 + duration + release + 0.05);
}

function playNoise({
  duration = 0.08,
  filterFreq = 2000,
  attack = 0.002,
  release = 0.05,
  delay = 0,
}: {
  duration?: number;
  filterFreq?: number;
  attack?: number;
  release?: number;
  delay?: number;
}) {
  if (!ctx || !masterGain) return;
  const t0 = ctx.currentTime + delay;
  const sampleCount = Math.floor(ctx.sampleRate * (duration + release + 0.05));
  const buffer = ctx.createBuffer(1, sampleCount, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / sampleCount);
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = filterFreq;

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t0);
  env.gain.linearRampToValueAtTime(0.7, t0 + attack);
  env.gain.linearRampToValueAtTime(0.001, t0 + duration + release);

  src.connect(filter);
  filter.connect(env);
  env.connect(masterGain);
  src.start(t0);
  src.stop(t0 + duration + release + 0.05);
}

export function playSfx(name: SfxName): void {
  if (!getAudioEnabled()) return;
  const c = ensureCtx();
  if (!c) return;

  switch (name) {
    case 'click':
      playTone({ freq: 880, type: 'square', duration: 0.04, release: 0.04, attack: 0.001 });
      break;

    case 'hover':
      playTone({ freq: 1320, type: 'sine', duration: 0.04, release: 0.05, attack: 0.001 });
      break;

    case 'stamp':
      // Heavy CTA thud
      playNoise({ duration: 0.05, filterFreq: 600, attack: 0.001, release: 0.06 });
      playTone({ freq: 220, type: 'sine', duration: 0.02, release: 0.07, attack: 0.001, pitchTo: 80 });
      break;

    case 'coin':
      // Ascending two-note arpeggio — good for launched-successfully / receipt-success
      playTone({ freq: 880, type: 'square', duration: 0.06, release: 0.06, attack: 0.001 });
      playTone({ freq: 1320, type: 'square', duration: 0.08, release: 0.08, attack: 0.001, delay: 0.07 });
      break;

    case 'flip':
      // Polaroid flip / swoosh — for tape-based UI and secondary toggles
      playNoise({ duration: 0.14, filterFreq: 3000, attack: 0.01, release: 0.08 });
      break;

    case 'pop':
      // Short pop — good for chip picks, small UI reactions
      playTone({ freq: 700, type: 'triangle', duration: 0.05, release: 0.06, attack: 0.001, pitchTo: 900 });
      break;

    case 'trade-buy':
      // Rising major-third arpeggio + light noise brush — feels like accumulating value
      playTone({ freq: 523, type: 'square', duration: 0.06, release: 0.08, attack: 0.001 });
      playTone({ freq: 659, type: 'square', duration: 0.07, release: 0.09, attack: 0.001, delay: 0.05 });
      playTone({ freq: 784, type: 'square', duration: 0.08, release: 0.1, attack: 0.001, delay: 0.1 });
      playNoise({ duration: 0.06, filterFreq: 4200, attack: 0.001, release: 0.06, delay: 0.04 });
      break;

    case 'trade-sell':
      // Descending arpeggio — inverse energy
      playTone({ freq: 784, type: 'triangle', duration: 0.06, release: 0.08, attack: 0.001 });
      playTone({ freq: 659, type: 'triangle', duration: 0.07, release: 0.09, attack: 0.001, delay: 0.05 });
      playTone({ freq: 523, type: 'triangle', duration: 0.08, release: 0.1, attack: 0.001, delay: 0.1 });
      break;

    case 'error':
      // Two low buzzes
      playTone({ freq: 220, type: 'sawtooth', duration: 0.06, release: 0.06, attack: 0.001, filterFreq: 800 });
      playTone({ freq: 165, type: 'sawtooth', duration: 0.08, release: 0.08, attack: 0.001, filterFreq: 700, delay: 0.08 });
      break;

    case 'notif':
      // Two-note friendly chime — chat msg / new trade appearing
      playTone({ freq: 988, type: 'sine', duration: 0.05, release: 0.09, attack: 0.001 });
      playTone({ freq: 1319, type: 'sine', duration: 0.06, release: 0.1, attack: 0.001, delay: 0.05 });
      break;
  }
}
