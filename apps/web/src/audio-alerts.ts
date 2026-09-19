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
  private sirenAudio: HTMLAudioElement | null = null;
  private sampleAudio: HTMLAudioElement | null = null;
  private sampleStopTimer: number | null = null;

  private getContext(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AudioCtx();
    }
    if (this.ctx.state === 'suspended') {
      void this.ctx.resume();
    }
    return this.ctx;
  }

  private stopSampleAudio(): void {
    if (this.sampleStopTimer !== null) {
      clearTimeout(this.sampleStopTimer);
      this.sampleStopTimer = null;
    }
    if (this.sampleAudio) {
      try {
        this.sampleAudio.pause();
        this.sampleAudio.currentTime = 0;
      } catch {
        // Ignore pause issues
      }
      this.sampleAudio = null;
    }
  }

  playChime(soundType: AlertSoundType = 'siren', volume = 0.8): void {
    const clampedVolume = Math.max(0.01, Math.min(1, volume));

    if (soundType === 'siren') {
      this.stopSampleAudio();
      try {
        if (typeof Audio !== 'undefined') {
          const audio = new Audio('/siren-alert.mp3');
          audio.volume = clampedVolume;
          this.sampleAudio = audio;
          const playPromise = audio.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              // Browser autoplay policy or missing audio file fallback
              this.playSynthesizedChime('pulse', clampedVolume);
            });
          }
          // Sample plays for 4.5 seconds for a clear, crisp preview
          this.sampleStopTimer = window.setTimeout(() => {
            this.stopSampleAudio();
          }, 4500);
          return;
        }
      } catch {
        // Fallback to Web Audio synthesis if HTML Audio throws
      }
    }

    this.playSynthesizedChime(soundType === 'siren' ? 'pulse' : soundType, clampedVolume);
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
    if (this.isLooping) return;
    this.isLooping = true;
    const clampedVolume = Math.max(0.01, Math.min(1, volume));

    if (soundType === 'siren') {
      this.stopSampleAudio();
      try {
        if (typeof Audio !== 'undefined') {
          const audio = new Audio('/siren-alert.mp3');
          audio.volume = clampedVolume;
          audio.loop = true;
          this.sirenAudio = audio;
          const playPromise = audio.play();
          if (playPromise !== undefined) {
            playPromise.catch(() => {
              // Fallback to synthesized repeating chime if autoplay restricted or failed
              this.playSynthesizedChime('pulse', clampedVolume);
              this.loopTimer = window.setInterval(() => {
                if (this.isLooping) {
                  this.playSynthesizedChime('pulse', clampedVolume);
                }
              }, Math.max(1000, intervalMs));
            });
          }
          return;
        }
      } catch {
        // Fallback to loop timer
      }
    }

    this.playSynthesizedChime(soundType === 'siren' ? 'pulse' : soundType, clampedVolume);
    this.loopTimer = window.setInterval(() => {
      if (this.isLooping) {
        this.playSynthesizedChime(soundType === 'siren' ? 'pulse' : soundType, clampedVolume);
      }
    }, Math.max(1000, intervalMs));
  }

  stopAlertLoop(): void {
    this.isLooping = false;
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    if (this.sirenAudio) {
      try {
        this.sirenAudio.pause();
        this.sirenAudio.currentTime = 0;
      } catch {
        // Ignore
      }
      this.sirenAudio = null;
    }
    this.stopSampleAudio();
  }

  isPlaying(): boolean {
    return this.isLooping;
  }
}

export const alertSound = new AlertSoundEngine();

