// Web Audio API Synthesizer and Audio Alert Engine.
// Supports both high-fidelity MP3 siren audio (/siren-alert.mp3) and polyphonic Web Audio API synthesis.

export type AlertSoundType = 'siren' | 'harmonic' | 'bell' | 'pulse';

export interface CoinAlertRule {
  readonly coin: string;
  readonly downThresholdPct?: number | null;
  readonly upThresholdPct?: number | null;
  readonly targetPriceBelow?: number | null;
  readonly targetPriceAbove?: number | null;
}

export interface PositionAlertConfig {
  readonly enabled: boolean;
  readonly downAlertEnabled: boolean;
  readonly downThresholdPct: number;
  readonly upAlertEnabled: boolean;
  readonly upThresholdPct: number;
  readonly soundType: AlertSoundType;
  readonly volume: number;
  readonly repeatIntervalSeconds: number;
  readonly coinScope: 'all' | 'specific';
  readonly specificCoins: readonly string[];
  readonly coinRules?: Record<string, CoinAlertRule>;
}

export const DEFAULT_POSITION_ALERT_CONFIG: PositionAlertConfig = {
  enabled: true,
  downAlertEnabled: true,
  downThresholdPct: 5,
  upAlertEnabled: true,
  upThresholdPct: 10,
  soundType: 'siren',
  volume: 0.8,
  repeatIntervalSeconds: 3,
  coinScope: 'all',
  specificCoins: [],
  coinRules: {},
};

const STORAGE_KEY = 'tradex_position_alerts_config';

export function loadPositionAlertConfig(): PositionAlertConfig {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_POSITION_ALERT_CONFIG;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_POSITION_ALERT_CONFIG;
    const parsed = JSON.parse(raw) as Partial<PositionAlertConfig>;

    const coinScope: 'all' | 'specific' = parsed.coinScope === 'specific' ? 'specific' : 'all';
    const specificCoins: string[] = Array.isArray(parsed.specificCoins)
      ? Array.from(
          new Set(
            parsed.specificCoins
              .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
              .map((c) => c.trim().toUpperCase())
          )
        )
      : [];

    const coinRules: Record<string, CoinAlertRule> = {};
    if (parsed.coinRules && typeof parsed.coinRules === 'object') {
      for (const [k, r] of Object.entries(parsed.coinRules)) {
        if (r && typeof r === 'object') {
          const coin = k.trim().toUpperCase();
          coinRules[coin] = {
            coin,
            downThresholdPct: typeof r.downThresholdPct === 'number' && Number.isFinite(r.downThresholdPct) && r.downThresholdPct > 0 ? r.downThresholdPct : null,
            upThresholdPct: typeof r.upThresholdPct === 'number' && Number.isFinite(r.upThresholdPct) && r.upThresholdPct > 0 ? r.upThresholdPct : null,
            targetPriceBelow: typeof r.targetPriceBelow === 'number' && Number.isFinite(r.targetPriceBelow) && r.targetPriceBelow > 0 ? r.targetPriceBelow : null,
            targetPriceAbove: typeof r.targetPriceAbove === 'number' && Number.isFinite(r.targetPriceAbove) && r.targetPriceAbove > 0 ? r.targetPriceAbove : null,
          };
        }
      }
    }

    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_POSITION_ALERT_CONFIG.enabled,
      downAlertEnabled: typeof parsed.downAlertEnabled === 'boolean' ? parsed.downAlertEnabled : DEFAULT_POSITION_ALERT_CONFIG.downAlertEnabled,
      downThresholdPct: typeof parsed.downThresholdPct === 'number' && Number.isFinite(parsed.downThresholdPct) && parsed.downThresholdPct > 0 ? parsed.downThresholdPct : DEFAULT_POSITION_ALERT_CONFIG.downThresholdPct,
      upAlertEnabled: typeof parsed.upAlertEnabled === 'boolean' ? parsed.upAlertEnabled : DEFAULT_POSITION_ALERT_CONFIG.upAlertEnabled,
      upThresholdPct: typeof parsed.upThresholdPct === 'number' && Number.isFinite(parsed.upThresholdPct) && parsed.upThresholdPct > 0 ? parsed.upThresholdPct : DEFAULT_POSITION_ALERT_CONFIG.upThresholdPct,
      soundType: parsed.soundType === 'siren' || parsed.soundType === 'bell' || parsed.soundType === 'pulse' || parsed.soundType === 'harmonic' ? parsed.soundType : DEFAULT_POSITION_ALERT_CONFIG.soundType,
      volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : DEFAULT_POSITION_ALERT_CONFIG.volume,
      repeatIntervalSeconds: typeof parsed.repeatIntervalSeconds === 'number' && Number.isFinite(parsed.repeatIntervalSeconds) && parsed.repeatIntervalSeconds >= 1 ? parsed.repeatIntervalSeconds : DEFAULT_POSITION_ALERT_CONFIG.repeatIntervalSeconds,
      coinScope,
      specificCoins,
      coinRules,
    };
  } catch {
    return DEFAULT_POSITION_ALERT_CONFIG;
  }
}

export function savePositionAlertConfig(config: PositionAlertConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
    window.dispatchEvent(new CustomEvent('tradex-alert-config-changed', { detail: config }));
  } catch {
    // Storage quota or disabled
  }
}

class AlertSoundEngine {
  private ctx: AudioContext | null = null;
  private isLooping = false;
  private loopTimer: number | null = null;
  private currentVolume = 0.8;
  private currentSoundType: AlertSoundType = 'siren';

  // HTML5 audio element for siren
  private sirenAudio: HTMLAudioElement | null = null;
  private sampleStopTimer: number | null = null;

  // Web Audio decoded buffer for instant, bulletproof playback
  private sirenBuffer: AudioBuffer | null = null;
  private bufferPromise: Promise<AudioBuffer | null> | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private unlockListenerBound = false;
  private activeUnlockHandler: ((e: Event) => void) | null = null;

  constructor() {
    if (typeof window !== 'undefined') {
      // Pre-warm the HTML5 audio element so it is cached and ready
      this.getSirenAudio();
      // Pre-load and decode the MP3 into an AudioBuffer in memory
      void this.ensureSirenBufferLoaded();
      // Bind click/touch unlock listener so autoplay policy never blocks
      this.bindAutoplayUnlock();
    }
  }

  private getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  private bindAutoplayUnlock(): void {
    if (this.unlockListenerBound || typeof window === 'undefined') return;
    this.unlockListenerBound = true;

    const unlock = (e: Event) => {
      // If user clicked stop or dismiss buttons, do not force-start audio
      const target = e.target as HTMLElement | null;
      if (target && target.closest && target.closest('.alert-stop-sound-btn, .alert-dismiss-btn')) {
        return;
      }

      // Immediately unbind so subsequent events in this gesture cannot interfere
      this.unbindAutoplayUnlock();

      // Resume AudioContext within user gesture
      if (this.ctx && this.ctx.state === 'suspended') {
        void this.ctx.resume().then(() => {
          if (this.isLooping && !this.isSirenPlaying()) {
            this.playActiveAlert();
          }
        }).catch(() => {});
      }

      // Play active alert immediately inside this direct user gesture
      if (this.isLooping) {
        this.playActiveAlert();
      }
    };

    this.activeUnlockHandler = unlock;

    window.addEventListener('pointerdown', unlock, { capture: true });
    window.addEventListener('keydown', unlock, { capture: true });
  }

  private unbindAutoplayUnlock(): void {
    if (!this.unlockListenerBound || typeof window === 'undefined') return;
    if (this.activeUnlockHandler) {
      window.removeEventListener('pointerdown', this.activeUnlockHandler, true);
      window.removeEventListener('keydown', this.activeUnlockHandler, true);
      this.activeUnlockHandler = null;
    }
    this.unlockListenerBound = false;
  }

  private getSirenAudio(): HTMLAudioElement {
    if (!this.sirenAudio && typeof Audio !== 'undefined') {
      this.sirenAudio = new Audio('/siren-alert.mp3');
      this.sirenAudio.preload = 'auto';
      this.sirenAudio.load();
    }
    return this.sirenAudio!;
  }

  private ensureSirenBufferLoaded(): Promise<AudioBuffer | null> {
    if (this.sirenBuffer) return Promise.resolve(this.sirenBuffer);
    if (typeof window === 'undefined') return Promise.resolve(null);
    if (this.bufferPromise) return this.bufferPromise;

    this.bufferPromise = (async () => {
      try {
        const res = await fetch('/siren-alert.mp3');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const arrayBuf = await res.arrayBuffer();
        const ctx = this.getContext();
        const decoded = await ctx.decodeAudioData(arrayBuf);
        this.sirenBuffer = decoded;

        // If an ongoing alert was triggered while the buffer was fetching, start playing immediately
        if (this.isLooping && this.currentSoundType === 'siren' && !this.isSirenPlaying()) {
          this.playSirenAudio(this.currentVolume, true);
        }
        return decoded;
      } catch {
        return null;
      } finally {
        this.bufferPromise = null;
      }
    })();

    return this.bufferPromise;
  }

  private isSirenPlaying(): boolean {
    // Web Audio buffer source: must have active source AND running context
    if (this.activeSource && this.ctx && this.ctx.state === 'running') {
      return true;
    }
    // HTMLAudioElement: must not be paused and must have played
    if (this.sirenAudio && !this.sirenAudio.paused && this.sirenAudio.currentTime > 0) {
      return true;
    }
    return false;
  }

  private notifySoundStateChanged(): void {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('tradex-alert-sound-state'));
    }
  }

  private playSirenAudio(volume: number, loop: boolean): void {
    const clampedVolume = Math.max(0.01, Math.min(1, volume));

    // If already actively producing sound via Web Audio, do not interrupt
    if (this.activeSource && this.ctx && this.ctx.state === 'running') {
      return;
    }

    const ctx = this.getContext();

    // 1. Web Audio Buffer playback if buffer is decoded
    if (this.sirenBuffer) {
      if (ctx.state === 'running') {
        try {
          // Pause HTMLAudio fallback if active
          if (this.sirenAudio && !this.sirenAudio.paused) {
            try {
              this.sirenAudio.pause();
              this.sirenAudio.currentTime = 0;
            } catch {
              // Ignore
            }
          }

          // Stop any previous active source
          if (this.activeSource) {
            try {
              this.activeSource.stop();
              this.activeSource.disconnect();
            } catch {
              // Ignore
            }
            this.activeSource = null;
          }

          const source = ctx.createBufferSource();
          source.buffer = this.sirenBuffer;
          source.loop = loop;

          const gainNode = ctx.createGain();
          gainNode.gain.setValueAtTime(clampedVolume, ctx.currentTime);
          source.connect(gainNode);
          gainNode.connect(ctx.destination);

          source.start(0);
          this.activeSource = source;

          source.onended = () => {
            if (this.activeSource === source) {
              this.activeSource = null;
              this.notifySoundStateChanged();
            }
          };
          this.notifySoundStateChanged();
          return;
        } catch {
          // Fall through to HTMLAudioElement below
        }
      } else {
        // AudioContext is suspended: schedule resume and bind unlock listener
        void ctx.resume().then(() => {
          if (this.isLooping && this.currentSoundType === 'siren' && !this.isSirenPlaying()) {
            this.playSirenAudio(clampedVolume, loop);
          }
        }).catch(() => {});
        this.bindAutoplayUnlock();
        return;
      }
    } else {
      // Buffer not loaded yet: queue playback as soon as buffer finishes decoding
      void this.ensureSirenBufferLoaded().then((buf) => {
        if (buf && this.isLooping && this.currentSoundType === 'siren' && !this.isSirenPlaying()) {
          this.playSirenAudio(clampedVolume, loop);
        }
      });
    }

    // 2. HTMLAudioElement playback (fallback ONLY if buffer failed or while buffer is decoding)
    try {
      const audio = this.getSirenAudio();
      audio.volume = clampedVolume;
      audio.loop = loop;
      if (audio.paused) {
        audio.currentTime = 0;
        const promise = audio.play();
        if (promise !== undefined) {
          promise.then(() => {
            this.notifySoundStateChanged();
          }).catch(() => {
            this.bindAutoplayUnlock();
          });
        }
      }
    } catch {
      this.bindAutoplayUnlock();
    }
  }

  private stopSirenAudio(): void {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
        this.activeSource.disconnect();
      } catch {
        // Ignore
      }
      this.activeSource = null;
    }
    if (this.sirenAudio) {
      try {
        this.sirenAudio.pause();
        this.sirenAudio.currentTime = 0;
      } catch {
        // Ignore
      }
    }
    if (this.sampleStopTimer !== null) {
      clearTimeout(this.sampleStopTimer);
      this.sampleStopTimer = null;
    }
    this.notifySoundStateChanged();
  }

  playChime(soundType: AlertSoundType = 'siren', volume = 0.8): void {
    const clampedVolume = Math.max(0.01, Math.min(1, volume));
    this.stopSirenAudio();

    if (soundType === 'siren') {
      this.playSirenAudio(clampedVolume, false);
      // Stop sample after 4.5 seconds
      this.sampleStopTimer = window.setTimeout(() => {
        this.stopSirenAudio();
      }, 4500);
      return;
    }

    this.playSynthesizedChime(soundType, clampedVolume);
  }

  private playSynthesizedChime(soundType: 'harmonic' | 'bell' | 'pulse', volume: number): void {
    try {
      const ctx = this.getContext();
      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(volume, now);
      masterGain.connect(ctx.destination);

      if (soundType === 'harmonic') {
        // Melodic 3-tone chime: D5 (587.33Hz) -> A5 (880Hz) -> D6 (1174.66Hz)
        const notes = [
          { freq: 587.33, time: 0, duration: 0.75 },
          { freq: 880.0, time: 0.12, duration: 0.85 },
          { freq: 1174.66, time: 0.24, duration: 1.15 },
        ];
        for (const n of notes) {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(n.freq, now + n.time);

          noteGain.gain.setValueAtTime(0.0001, now + n.time);
          noteGain.gain.exponentialRampToValueAtTime(0.35, now + n.time + 0.02);
          noteGain.gain.exponentialRampToValueAtTime(0.0001, now + n.time + n.duration);

          osc.connect(noteGain);
          noteGain.connect(masterGain);

          osc.start(now + n.time);
          osc.stop(now + n.time + n.duration);
        }
      } else if (soundType === 'bell') {
        // Crystal bell chime (F5 698.46Hz + C6 1046.5Hz + F6 1396.91Hz)
        const frequencies = [698.46, 1046.5, 1396.91];
        frequencies.forEach((freq, idx) => {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          osc.type = idx === 0 ? 'sine' : 'triangle';
          osc.frequency.setValueAtTime(freq, now);

          noteGain.gain.setValueAtTime(0.0001, now);
          noteGain.gain.exponentialRampToValueAtTime(0.3 / (idx + 1), now + 0.015);
          noteGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

          osc.connect(noteGain);
          noteGain.connect(masterGain);

          osc.start(now);
          osc.stop(now + 1.2);
        });
      } else {
        // Pulse tone: Modern dual rhythmic alert
        [0, 0.16].forEach((offset) => {
          const osc = ctx.createOscillator();
          const noteGain = ctx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(987.77, now + offset);

          noteGain.gain.setValueAtTime(0.0001, now + offset);
          noteGain.gain.exponentialRampToValueAtTime(0.38, now + offset + 0.01);
          noteGain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.13);

          osc.connect(noteGain);
          noteGain.connect(masterGain);

          osc.start(now + offset);
          osc.stop(now + offset + 0.14);
        });
      }
    } catch {
      // Audio context may be restricted before first user interaction
    }
  }

  startAlertLoop(soundType: AlertSoundType, volume: number, intervalMs = 3000): void {
    this.currentSoundType = soundType;
    this.currentVolume = volume;
    const clampedVolume = Math.max(0.01, Math.min(1, volume));

    if (soundType === 'siren') {
      this.isLooping = true;
      if (!this.isSirenPlaying()) {
        this.playSirenAudio(clampedVolume, true);
      }
      return;
    }

    if (this.isLooping) return;
    this.isLooping = true;

    // Synthesized chime loops for harmonic / bell / pulse
    this.playSynthesizedChime(soundType, clampedVolume);
    this.loopTimer = window.setInterval(() => {
      if (this.isLooping) {
        this.playSynthesizedChime(soundType, clampedVolume);
      }
    }, Math.max(1000, intervalMs));
  }

  stopAlertLoop(): void {
    this.isLooping = false;
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    this.stopSirenAudio();
    this.unbindAutoplayUnlock();
  }

  playActiveAlert(): void {
    if (!this.isLooping) return;
    if (this.currentSoundType === 'siren') {
      if (this.isSirenPlaying()) return;
      this.playSirenAudio(this.currentVolume, true);
    } else {
      this.playSynthesizedChime(this.currentSoundType, this.currentVolume);
    }
  }

  unlockAndPlay(): void {
    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }
    if (this.isLooping && !this.isSirenPlaying()) {
      this.playActiveAlert();
    }
  }

  isPlaying(): boolean {
    return this.isLooping;
  }

  isActivelySounding(): boolean {
    if (!this.isLooping) return false;
    if (this.currentSoundType === 'siren') {
      return this.isSirenPlaying();
    }
    return this.ctx !== null && this.ctx.state === 'running';
  }
}

export const alertSound = new AlertSoundEngine();

