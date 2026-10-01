import { defaultConfig, type Config, type Operation, type Settings, type Snapshot } from './types';

let demo: Snapshot | undefined;
const subscribers = new Set<(s: Snapshot) => void>();
const draftCache = new Map<string, Snapshot['draft']>();

function previewState(): Snapshot {
  if (demo) return demo;
  let config = defaultConfig();
  try { const saved = localStorage.getItem('lumashift-layout-preview'); if (saved) { const parsed = JSON.parse(saved); validatePreview(parsed); config = parsed; } } catch {}
  config.selectedDisplay = 'preview-display';
  demo = { revision: 0, config, draft: structuredClone(config.presets.find(p => p.id === config.activePreset) ?? config.presets[0]),
    displays: [{ id: 'preview-display', name: '演示显示器 · Demo display', device: 'Preview only', primary: true, hdr: false, gammaAvailable: true, features: [] }],
    enabled: false, comparing: false, busy: false, error: null, warnings: [], shortcutErrors: [], recoveryPending: false, gammaRecoveryPending: false, hardwareRecoveryPending: false, colorRecoveryPending: false, saturationError: null, reason: 'ready' };
  return demo;
}

function validatePreview(config: Config) {
  if (config.version !== 1 || !Array.isArray(config.presets) || !config.presets.length || config.presets.length > 50) throw new Error('Invalid configuration');
  const ids = new Set(config.presets.map(p => p.id));
  if (ids.size !== config.presets.length || !ids.has(config.activePreset)) throw new Error('Invalid preset IDs');
  for (const p of config.presets) {
    if (typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || !p.name.trim() || [...p.name].length > 40 || typeof p.shortcut !== 'string') throw new Error('Invalid preset');
    const ranges = { gamma: [.6, 2.2], shadows: [0, 60], contrast: [-40, 40], highlights: [-40, 40], exposure: [-.5, .5], temperature: [-50, 50], blackPoint: [0, 8], saturation: [0, 200] };
    if (p.hasSaved !== undefined && typeof p.hasSaved !== 'boolean') throw new Error('Invalid save state');
    if (p.hardwareEnabled !== undefined && typeof p.hardwareEnabled !== 'boolean') throw new Error('Invalid hardware switch');
    if (!p.tone || !p.hardware || Array.isArray(p.hardware)) throw new Error('Missing preset parameters');
    if (p.tone.saturation === undefined) p.tone.saturation = 100;
    for (const [key, [min, max]] of Object.entries(ranges)) { const value = p.tone[key as keyof typeof ranges]; if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}`); }
    for (const [key, value] of Object.entries(p.hardware)) if (!['brightness', 'contrast', 'saturation', 'sharpness', 'redGain', 'greenGain', 'blueGain'].includes(key) || !Number.isInteger(value) || value < 0 || value > 100) throw new Error('Invalid hardware parameter');
  }
  if (!config.settings || !['light', 'dark', 'system'].includes(config.settings.theme) || !['zh', 'en'].includes(config.settings.language)) throw new Error('Invalid preferences');
  if (config.settings.closeAction === undefined) config.settings.closeAction = 'tray';
  if (!['tray', 'quit'].includes(config.settings.closeAction)) throw new Error('Invalid close action');
  const legacy = config.settings as Settings & { startMinimized?: boolean; applyLastOnStart?: boolean };
  delete legacy.startMinimized; delete legacy.applyLastOnStart;
  const keys = config.presets.map(p => p.shortcut).concat(config.settings.toggleShortcut, config.settings.cycleShortcut).filter(Boolean);
  if (new Set(keys).size !== keys.length) throw new Error('Shortcut already assigned');
  if (keys.some(k => typeof k !== 'string')) throw new Error('Invalid shortcut');
  if (keys.some(k => k.split('+').includes('F12'))) throw new Error('F12 is reserved by Windows');
}

export function getState(): Snapshot { return structuredClone(previewState()); }

export function subscribe(callback: (snapshot: Snapshot) => void): () => void {
  subscribers.add(callback);
  return () => { subscribers.delete(callback); };
}

export function command(operation: Operation): Snapshot {
  const s = previewState(); s.error = null; s.reason = 'updated';
  const before = structuredClone(s);
  try {
    switch (operation.type) {
      case 'preview': if (operation.payload.id === s.config.activePreset) s.draft = structuredClone(operation.payload); s.reason = 'preview'; break;
      case 'setEnabled': s.enabled = operation.payload; s.comparing = false; break;
      case 'compare': s.comparing = operation.payload && s.enabled; break;
      case 'captureShortcut': break;
      case 'selectPreset': {
        const preset = s.config.presets.find(p => p.id === operation.payload); if (!preset) throw new Error('Preset not found');
        draftCache.set(s.draft.id, structuredClone(s.draft)); s.draft = structuredClone(draftCache.get(preset.id) ?? preset);
        s.draft.shortcut = preset.shortcut;
        s.config.activePreset = preset.id; s.enabled = true; s.comparing = false; s.reason = 'profile'; break;
      }
      case 'selectDisplay': s.config.selectedDisplay = operation.payload; s.enabled = false; break;
      case 'retrySaturation': s.saturationError = null; break;
      case 'refresh': s.enabled = false; s.comparing = false; break;
      case 'savePreset': s.draft.hasSaved = true; s.comparing = false; s.draft.name = operation.payload.trim(); s.config.presets = s.config.presets.map(p => p.id === s.draft.id ? structuredClone(s.draft) : p); draftCache.delete(s.draft.id); s.reason = 'saved'; break;
      case 'createPreset': {
        draftCache.set(s.draft.id, structuredClone(s.draft)); s.draft = { ...structuredClone(s.draft), id: crypto.randomUUID(), name: operation.payload.trim(), shortcut: '', hasSaved: false };
        s.config.presets.push(structuredClone(s.draft)); s.config.activePreset = s.draft.id; s.comparing = false; s.reason = 'profile'; break;
      }
      case 'deletePreset':
        if (s.config.presets.length < 2) throw new Error('Keep at least one preset');
        s.config.presets = s.config.presets.filter(p => p.id !== operation.payload);
        if (s.config.activePreset === operation.payload) { s.config.activePreset = s.config.presets[0].id; s.draft = structuredClone(s.config.presets[0]); s.enabled = false; }
        s.reason = 'profile'; break;
      case 'setPresetShortcut': {
        const preset = s.config.presets.find(p => p.id === operation.payload.presetId);
        if (!preset) throw new Error('Preset not found');
        preset.shortcut = operation.payload.shortcut;
        s.draft.shortcut = s.config.presets.find(p => p.id === s.draft.id)?.shortcut ?? '';
        break;
      }
      case 'updateSettings': s.config.settings = { ...s.config.settings, ...operation.payload }; break;
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
  s.revision++; try { localStorage.setItem('lumashift-layout-preview', JSON.stringify(s.config)); } catch {}
  const snapshot = structuredClone(s); subscribers.forEach(fn => fn(snapshot)); return snapshot;
}

export function exportData(scope: 'all' | 'presets'): string {
  const config = previewState().config;
  return JSON.stringify(scope === 'all' ? config : { version: 1, presets: config.presets }, null, 2);
}
