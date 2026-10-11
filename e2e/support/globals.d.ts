// The Electron preload bridge (apps/desktop/preload.cjs), as seen from the page.
declare global {
  interface Window {
    memoriesChrome?: { platform: string; setTitleBar(theme: string): void; pickFolder?: () => Promise<string | null>; [key: string]: unknown };
  }
}
export {};
