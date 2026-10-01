import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as preview from './previewEngine';
import type { Operation, Snapshot } from './types';

export const desktop = isTauri();

export async function getState(): Promise<Snapshot> {
  return desktop ? invoke('get_state') : preview.getState();
}
export async function subscribe(callback: (snapshot: Snapshot) => void): Promise<() => void> {
  return desktop ? listen<Snapshot>('state-changed', e => callback(e.payload)) : preview.subscribe(callback);
}
export async function command(operation: Operation): Promise<Snapshot> {
  return desktop ? invoke('dispatch', { operation }) : preview.command(operation);
}
export async function exportFile(scope: 'all' | 'presets'): Promise<boolean> {
  const content = desktop ? await invoke<string>('export_data', { scope }) : preview.exportData(scope);
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
