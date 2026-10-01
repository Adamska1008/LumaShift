import { beforeEach, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { defaultConfig, type Operation, type Snapshot } from './types';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }));

function desktopState(): Snapshot {
  const config = defaultConfig();
  return {
    revision: 7, config, draft: structuredClone(config.presets[0]), displays: [],
    enabled: false, comparing: false, busy: false, error: null, warnings: [], shortcutErrors: [],
    recoveryPending: false, gammaRecoveryPending: false, hardwareRecoveryPending: false,
    colorRecoveryPending: false, saturationError: null, reason: 'updated',
  };
}
beforeEach(() => { vi.resetModules(); vi.mocked(invoke).mockReset(); vi.mocked(listen).mockReset(); });

it('uses desktop state and dispatch without accessing preview storage', async () => {
  const storage = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('Preview storage must not be used'); });
  const bridge = await import('./bridge');
  vi.mocked(invoke).mockResolvedValue(desktopState());
  const state = await bridge.getState();
  expect(state.revision).toBe(7);
  expect(state.draft.name).toBe('桌面');
  expect(vi.mocked(invoke).mock.calls[0]).toEqual(['get_state']);
  const operation = { type: 'updateSettings', payload: { theme: 'light' } } satisfies Operation;
  const result = await bridge.command(operation);
  expect(result.revision).toBe(7);
  expect(vi.mocked(invoke).mock.calls[1]).toEqual(['dispatch', { operation }]);
  storage.mockRestore();
});

it('delivers desktop subscription events and releases the listener', async () => {
  const bridge = await import('./bridge');
  let disposed = false;
  vi.mocked(listen).mockResolvedValue(() => { disposed = true; });
  const revisions: number[] = [];
  const unsubscribe = await bridge.subscribe(snapshot => { revisions.push(snapshot.revision); });
  const [event, callback] = vi.mocked(listen).mock.calls[0];
  expect(event).toBe('state-changed');
  callback({ event: 'state-changed', id: 1, payload: desktopState() });
  expect(revisions).toEqual([7]);
  unsubscribe();
  expect(disposed).toBe(true);
});

it('saves exports through desktop IPC instead of browser downloads', async () => {
  const bridge = await import('./bridge');
  vi.mocked(invoke).mockResolvedValueOnce('{"version":1,"presets":[]}').mockResolvedValueOnce(true);
  const exported = await bridge.exportFile('presets');
  expect(exported).toBe(true);
  expect(vi.mocked(invoke).mock.calls).toEqual([
    ['export_data', { scope: 'presets' }],
    ['save_export', { content: '{"version":1,"presets":[]}', name: 'presets' }],
  ]);
});
