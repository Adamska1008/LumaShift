import { useCallback, useEffect, useRef, useState } from 'react';
import * as api from './bridge';
import { describeError, reportUi } from './diagnostics';
import { shortcutFromEvent, type Operation, type Profile, type Snapshot } from './types';

type SessionView = { snapshot: Snapshot | null; draft: Profile | null };
type SessionOperation = Operation | ((snapshot: Snapshot) => Operation);
type SessionWork = SessionView & {
  pendingPreview: Profile | null;
  previewTimer: ReturnType<typeof setTimeout> | null;
  previewInFlight: Promise<void>;
  actionQueue: Promise<unknown>;
};

export function useAdjustmentSession(onError: (error: string) => void) {
  const [view, setView] = useState<SessionView>({ snapshot: null, draft: null });
  const [bootError, setBootError] = useState('');
  const work = useRef<SessionWork>({
    snapshot: null,
    draft: null,
    pendingPreview: null,
    previewTimer: null,
    previewInFlight: Promise.resolve(),
    actionQueue: Promise.resolve(),
  });

  const applySnapshot = useCallback((snapshot: Snapshot) => {
    const session = work.current;
    if (session.snapshot && snapshot.revision < session.snapshot.revision) return;
    session.snapshot = snapshot;
    if (!session.draft || ['ready', 'profile', 'saved'].includes(snapshot.reason)) {
      session.draft = structuredClone(snapshot.draft);
      if (snapshot.reason === 'profile') {
        session.pendingPreview = null;
        if (session.previewTimer) clearTimeout(session.previewTimer);
        session.previewTimer = null;
      }
    } else if (session.draft.id === snapshot.draft.id && session.draft.shortcut !== snapshot.draft.shortcut) {
      session.draft = { ...session.draft, shortcut: snapshot.draft.shortcut };
    }
    setView({ snapshot, draft: session.draft });
  }, []);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    void (async () => {
      reportUi('startup: subscribing to backend state');
      const cleanup = await api.subscribe(snapshot => { if (active) applySnapshot(snapshot); });
      if (!active) { cleanup(); return; }
      unsubscribe = cleanup;
      reportUi('startup: requesting initial state');
      const snapshot = await api.getState();
      if (active) {
        applySnapshot(snapshot);
        reportUi(`startup: state received, revision=${snapshot.revision}, reason=${snapshot.reason}`);
      }
    })().catch(error => {
      reportUi(`startup failed: ${describeError(error)}`);
      if (active) setBootError(String(error));
    });
    return () => { active = false; unsubscribe?.(); };
  }, [applySnapshot]);

  const reportedReady = useRef(false);
  useEffect(() => {
    const { snapshot, draft } = view;
    if (snapshot && draft && !snapshot.busy && !reportedReady.current) {
      reportedReady.current = true;
      reportUi(`interface mounted; displays=${snapshot.displays.length}, preset=${draft.id}`);
    }
  }, [view]);

  const flushPreview = useCallback(async () => {
    const session = work.current;
    if (session.previewTimer) clearTimeout(session.previewTimer);
    session.previewTimer = null;
    const profile = session.pendingPreview;
    session.pendingPreview = null;
    if (profile) {
      session.previewInFlight = session.previewInFlight.catch(() => {}).then(async () => {
        applySnapshot(await api.command({ type: 'preview', payload: profile }));
      });
    }
    await session.previewInFlight;
  }, [applySnapshot]);

  const act = useCallback((operation: SessionOperation) => {
    const session = work.current;
    session.actionQueue = session.actionQueue.catch(() => {}).then(async () => {
      await flushPreview();
      if (!session.snapshot) return;
      const result = await api.command(typeof operation === 'function' ? operation(session.snapshot) : operation);
      applySnapshot(result);
    }).catch(error => onError(String(error)));
    return session.actionQueue;
  }, [applySnapshot, flushPreview, onError]);

  const edit = useCallback((profile: Profile) => {
    const session = work.current;
    session.draft = profile;
    session.pendingPreview = profile;
    setView({ snapshot: session.snapshot, draft: profile });
    if (!session.previewTimer) {
      session.previewTimer = setTimeout(() => { void flushPreview().catch(error => onError(String(error))); }, 90);
    }
  }, [flushPreview, onError]);

  useEffect(() => {
    if (api.desktop) return;
    const listener = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input,textarea,.shortcut-field') || event.repeat || !work.current.snapshot) return;
      let shortcut: string | null;
      try { shortcut = shortcutFromEvent(event); } catch { return; }
      const config = work.current.snapshot.config;
      const preset = config.presets.find(profile => profile.shortcut && profile.shortcut === shortcut);
      if (preset) {
        event.preventDefault();
        void act({ type: 'selectPreset', payload: preset.id });
      } else if (shortcut === config.settings.toggleShortcut) {
        event.preventDefault();
        void act(snapshot => ({ type: 'setEnabled', payload: !snapshot.enabled }));
      } else if (shortcut === config.settings.cycleShortcut) {
        event.preventDefault();
        void act(snapshot => ({
          type: 'selectPreset',
          payload: snapshot.config.presets[(snapshot.config.presets.findIndex(profile => profile.id === snapshot.config.activePreset) + 1) % snapshot.config.presets.length].id,
        }));
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [act]);

  return { ...view, bootError, edit, act };
}
