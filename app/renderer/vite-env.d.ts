import type { LabApi } from '../electron/preload';

declare global {
  interface Window {
    httpLab: LabApi;
  }
}

export {};
