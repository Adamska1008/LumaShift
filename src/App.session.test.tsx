import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import * as api from './bridge';
import { defaultConfig, type Operation, type Snapshot } from './types';

vi.mock('./bridge', () => ({
  desktop: true,
  getState: vi.fn(),
  subscribe: vi.fn(),
  command: vi.fn(),
  windowAction: vi.fn(),
}));
vi.mock('./diagnostics', () => ({ reportUi: vi.fn(), describeError: String }));

function initialState(): Snapshot {
  const config = defaultConfig();
  config.settings.language = 'en';
  config.presets[0].name = 'Desktop';
  config.presets[0].hasSaved = true;
  config.presets.push({ ...structuredClone(config.presets[0]), id: 'game', name: 'Game', shortcut: 'F7' });
  return {
    revision: 1, config, draft: structuredClone(config.presets[0]),
    displays: [{ id: 'preview-display', name: 'Display', device: 'test', primary: true, hdr: false, gammaAvailable: true, features: [] }],
    enabled: true, comparing: false, busy: false, error: null, warnings: [], shortcutErrors: [],
    recoveryPending: false, gammaRecoveryPending: false, hardwareRecoveryPending: false,
    colorRecoveryPending: false, saturationError: null, reason: 'ready',
  };
}

let state: Snapshot;
let publish: (snapshot: Snapshot) => void;
let unsubscribe = vi.fn<() => void>();
let operations: Operation[];

async function execute(operation: Operation): Promise<Snapshot> {
  operations.push(structuredClone(operation));
  state.revision++;
  state.reason = 'updated';
  switch (operation.type) {
    case 'preview': state.draft = structuredClone(operation.payload); state.reason = 'preview'; break;
    case 'savePreset':
      state.config.presets = state.config.presets.map(p => p.id === state.draft.id ? structuredClone(state.draft) : p);
      state.reason = 'saved'; break;
    case 'selectPreset': {
      const selected = state.config.presets.find(p => p.id === operation.payload);
      if (!selected) throw new Error('Preset not found');
      state.config.activePreset = selected.id; state.draft = structuredClone(selected); state.reason = 'profile'; break;
    }
    case 'setPresetShortcut': {
      const preset = state.config.presets.find(p => p.id === operation.payload.presetId);
      if (!preset) throw new Error('Preset not found');
      preset.shortcut = operation.payload.shortcut;
      state.draft.shortcut = state.config.presets.find(p => p.id === state.draft.id)?.shortcut ?? '';
      break;
    }
    case 'updateSettings': state.config.settings = { ...state.config.settings, ...operation.payload }; break;
    case 'setEnabled': state.enabled = operation.payload; break;
  }
  const result = structuredClone(state);
  publish(result);
  return result;
}

async function settle() { await act(async () => {}); }
async function start() { render(<App />); await settle(); }
function gamma() { return screen.getByRole('slider', { name: 'Gamma' }); }
function changeGamma(value: string) { fireEvent.change(gamma(), { target: { value } }); }

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  state = initialState(); operations = []; unsubscribe = vi.fn();
  vi.mocked(api.getState).mockResolvedValue(structuredClone(state));
  vi.mocked(api.subscribe).mockImplementation(async callback => { publish = callback; return unsubscribe; });
  vi.mocked(api.command).mockImplementation(execute);
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('adjustment session through the app', () => {
  it('shows edits immediately and sends only the newest pending preview', async () => {
    await start();
    changeGamma('1.2'); changeGamma('1.4');
    expect(gamma().getAttribute('value')).toBe('1.4');
    expect(operations).toEqual([]);
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
    expect(state.draft.tone.gamma).toBe(1.4);
    expect(operations.map(o => o.type)).toEqual(['preview']);
    expect(screen.getByText('Unsaved changes').textContent).toBe('Unsaved changes');
  });

  it('flushes the latest edit before saving and shows the saved result', async () => {
    await start(); changeGamma('1.6');
    fireEvent.click(screen.getByRole('button', { name: 'Save preset' })); await settle();
    expect(state.config.presets[0].tone.gamma).toBe(1.6);
    expect(operations.map(o => o.type)).toEqual(['preview', 'savePreset']);
    expect(screen.getByText('Saved', { selector: 'span' }).textContent).toBe('Saved');
    expect(gamma().getAttribute('value')).toBe('1.6');
  });

  it('saves a shortcut without saving or discarding the edited picture', async () => {
    await start(); changeGamma('1.5');
    const shortcut = screen.getByRole('button', { name: 'Desktop shortcut' });
    fireEvent.click(shortcut); await settle();
    fireEvent.keyDown(shortcut, { key: 'F8', code: 'F8' }); await settle();
    expect(screen.getByRole('button', { name: 'Desktop shortcut' }).textContent).toBe('F8');
    expect(gamma().getAttribute('value')).toBe('1.5');
    expect(state.config.presets[0].tone.gamma).toBe(1);
    expect(state.config.presets[0].shortcut).toBe('F8');
    expect(operations.find(o => o.type === 'setPresetShortcut')).toEqual({
      type: 'setPresetShortcut', payload: { presetId: 'desktop', shortcut: 'F8' },
    });
    expect(screen.getByText('Unsaved changes').textContent).toBe('Unsaved changes');
  });

  it('updates a preference without sending a full configuration', async () => {
    await start(); changeGamma('1.4');
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'When closing the window' }), { target: { value: 'quit' } });
    await settle();
    expect(state.config.settings.closeAction).toBe('quit');
    expect(state.config.presets[0].tone.gamma).toBe(1);
    expect(operations.find(o => o.type === 'updateSettings')).toEqual({ type: 'updateSettings', payload: { closeAction: 'quit' } });
    fireEvent.click(screen.getByRole('button', { name: 'Back to picture' }));
    expect(gamma().getAttribute('value')).toBe('1.4');
    expect(screen.getByText('Unsaved changes').textContent).toBe('Unsaved changes');
  });

  it('ignores a stale event after selecting another preset', async () => {
    await start(); changeGamma('1.7');
    const stale = structuredClone(state);
    fireEvent.click(screen.getByRole('button', { name: 'Game' })); await settle();
    await act(async () => { publish(stale); });
    expect(screen.getByRole('heading', { name: 'Game' }).textContent).toBe('Game');
    expect(gamma().getAttribute('value')).toBe('1');
    expect(state.config.activePreset).toBe('game');
    expect(operations.map(o => o.type)).toEqual(['preview', 'selectPreset']);
  });

  it('discards a pending local preview when an external preset switch arrives', async () => {
    await start(); changeGamma('1.8');
    state.config.activePreset = 'game';
    state.draft = structuredClone(state.config.presets[1]);
    state.reason = 'profile'; state.revision = 5;
    await act(async () => { publish(structuredClone(state)); });
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
    expect(screen.getByRole('heading', { name: 'Game' }).textContent).toBe('Game');
    expect(gamma().getAttribute('value')).toBe('1');
    expect(operations).toEqual([]);
    changeGamma('1.3');
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
    expect(state.draft.id).toBe('game');
    expect(state.draft.tone.gamma).toBe(1.3);
  });

  it('keeps a newer event when the initial state request returns late', async () => {
    const old = structuredClone(state);
    let release: (snapshot: Snapshot) => void = () => { throw new Error('State request not started'); };
    vi.mocked(api.getState).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    render(<App />); await settle();
    state.config.activePreset = 'game';
    state.draft = structuredClone(state.config.presets[1]);
    state.reason = 'profile'; state.revision = 10;
    await act(async () => { publish(structuredClone(state)); release(old); });
    expect(screen.getByRole('heading', { name: 'Game' }).textContent).toBe('Game');
    expect(screen.getByRole('button', { name: 'Game shortcut' }).textContent).toBe('F7');
  });

  it('waits for an in-flight preview before disabling effects', async () => {
    await start();
    let release: () => void = () => { throw new Error('Preview not started'); };
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(api.command).mockImplementation(async operation => {
      if (operation.type === 'preview') await gate;
      return execute(operation);
    });
    changeGamma('1.3');
    await act(async () => { await vi.advanceTimersByTimeAsync(90); });
    fireEvent.click(screen.getByRole('switch', { name: 'Enable effects' })); await settle();
    expect(screen.getByRole('switch', { name: 'Enable effects' }).getAttribute('aria-checked')).toBe('true');
    await act(async () => { release(); }); await settle();
    expect(operations.map(o => o.type)).toEqual(['preview', 'setEnabled']);
    expect(screen.getByRole('switch', { name: 'Enable effects' }).getAttribute('aria-checked')).toBe('false');
    expect(screen.getByText('Effects disabled')).toBeDefined();
  });

  it('evaluates queued toggles against the latest returned state', async () => {
    await start();
    const toggle = screen.getByRole('switch', { name: 'Enable effects' });
    fireEvent.click(toggle); fireEvent.click(toggle); await settle();
    expect(operations).toEqual([{ type: 'setEnabled', payload: false }, { type: 'setEnabled', payload: true }]);
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText('Effects enabled')).toBeDefined();
  });

  it('recovers the operation queue after a transport rejection', async () => {
    await start();
    vi.mocked(api.command).mockRejectedValueOnce(new Error('Transport unavailable'));
    fireEvent.click(screen.getByRole('switch', { name: 'Enable effects' })); await settle();
    expect(screen.getByText('Error: Transport unavailable').textContent).toBe('Error: Transport unavailable');
    fireEvent.click(screen.getByRole('switch', { name: 'Enable effects' })); await settle();
    expect(screen.getByRole('switch', { name: 'Enable effects' }).getAttribute('aria-checked')).toBe('false');
  });

  it('releases a subscription that finishes after the page unmounts', async () => {
    let release: (cleanup: () => void) => void = () => { throw new Error('Subscription not started'); };
    vi.mocked(api.subscribe).mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const view = render(<App />); view.unmount();
    await act(async () => { release(unsubscribe); });
    expect(unsubscribe.mock.calls.length).toBe(1);
    vi.mocked(api.subscribe).mockImplementation(async callback => { publish = callback; return unsubscribe; });
    await start();
    expect(gamma().getAttribute('value')).toBe('1');
  });
});
