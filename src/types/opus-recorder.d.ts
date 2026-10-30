declare module "opus-recorder" {
  interface RecorderConfig {
    encoderPath?: string;
    encoderApplication?: number;
    encoderSampleRate?: number;
    numberOfChannels?: number;
    streamPages?: boolean;
    maxFramesPerPage?: number;
    mediaTrackConstraints?: boolean | MediaTrackConstraints;
    sourceNode?: AudioNode;
  }
  export default class Recorder {
    constructor(config?: RecorderConfig);
    static isRecordingSupported(): boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    close(): Promise<void>;
    ondataavailable: (data: ArrayBuffer) => void;
    onstop: () => void;
    audioContext?: AudioContext;
    sourceNode?: AudioNode;
  }
}
