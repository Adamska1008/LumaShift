import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { defaultConfig, type Config, type Operation, type Snapshot } from './types';

export const desktop = isTauri();
let demo: Snapshot | undefined;
const subscribers = new Set<(s: Snapshot) => void>();
const draftCache = new Map<string, Snapshot['draft']>();
function previewState(): Snapshot {
  if (demo) return demo;
  let config = defaultConfig();
  try { const saved = localStorage.getItem('lumashift-layout-preview'); if (saved) { const parsed = JSON.parse(saved); validatePreview(parsed); config = parsed; } } catch { /* Preview storage is optional. */ }
  config.selectedDisplay = 'preview-display';
  demo = { revision: 0, config, draft: structuredClone(config.presets.find(p => p.id === config.activePreset) ?? config.presets[0]),
    displays: [{ id: 'preview-display', name: '演示显示器 · Demo display', device: 'Preview only', primary: true, hdr: false, gammaAvailable: true,
      features: ['brightness', 'contrast', 'saturation', 'sharpness', 'redGain', 'greenGain', 'blueGain'].map((key, i) => ({ key, status: i < 4 ? 'available' : 'unsupported', value: i < 4 ? [70, 50, 55, 50][i] : null, max: i < 4 ? 100 : 0, detail: '' })) }],
    enabled: false, comparing: false, busy: false, error: null, warnings: [], shortcutErrors: [], recoveryPending: false, gammaRecoveryPending: false, hardwareRecoveryPending: false, reason: 'ready' };
  return demo;
}
function validatePreview(config: Config) {
  if (config.version !== 1 || !Array.isArray(config.presets) || !config.presets.length || config.presets.length > 50) throw new Error('Invalid configuration');
  const ids = new Set(config.presets.map(p => p.id));
  if (ids.size !== config.presets.length || !ids.has(config.activePreset)) throw new Error('Invalid preset IDs');
  for (const p of config.presets) {
    if (typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name.trim() || [...p.name].length > 40 || typeof p.shortcut !== 'string') throw new Error('Invalid preset');
    const ranges = { gamma: [.6, 2.2], shadows: [0, 60], contrast: [-40, 40], highlights: [-40, 40], exposure: [-.5, .5], temperature: [-50, 50], blackPoint: [0, 8] };
    if (p.hardwareEnabled !== undefined && typeof p.hardwareEnabled !== 'boolean') throw new Error('Invalid hardware switch');
    if (!p.tone || !p.hardware || Array.isArray(p.hardware)) throw new Error('Missing preset parameters');
    for (const [key, [min, max]] of Object.entries(ranges)) { const value = p.tone[key as keyof typeof ranges]; if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`); }
    for (const [key, value] of Object.entries(p.hardware)) if (!['brightness', 'contrast', 'saturation', 'sharpness', 'redGain', 'greenGain', 'blueGain'].includes(key) || !Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid hardware parameter');
  }
  if (!config.settings || !['light', 'dark', 'system'].includes(config.settings.theme) || !['zh', 'en'].includes(config.settings.language) || typeof config.settings.startMinimized !== 'boolean' || typeof config.settings.applyLastOnStart !== 'boolean') throw new Error('Invalid preferences');
  const keys = config.presets.map(p => p.shortcut).concat(config.settings.toggleShortcut, config.settings.cycleShortcut).filter(Boolean);
  if (new Set(keys).size !== keys.length) throw new Error('Shortcut already assigned');
  if (keys.some(k => typeof k !== 'string')) throw new Error('Invalid shortcut');
  if (keys.some(k => k.split('+').includes('F12'))) throw new Error('F12 is reserved by Windows');
}
export async function getState(): Promise<Snapshot> { return desktop ? invoke('get_state') : structuredClone(previewState()); }
export async function subscribe(callback: (snapshot: Snapshot) => void): Promise<() => void> {
  if (desktop) return listen<Snapshot>('state-changed', e => callback(e.payload));
  subscribers.add(callback); return () => { subscribers.delete(callback); };
}
export async function command(operation: Operation): Promise<Snapshot> {
  if (desktop) return invoke('dispatch', { operation });
  const s = previewState(); s.error = null; s.reason = 'updated';
  const before = structuredClone(s);
  try {
    switch (operation.type) {
      case 'preview': if (operation.payload.id === s.config.activePreset) s.draft = structuredClone(operation.payload); s.reason = 'preview'; break;
      case 'setEnabled': s.enabled = operation.payload; s.comparing = false; break;
      case 'compare': s.comparing = operation.payload; break;
      case 'captureShortcut': break;
      case 'selectPreset': {
        const preset = s.config.presets.find(p => p.id === operation.payload); if (!preset) throw new Error('Preset not found');
        draftCache.set(s.draft.id, structuredClone(s.draft)); s.draft = structuredClone(draftCache.get(preset.id) ?? preset);
        s.draft.shortcut = preset.shortcut;
        s.config.activePreset = preset.id; s.enabled = true; s.comparing = false; s.reason = 'profile'; break;
      }
      case 'selectDisplay': s.config.selectedDisplay = operation.payload; s.enabled = false; break;
      case 'refresh': s.enabled = false; s.comparing = false; break;
      case 'savePreset': s.draft.name = operation.payload.trim(); s.config.presets = s.config.presets.map(p => p.id === s.draft.id ? structuredClone(s.draft) : p); draftCache.delete(s.draft.id); s.reason = 'saved'; break;
      case 'createPreset': {
        draftCache.set(s.draft.id, structuredClone(s.draft)); s.draft = { ...structuredClone(s.draft), id: crypto.randomUUID(), name: operation.payload.trim(), shortcut: '' };
        s.config.presets.push(structuredClone(s.draft)); s.config.activePreset = s.draft.id; s.reason = 'profile'; break;
      }
      case 'deletePreset':
        if (s.config.presets.length < 2) throw new Error('Keep at least one preset');
        s.config.presets = s.config.presets.filter(p => p.id !== operation.payload);
        if (s.config.activePreset === operation.payload) { s.config.activePreset = s.config.presets[0].id; s.draft = structuredClone(s.config.presets[0]); s.enabled = false; }
        s.reason = 'profile'; break;
      case 'saveConfig': validatePreview(operation.payload); s.config = structuredClone(operation.payload); s.draft.shortcut = s.config.presets.find(p => p.id === s.draft.id)?.shortcut ?? ''; break;
      case 'import': {
        const parsed = JSON.parse(operation.payload.json);
        if (operation.payload.scope === 'all') { validatePreview(parsed); s.config = parsed; s.draft = structuredClone(s.config.presets.find(p => p.id === s.config.activePreset) ?? s.config.presets[0]); }
        else { if (parsed.version !== 1 || !Array.isArray(parsed.presets)) throw new Error('Invalid presets'); s.config.presets.push(...parsed.presets.map((p: Snapshot['draft']) => ({ ...p, id: crypto.randomUUID(), shortcut: '' }))); validatePreview(s.config); }
        s.config.selectedDisplay = 'preview-display'; draftCache.clear(); s.enabled = false; s.comparing = false; s.reason = 'profile'; break;
      }
      case 'recover': s.recoveryPending = false; s.gammaRecoveryPending = false; s.hardwareRecoveryPending = false; s.enabled = false; break;
      case 'quit': case 'forceQuit': s.enabled = false; break;
    }
    validatePreview(s.config);
  } catch (error) { Object.assign(s, before); s.error = String(error); }
  s.revision++; try { localStorage.setItem('lumashift-layout-preview', JSON.stringify(s.config)); } catch { /* Still allow a nonpersistent layout preview. */ }
  const snapshot = structuredClone(s); subscribers.forEach(fn => fn(snapshot)); return snapshot;
}
export async function exportFile(scope: 'all' | 'presets'): Promise<boolean> {
  const content = desktop ? await invoke<string>('export_data', { scope }) : JSON.stringify(scope === 'all' ? previewState().config : { version: 1, presets: previewState().config.presets }, null, 2);
  if (desktop) return invoke('save_export', { content, name: scope });
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json' }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = `lumashift-${scope}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
}
export async function windowAction(action: 'minimize' | 'maximize' | 'close' | 'drag') {
  if (!desktop) return;
  const window = getCurrentWindow();
  if (action === 'minimize') await window.minimize();
  if (action === 'maximize') await window.toggleMaximize();
  if (action === 'close') await window.close();
  if (action === 'drag') await window.startDragging();
}
export async function openLogs() { if (desktop) await invoke('open_logs'); }
