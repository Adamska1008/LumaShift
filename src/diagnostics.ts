import { invoke, isTauri } from '@tauri-apps/api/core';

export function reportUi(message: string) {
  if (isTauri()) void invoke('report_ui_event', { message: message.slice(0, 4000) }).catch(() => {});
}
export function describeError(error: unknown): string {
  return error instanceof Error ? (error.stack || error.message) : String(error);
}
export function installDiagnostics() {
  window.addEventListener('error', event => reportUi(`window.error: ${describeError(event.error ?? event.message)}`));
  window.addEventListener('unhandledrejection', event => reportUi(`unhandledrejection: ${describeError(event.reason)}`));
  reportUi(`frontend bundle loaded; ${navigator.userAgent}`);
}
