// Voice-note recording as OGG/Opus (what Telegram needs for real voice
// messages). Safari/iOS can't produce Opus via MediaRecorder, so we encode
// in a WASM worker (opus-recorder). Also builds Telegram's 5-bit waveform.
import Recorder from "opus-recorder";
import encoderPath from "opus-recorder/dist/encoderWorker.min.js?url";

export interface VoiceResult {
  blob: Blob;
  duration: number; // seconds
  waveform: Uint8Array; // Telegram packed 5-bit, 100 samples
}

export class VoiceRecorder {
  private rec: Recorder | null = null;
  private chunks: ArrayBuffer[] = [];
  private started = 0;
  private levels: number[] = [];
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private raf = 0;
  onLevel?: (level: number) => void; // 0..1 for a live meter

  static supported(): boolean {
    return !!navigator.mediaDevices?.getUserMedia && typeof WebAssembly === "object";
  }

  async start(): Promise<void> {
    this.chunks = [];
    this.levels = [];
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.ctx = new AudioContext();
    const source = this.ctx.createMediaStreamSource(this.stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      const level = Math.min(1, peak / 64);
      this.levels.push(level);
      this.onLevel?.(level);
      this.raf = requestAnimationFrame(tick);
    };
    tick();

    this.rec = new Recorder({
      encoderPath,
      encoderApplication: 2048, // voice
      encoderSampleRate: 48000,
      numberOfChannels: 1,
      sourceNode: source,
    });
    this.rec.ondataavailable = (data) => this.chunks.push(data);
    await this.rec.start();
    this.started = performance.now();
  }

  get elapsed(): number {
    return this.started ? (performance.now() - this.started) / 1000 : 0;
  }

  async stop(): Promise<VoiceResult> {
    const duration = Math.max(1, Math.round(this.elapsed));
    const done = new Promise<void>((r) => {
      if (this.rec) this.rec.onstop = () => r();
      else r();
    });
    await this.rec?.stop();
    await done;
    this.cleanup();
    return {
      blob: new Blob(this.chunks, { type: "audio/ogg" }),
      duration,
      waveform: packWaveform(this.levels),
    };
  }

  cancel(): void {
    try {
      void this.rec?.stop();
    } catch {
      /* ignore */
    }
    this.cleanup();
  }

  private cleanup() {
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.stream = null;
    this.ctx = null;
    this.rec = null;
    this.started = 0;
  }
}

/** Telegram waveform: 100 values of 5 bits (0..31), packed little-endian. */
export function packWaveform(levels: number[]): Uint8Array {
  const N = 100;
  const vals: number[] = [];
  for (let i = 0; i < N; i++) {
    const a = Math.floor((i * levels.length) / N);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / N));
    let peak = 0;
    for (let j = a; j < b && j < levels.length; j++) peak = Math.max(peak, levels[j]);
    vals.push(Math.round(peak * 31));
  }
  const out = new Uint8Array(Math.ceil((N * 5) / 8));
  vals.forEach((v, i) => {
    const bit = i * 5;
    const byte = bit >> 3;
    const shift = bit & 7;
    out[byte] |= (v << shift) & 0xff;
    if (shift > 3) out[byte + 1] |= v >> (8 - shift);
  });
  return out;
}
