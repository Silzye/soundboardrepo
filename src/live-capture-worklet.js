class LiveCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(1024);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const take = Math.min(input.length - i, this.block.length - this.filled);
      this.block.set(input.subarray(i, i + take), this.filled);
      this.filled += take;
      i += take;
      if (this.filled === this.block.length) {
        const out = this.block;
        this.port.postMessage(out, [out.buffer]);
        this.block = new Float32Array(1024);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor("live-capture", LiveCaptureProcessor);
