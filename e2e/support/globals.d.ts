// The Electron preload bridge (apps/desktop/preload.cjs), as seen from the page.
declare global {
  interface Window {
    memoriesChrome?: { platform: string; setTitleBar(theme: string): void; [key: string]: unknown };
  }
}
export {};
