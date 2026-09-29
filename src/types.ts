export interface Tone { gamma: number; shadows: number; contrast: number; highlights: number; exposure: number; temperature: number; blackPoint: number; saturation: number }
export interface Profile { id: string; name: string; shortcut: string; tone: Tone; hardware: Record<string, number>; hasSaved?: boolean; hardwareEnabled?: boolean }
export interface Settings { theme: 'system' | 'dark' | 'light'; language: 'zh' | 'en'; closeAction: 'tray' | 'quit'; toggleShortcut: string; cycleShortcut: string }
export interface Config { version: number; presets: Profile[]; activePreset: string; selectedDisplay: string | null; settings: Settings }
export interface Feature { key: string; status: 'available' | 'unsupported' | 'unavailable' | 'unknown'; value: number | null; max: number; detail: string }
export interface Display { id: string; name: string; device: string; primary: boolean; hdr: boolean | null; gammaAvailable: boolean; features: Feature[] }
export interface Snapshot { revision: number; config: Config; draft: Profile; displays: Display[]; enabled: boolean; comparing: boolean; busy: boolean; error: string | null; warnings: string[]; shortcutErrors: string[]; recoveryPending: boolean; gammaRecoveryPending: boolean; hardwareRecoveryPending: boolean; colorRecoveryPending: boolean; saturationError: string | null; reason: string }
export type Operation =
  | { type: 'refresh' | 'retrySaturation' | 'recover' | 'quit' | 'forceQuit' }
  | { type: 'selectDisplay' | 'selectPreset' | 'savePreset' | 'createPreset' | 'deletePreset'; payload: string }
  | { type: 'preview'; payload: Profile }
  | { type: 'setEnabled' | 'compare' | 'captureShortcut'; payload: boolean }
  | { type: 'saveConfig'; payload: Config }
  | { type: 'import'; payload: { json: string; scope: string } };
export const neutralTone: Tone = { gamma: 1, shadows: 0, contrast: 0, highlights: 0, exposure: 0, temperature: 0, blackPoint: 0, saturation: 100 };
export function defaultConfig(): Config {
  return { version: 1, presets: [
    { id: 'desktop', name: '桌面', shortcut: 'F6', tone: { ...neutralTone }, hardware: {}, hasSaved: false, hardwareEnabled: false },
  ], activePreset: 'desktop', selectedDisplay: 'preview-display', settings: { theme: 'system', language: 'zh', closeAction: 'tray', toggleShortcut: 'F9', cycleShortcut: 'F10' } };
}
export function curve(tone: Tone, x: number): number {
  let y = x ** (1 / tone.gamma);
  y += tone.shadows / 100 * .8 * y ** .65 * (1 - y) ** 2;
  y += tone.highlights / 100 * 1.5 * y ** 3 * (1 - y);
  y = (y - .5) * (1 + tone.contrast / 100) + .5;
  y = y * 2 ** tone.exposure;
  return Math.min(1, Math.max(0, tone.blackPoint / 100 + y * (1 - tone.blackPoint / 100)));
}
export function shortcutText(shortcut: string): string { return shortcut.replaceAll('Control', 'Ctrl').replaceAll('Key', '').replaceAll('Digit', '').replaceAll('+', ' + '); }
export function shortcutFromEvent(event: KeyboardEvent | React.KeyboardEvent): string | null {
  if (event.repeat || ['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  if (event.code === 'F12') throw new Error('F12 is reserved by Windows');
  if (!/^(F([1-9]|1[01])|Key[A-Z]|Digit[0-9]|Arrow(Up|Down|Left|Right)|Space|Home|End|PageUp|PageDown|Insert)$/.test(event.code)) throw new Error('Unsupported shortcut key');
  return [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', event.code].filter(Boolean).join('+');
}
