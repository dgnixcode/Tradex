// Web Audio API Synthesizer and Persistent Position Movement Alerts Configuration.
// Synthesizes pleasant, rich, polyphonic audio tones without any external audio files.

export type AlertSoundType = 'harmonic' | 'bell' | 'pulse';

export interface PositionAlertConfig {
  readonly enabled: boolean;
  readonly downAlertEnabled: boolean;
  readonly downThresholdPct: number;
  readonly upAlertEnabled: boolean;
  readonly upThresholdPct: number;
  readonly soundType: AlertSoundType;
  readonly volume: number;
  readonly repeatIntervalSeconds: number;
}

export const DEFAULT_POSITION_ALERT_CONFIG: PositionAlertConfig = {
  enabled: true,
  downAlertEnabled: true,
  downThresholdPct: 5,
  upAlertEnabled: true,
  upThresholdPct: 10,
  soundType: 'harmonic',
  volume: 0.8,
  repeatIntervalSeconds: 3,
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
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULT_POSITION_ALERT_CONFIG.enabled,
      downAlertEnabled: typeof parsed.downAlertEnabled === 'boolean' ? parsed.downAlertEnabled : DEFAULT_POSITION_ALERT_CONFIG.downAlertEnabled,
      downThresholdPct: typeof parsed.downThresholdPct === 'number' && Number.isFinite(parsed.downThresholdPct) && parsed.downThresholdPct > 0 ? parsed.downThresholdPct : DEFAULT_POSITION_ALERT_CONFIG.downThresholdPct,
      upAlertEnabled: typeof parsed.upAlertEnabled === 'boolean' ? parsed.upAlertEnabled : DEFAULT_POSITION_ALERT_CONFIG.upAlertEnabled,
      upThresholdPct: typeof parsed.upThresholdPct === 'number' && Number.isFinite(parsed.upThresholdPct) && parsed.upThresholdPct > 0 ? parsed.upThresholdPct : DEFAULT_POSITION_ALERT_CONFIG.upThresholdPct,
      soundType: parsed.soundType === 'bell' || parsed.soundType === 'pulse' || parsed.soundType === 'harmonic' ? parsed.soundType : DEFAULT_POSITION_ALERT_CONFIG.soundType,
      volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) ? Math.max(0, Math.min(1, parsed.volume)) : DEFAULT_POSITION_ALERT_CONFIG.volume,
      repeatIntervalSeconds: typeof parsed.repeatIntervalSeconds === 'number' && Number.isFinite(parsed.repeatIntervalSeconds) && parsed.repeatIntervalSeconds >= 1 ? parsed.repeatIntervalSeconds : DEFAULT_POSITION_ALERT_CONFIG.repeatIntervalSeconds,
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

  playChime(soundType: AlertSoundType = 'harmonic', volume = 0.8): void {
    try {
      const ctx = this.getContext();
      const now = ctx.currentTime;
      const masterGain = ctx.createGain();
      masterGain.gain.setValueAtTime(Math.max(0.01, Math.min(1, volume)), now);
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
    this.playChime(soundType, volume);
    this.loopTimer = window.setInterval(() => {
      if (this.isLooping) {
        this.playChime(soundType, volume);
      }
    }, Math.max(1000, intervalMs));
  }

  stopAlertLoop(): void {
    this.isLooping = false;
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
  }

  isPlaying(): boolean {
    return this.isLooping;
  }
}

export const alertSound = new AlertSoundEngine();
