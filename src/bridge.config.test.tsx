import { beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); vi.resetModules(); });

it('applies setting patches to the latest config without losing presets or unsaved edits', async () => {
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  const draft = { ...initial.draft, tone: { ...initial.draft.tone, gamma: 1.7 } };
  await bridge.command({ type: 'preview', payload: draft });
  const created = await bridge.command({ type: 'createPreset', payload: 'New' });
  await bridge.command({ type: 'updateSettings', payload: { theme: 'light' } });
  const result = await bridge.command({ type: 'updateSettings', payload: { closeAction: 'quit' } });
  expect(result.config.settings).toEqual({
    theme: 'light', language: 'zh', closeAction: 'quit', toggleShortcut: 'F9', cycleShortcut: 'F10',
  });
  expect(result.config.presets.map(p => p.name)).toEqual(['桌面', 'New']);
  expect(result.config.activePreset).toBe(created.draft.id);
  expect(result.draft.tone.gamma).toBe(1.7);
  expect(result.config.presets[0].tone.gamma).toBe(1);
  expect(result.config.selectedDisplay).toBe('preview-display');
  expect(result.error).toBe(null);
});

it('changes a nonactive shortcut and preserves the latest selected preset and draft', async () => {
  const bridge = await import('./bridge');
  await bridge.getState();
  const created = await bridge.command({ type: 'createPreset', payload: 'Game' });
  await bridge.command({ type: 'preview', payload: { ...created.draft, tone: { ...created.draft.tone, gamma: 1.6 } } });
  const result = await bridge.command({ type: 'setPresetShortcut', payload: { presetId: 'desktop', shortcut: 'F8' } });
  expect(result.config.activePreset).toBe(created.draft.id);
  expect(result.config.presets[0].shortcut).toBe('F8');
  expect(result.draft.shortcut).toBe('');
  expect(result.draft.tone.gamma).toBe(1.6);
  expect(result.config.presets[1].tone.gamma).toBe(1);
});

it('rejects duplicate and missing preset shortcuts without changing configuration', async () => {
  const bridge = await import('./bridge');
  await bridge.getState();
  const duplicate = await bridge.command({ type: 'setPresetShortcut', payload: { presetId: 'desktop', shortcut: 'F9' } });
  expect(duplicate.error).toBe('Error: Shortcut already assigned');
  expect(duplicate.config.presets[0].shortcut).toBe('F6');
  const missing = await bridge.command({ type: 'setPresetShortcut', payload: { presetId: 'missing', shortcut: 'F8' } });
  expect(missing.error).toBe('Error: Preset not found');
  const cleared = await bridge.command({ type: 'setPresetShortcut', payload: { presetId: 'desktop', shortcut: '' } });
  expect(cleared.config.presets[0].shortcut).toBe('');
  expect(cleared.draft.shortcut).toBe('');
  expect(cleared.error).toBe(null);
});

it('rejects invalid or conflicting preference edits and persists a valid partial update', async () => {
  const bridge = await import('./bridge');
  await bridge.getState();
  const duplicate = await bridge.command({ type: 'updateSettings', payload: { toggleShortcut: 'F6', theme: 'light' } });
  expect(duplicate.error).toBe('Error: Shortcut already assigned');
  expect(duplicate.config.settings.theme).toBe('system');
  expect(duplicate.config.settings.toggleShortcut).toBe('F9');
  const reserved = await bridge.command({ type: 'updateSettings', payload: { cycleShortcut: 'F12' } });
  expect(reserved.error).toBe('Error: F12 is reserved by Windows');
  expect(reserved.config.settings.cycleShortcut).toBe('F10');
  await bridge.command({ type: 'updateSettings', payload: { language: 'en' } });
  const saved = JSON.parse(localStorage.getItem('lumashift-layout-preview') ?? 'null');
  expect(saved.settings).toEqual({
    theme: 'system', language: 'en', closeAction: 'tray', toggleShortcut: 'F9', cycleShortcut: 'F10',
  });
});
