import { Blob as NodeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

beforeEach(() => { localStorage.clear(); vi.resetModules(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('returns isolated snapshots instead of exposing mutable preview state', async () => {
  const bridge = await import('./bridge');
  const first = await bridge.getState();
  first.config.presets[0].name = 'External mutation';
  first.draft.tone.gamma = 2;
  const second = await bridge.getState();
  expect(second.config.presets[0].name).toBe('桌面');
  expect(second.draft.tone.gamma).toBe(1);
  const returned = await bridge.command({ type: 'setEnabled', payload: true });
  returned.enabled = false;
  expect((await bridge.getState()).enabled).toBe(true);
});

it('publishes command snapshots and stops notifying an unsubscribed listener', async () => {
  const bridge = await import('./bridge');
  const events: { revision: number; gamma: number; reason: string }[] = [];
  const unsubscribe = await bridge.subscribe(snapshot => {
    events.push({ revision: snapshot.revision, gamma: snapshot.draft.tone.gamma, reason: snapshot.reason });
  });
  const initial = await bridge.getState();
  await bridge.command({ type: 'preview', payload: { ...initial.draft, tone: { ...initial.draft.tone, gamma: 1.3 } } });
  expect(events).toEqual([{ revision: 1, gamma: 1.3, reason: 'preview' }]);
  unsubscribe();
  const next = await bridge.command({ type: 'setEnabled', payload: true });
  expect(next.revision).toBe(2);
  expect(next.enabled).toBe(true);
  expect(events).toEqual([{ revision: 1, gamma: 1.3, reason: 'preview' }]);
});

it('keeps per-preset unsaved drafts separate from saved configurations', async () => {
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  await bridge.command({ type: 'preview', payload: { ...initial.draft, tone: { ...initial.draft.tone, gamma: 1.5 } } });
  const game = await bridge.command({ type: 'createPreset', payload: 'Game' });
  await bridge.command({ type: 'preview', payload: { ...game.draft, tone: { ...game.draft.tone, gamma: 1.8 } } });
  const desktop = await bridge.command({ type: 'selectPreset', payload: 'desktop' });
  expect(desktop.draft.tone.gamma).toBe(1.5);
  expect(desktop.config.presets[0].tone.gamma).toBe(1);
  const selected = await bridge.command({ type: 'selectPreset', payload: game.draft.id });
  expect(selected.draft.tone.gamma).toBe(1.8);
  expect(selected.config.presets[1].tone.gamma).toBe(1.5);
  const saved = await bridge.command({ type: 'savePreset', payload: 'Game saved' });
  expect(saved.config.presets[1].name).toBe('Game saved');
  expect(saved.config.presets[1].tone.gamma).toBe(1.8);
  expect(saved.config.presets[1].hasSaved).toBe(true);
});

it('imports presets with new identities and no shortcut assignments', async () => {
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  const imported = await bridge.command({ type: 'import', payload: {
    scope: 'presets', json: JSON.stringify({ version: 1, presets: [{ ...initial.draft, name: 'Imported', shortcut: 'F8' }] }),
  } });
  expect(imported.config.presets.map(p => p.name)).toEqual(['桌面', 'Imported']);
  expect(imported.config.presets[1].shortcut).toBe('');
  expect(imported.config.presets[1].id).not.toBe('desktop');
  expect(imported.config.activePreset).toBe('desktop');
  expect(imported.enabled).toBe(false);
  expect(imported.error).toBe(null);
});

it('replacing configuration clears cached drafts and uses the imported picture', async () => {
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  await bridge.command({ type: 'preview', payload: { ...initial.draft, tone: { ...initial.draft.tone, gamma: 1.9 } } });
  const config = structuredClone(initial.config);
  config.presets[0].name = 'Replacement';
  config.presets[0].tone.gamma = 1.2;
  config.selectedDisplay = 'physical-display';
  const replaced = await bridge.command({ type: 'import', payload: { scope: 'all', json: JSON.stringify(config) } });
  expect(replaced.draft.name).toBe('Replacement');
  expect(replaced.draft.tone.gamma).toBe(1.2);
  expect(replaced.config.selectedDisplay).toBe('preview-display');
  const selected = await bridge.command({ type: 'selectPreset', payload: 'desktop' });
  expect(selected.draft.tone.gamma).toBe(1.2);
});

it('falls back from corrupt storage and keeps working when persistence fails', async () => {
  localStorage.setItem('lumashift-layout-preview', '{broken');
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  expect(initial.draft.name).toBe('桌面');
  expect(initial.draft.tone.gamma).toBe(1);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Quota exceeded'); });
  const result = await bridge.command({ type: 'updateSettings', payload: { language: 'en' } });
  expect(result.config.settings.language).toBe('en');
  expect(result.error).toBe(null);
  expect((await bridge.getState()).config.settings.language).toBe('en');
});

it('deletes an active preset and disables effects without deleting the last preset', async () => {
  const bridge = await import('./bridge');
  const created = await bridge.command({ type: 'createPreset', payload: 'Game' });
  await bridge.command({ type: 'setEnabled', payload: true });
  const removed = await bridge.command({ type: 'deletePreset', payload: created.draft.id });
  expect(removed.draft.name).toBe('桌面');
  expect(removed.enabled).toBe(false);
  expect(removed.config.presets.map(p => p.name)).toEqual(['桌面']);
  const refused = await bridge.command({ type: 'deletePreset', payload: 'desktop' });
  expect(refused.error).toBe('Error: Keep at least one preset');
  expect(refused.config.presets.map(p => p.name)).toEqual(['桌面']);
});

it('exports saved presets rather than unsaved preview values in both scopes', async () => {
  vi.useFakeTimers();
  const bridge = await import('./bridge');
  const initial = await bridge.getState();
  await bridge.command({ type: 'preview', payload: { ...initial.draft, tone: { ...initial.draft.tone, gamma: 1.6 } } });
  let exported: NodeBlob | undefined;
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('URL', { createObjectURL(blob: NodeBlob) { exported = blob; return 'blob:export'; }, revokeObjectURL() {} });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  expect(await bridge.exportFile('presets')).toBe(true);
  if (!exported) throw new Error('Export missing');
  const presets = JSON.parse(await exported.text());
  expect(Object.keys(presets)).toEqual(['version', 'presets']);
  expect(presets.version).toBe(1);
  expect(presets.presets[0].name).toBe('桌面');
  expect(presets.presets[0].tone.gamma).toBe(1);
  expect(await bridge.exportFile('all')).toBe(true);
  const config = JSON.parse(await exported.text());
  expect(config.activePreset).toBe('desktop');
  expect(config.presets[0].tone.gamma).toBe(1);
  expect(config.settings.language).toBe('zh');
  await vi.advanceTimersByTimeAsync(1000);
});
