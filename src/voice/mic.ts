// voice/mic.ts - microphone frames at 16 kHz.
//
// An AudioWorklet (loaded from a blob, no extra file) downsamples the mic from
// the device rate to 16 kHz and cuts it into 30 ms frames for the VAD. Echo
// cancellation keeps the agent's own voice out.

const FRAME = 480; // 30 ms at 16 kHz

const WORKLET = `
class FrameTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.n = 0;
    // Downsample from the device rate to 16 kHz by averaging each step's input.
    this.step = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i];
        this.count++;
        this.pos += 1;
        if (this.pos >= this.step) {
          this.pos -= this.step;
          this.buf[this.n++] = this.acc / this.count;
          this.acc = 0;
          this.count = 0;
          if (this.n === ${FRAME}) { this.port.postMessage(this.buf.slice(0)); this.n = 0; }
        }
      }
    }
    return true;
  }
}
registerProcessor('frame-tap', FrameTap);
`;

export class Mic {
  onFrame?: (frame: Float32Array) => void;
  private ctx?: AudioContext;
  private stream?: MediaStream;
  private node?: AudioWorkletNode;

  get active(): boolean {
    return !!this.stream;
  }

  async start(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    try {
      this.ctx = new AudioContext();
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try {
        await this.ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const source = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, 'frame-tap');
      this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onFrame?.(e.data);
      source.connect(this.node);
      // A worklet only runs when connected to the graph; route it to a muted sink.
      const mute = this.ctx.createGain();
      mute.gain.value = 0;
      this.node.connect(mute).connect(this.ctx.destination);
    } catch (err) {
      this.stop();
      throw err;
    }
  }

  stop(): void {
    this.node?.port.close();
    this.node?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = undefined;
    this.stream = undefined;
    this.ctx = undefined;
  }
}
