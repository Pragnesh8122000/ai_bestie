/**
 * Minimal ambient declaration for the `sherpa-onnx-node` native addon. The
 * package does not ship TypeScript types, so we declare just the surface area
 * the TTS service uses. If the package later bundles its own types, this file
 * can be deleted.
 */
declare module 'sherpa-onnx-node' {
  export interface KokoroModelConfig {
    model: string;
    voices: string;
    tokens: string;
    dataDir: string;
  }

  export interface OfflineTtsModelConfig {
    kokoro?: KokoroModelConfig;
    debug?: boolean;
    numThreads?: number;
    provider?: string;
  }

  export interface OfflineTtsConfig {
    model: OfflineTtsModelConfig;
    maxNumSentences?: number;
    silenceScale?: number;
    numThreads?: number;
    provider?: string;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface GenerationConfigOptions {
    speed?: number;
    sid?: number;
    numSteps?: number;
    silenceScale?: number;
  }

  export class GenerationConfig {
    constructor(opts?: GenerationConfigOptions);
  }

  export interface GenerateOptions {
    text: string;
    sid?: number;
    speed?: number;
    generationConfig?: GenerationConfig;
    /** Return 1 to continue, 0 to cancel. */
    onProgress?: (info: { samples: Float32Array; progress: number }) => number;
  }

  export class OfflineTts {
    constructor(config: OfflineTtsConfig);
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    generate(opts: GenerateOptions): GeneratedAudio;
    generateAsync(opts: GenerateOptions): Promise<GeneratedAudio>;
    readonly sampleRate: number;
    readonly numSpeakers: number;
  }

  export function writeWave(
    filename: string,
    audio: { samples: Float32Array; sampleRate: number },
  ): void;

  const _default: {
    OfflineTts: typeof OfflineTts;
    GenerationConfig: typeof GenerationConfig;
    writeWave: typeof writeWave;
  };
  export default _default;
}