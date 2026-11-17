export const CHROME_REMOTE_DEBUGGING_SETTINGS_URL = 'chrome://inspect/#remote-debugging' as const;

export type BrowserConnectionPhase = 'unavailable' | 'setup_required' | 'ready' | 'connecting' | 'connected' | 'reconnecting' | 'error';

export interface BrowserConnectionStatus {
  phase: BrowserConnectionPhase;
  message: string;
  checkedAt: string;
  toolAvailable: boolean;
  chromeAvailable: boolean;
  debuggingEnabled: boolean;
  connectionVerified: boolean;
  browserVersion?: string;
  lastVerifiedAt?: string;
  settingsUrl: typeof CHROME_REMOTE_DEBUGGING_SETTINGS_URL;
  reuseEnabled: boolean;
}
