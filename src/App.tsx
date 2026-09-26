import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Monitor, Crosshair, File, Keyboard, Settings as SettingsIcon, Plus, Sun, Moon, Laptop, Contrast, Palette, RotateCcw, ChevronRight, Check, X, Minus, Square, Pencil, Download, Upload, RefreshCw, FolderOpen, Copy, Power, Trash2, SlidersHorizontal, AlertTriangle, LoaderCircle, Eye, Info } from 'lucide-react';
import * as api from './bridge';
import { reportUi, describeError } from './diagnostics';
import { version as appVersion } from '../package.json';
import { curve, neutralTone, shortcutFromEvent, shortcutText, type Config, type Feature, type Operation, type Profile, type Settings, type Snapshot, type Tone } from './types';

type Page = 'adjust' | 'shortcuts' | 'settings';
type Modal = { type: 'create' | 'rename' | 'delete'; value: string } | { type: 'import'; value: string; json: string } | null;
const hardwareLabels: Record<string, [string, string]> = { brightness: ['亮度', 'Brightness'], contrast: ['对比度', 'Contrast'], saturation: ['饱和度', 'Saturation'], sharpness: ['锐度', 'Sharpness'], redGain: ['红色增益', 'Red gain'], greenGain: ['绿色增益', 'Green gain'], blueGain: ['蓝色增益', 'Blue gain'] };
const toneFields: { key: keyof Tone; label: [string, string]; min: number; max: number; step: number }[] = [
  { key: 'gamma', label: ['Gamma', 'Gamma'], min: .6, max: 2.2, step: .01 },
  { key: 'shadows', label: ['暗部提升', 'Shadows'], min: 0, max: 60, step: 1 },
  { key: 'contrast', label: ['画面对比度', 'Contrast'], min: -40, max: 40, step: 1 },
  { key: 'highlights', label: ['高光', 'Highlights'], min: -40, max: 40, step: 1 },
  { key: 'exposure', label: ['曝光', 'Exposure'], min: -.5, max: .5, step: .01 },
  { key: 'temperature', label: ['色温倾向', 'Warmth'], min: -50, max: 50, step: 1 },
  { key: 'blackPoint', label: ['黑位提升', 'Black lift'], min: 0, max: 8, step: .1 },
];

function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: () => void; label: string; disabled?: boolean }) {
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={onChange}><span /></button>;
}
function Range({ label, value, min = 0, max = 100, step = 1, disabled = false, onChange }: { label: string; value: number; min?: number; max?: number; step?: number; disabled?: boolean; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value)); const focused = useRef(false);
  useEffect(() => { if (!focused.current) setText(step < 1 ? value.toFixed(step === .01 ? 2 : 1) : String(value)); }, [value, step]);
  const commit = () => { focused.current = false; const parsed = Number(text); if (text.trim() && Number.isFinite(parsed)) { const v = Math.round(Math.max(min, Math.min(max, parsed)) / step) * step; onChange(Number(v.toFixed(2))); setText(String(Number(v.toFixed(2)))); } else setText(String(value)); };
  return <div className={`range-control ${disabled ? 'disabled' : ''}`}>
    <input className="range" type="range" aria-label={label} min={min} max={max} step={step} value={value} disabled={disabled} onChange={e => onChange(Number(e.target.value))} style={{ '--fill': `${(value - min) / (max - min) * 100}%` } as CSSProperties} />
    <input className="range-value" type="text" inputMode="decimal" aria-label={`${label} value`} value={text} disabled={disabled} onFocus={e => { focused.current = true; e.target.select(); }} onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setText(String(value)); focused.current = false; } }} />
  </div>;
}
function CurveGraph({ tone, label }: { tone: Tone; label: string }) {
  const line = Array.from({ length: 129 }, (_, i) => `${i === 0 ? 'M' : 'L'}${i / 128 * 440},${160 - curve(tone, i / 128) * 160}`).join(' ');
  return <div className="curve-wrap"><svg viewBox="0 0 440 160" role="img" aria-label={label} preserveAspectRatio="none">
    <defs><pattern id="grid" width="44" height="32" patternUnits="userSpaceOnUse"><path d="M 44 0 L 0 0 0 32" fill="none" stroke="currentColor" strokeWidth=".65" /></pattern><linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="var(--accent)" stopOpacity=".10" /><stop offset="100%" stopColor="var(--accent)" stopOpacity="0" /></linearGradient></defs>
    <rect width="440" height="160" fill="url(#grid)" className="graph-grid" /><path d={`${line} L440,160 L0,160Z`} fill="url(#curve-fill)" /><path d="M0,160 L440,0" stroke="var(--muted)" strokeWidth="1" strokeDasharray="4 5" opacity=".45" /><path d={line} fill="none" stroke="var(--accent)" strokeWidth="2.3" vectorEffect="non-scaling-stroke" />
  </svg><div className="graph-labels"><span>0</span><span>128</span><span>255</span></div></div>;
}
function ShortcutField({ value, label, onChange, onError, compact = false, en }: { value: string; label: string; onChange: (value: string) => void; onError: (error: string) => void; compact?: boolean; en: boolean }) {
  const [recording, setRecording] = useState(false);
  const engaged = useRef(false);
  const stop = () => { if (engaged.current) { engaged.current = false; setRecording(false); void api.command({ type: 'captureShortcut', payload: false }).catch(onError); } };
  useEffect(() => { const blur = () => stop(); window.addEventListener('blur', blur); return () => { window.removeEventListener('blur', blur); if (engaged.current) void api.command({ type: 'captureShortcut', payload: false }); }; }, []);
  return <button className={`keycap shortcut-field ${recording ? 'recording' : ''} ${compact ? 'compact' : ''}`} aria-label={label} title={en ? 'Click, then press a key. Backspace clears.' : '点击后按键录入，退格键清除'} onClick={async e => { e.stopPropagation(); engaged.current = true; try { const state = await api.command({ type: 'captureShortcut', payload: true }); if (state.error) throw new Error(state.error); if (engaged.current) setRecording(true); } catch (error) { stop(); onError(String(error)); } }} onBlur={stop} onKeyDown={e => {
    if (!recording) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stop(); return; }
    if (e.key === 'Backspace' || e.key === 'Delete') { stop(); onChange(''); return; }
    try { const shortcut = shortcutFromEvent(e); if (shortcut) { stop(); onChange(shortcut); } } catch (error) { onError(String(error)); stop(); }
  }}>{recording ? (en ? 'Press key…' : '请按键…') : value ? shortcutText(value) : (compact ? '—' : en ? 'Not assigned' : '未设置')}</button>;
}

export default function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Profile | null>(null);
  const [page, setPage] = useState<Page>('adjust');
  const [advanced, setAdvanced] = useState(false); const [moreHardware, setMoreHardware] = useState(false);
  const [modal, setModal] = useState<Modal>(null); const [notice, setNotice] = useState(''); const [bootError, setBootError] = useState('');
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const latest = useRef<Snapshot | null>(null); const currentDraft = useRef<Profile | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null); const pendingPreview = useRef<Profile | null>(null);
  const previewInFlight = useRef<Promise<void>>(Promise.resolve());
  const actionQueue = useRef<Promise<unknown>>(Promise.resolve()); const fileInput = useRef<HTMLInputElement>(null); const importScope = useRef('presets');
  const en = snapshot?.config.settings.language === 'en'; const t = (zh: string, english: string) => en ? english : zh;
  const applySnapshot = useCallback((s: Snapshot) => {
    if (latest.current && s.revision < latest.current.revision) return;
    latest.current = s; setSnapshot(s);
    if (!currentDraft.current || ['ready', 'profile', 'saved'].includes(s.reason)) {
      const next = structuredClone(s.draft); currentDraft.current = next; setDraft(next);
      if (s.reason === 'profile') { pendingPreview.current = null; if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null; }
    } else if (currentDraft.current.id === s.draft.id && currentDraft.current.shortcut !== s.draft.shortcut) {
      const next = { ...currentDraft.current, shortcut: s.draft.shortcut }; currentDraft.current = next; setDraft(next);
    }
  }, []);
  useEffect(() => {
    let active = true; let unsubscribe: (() => void) | undefined;
    void (async () => {
      reportUi('startup: subscribing to backend state');
      const cleanup = await api.subscribe(s => { if (active) applySnapshot(s); });
      if (!active) { cleanup(); return; } unsubscribe = cleanup;
      reportUi('startup: requesting initial state');
      const state = await api.getState(); if (active) applySnapshot(state);
      if (active) reportUi(`startup: state received, revision=${state.revision}, reason=${state.reason}`);
    })().catch(error => { reportUi(`startup failed: ${describeError(error)}`); if (active) setBootError(String(error)); });
    return () => { active = false; unsubscribe?.(); };
  }, [applySnapshot]);
  const reportedReady = useRef(false);
  useEffect(() => {
    if (snapshot && draft && !snapshot.busy && !reportedReady.current) {
      reportedReady.current = true;
      reportUi(`interface mounted; displays=${snapshot.displays.length}, preset=${draft.id}`);
    }
  }, [snapshot, draft]);
  useEffect(() => { const mq = window.matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(mq.matches); mq.addEventListener('change', change); return () => mq.removeEventListener('change', change); }, []);
  useEffect(() => {
    const theme = snapshot?.config.settings.theme ?? 'system';
    document.documentElement.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.lang = en ? 'en' : 'zh-CN';
  }, [snapshot?.config.settings.theme, systemDark, en]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  const flushPreview = useCallback(async () => {
    if (previewTimer.current) clearTimeout(previewTimer.current); previewTimer.current = null;
    const profile = pendingPreview.current; pendingPreview.current = null;
    if (profile) previewInFlight.current = previewInFlight.current.catch(() => {}).then(async () => { applySnapshot(await api.command({ type: 'preview', payload: profile })); });
    await previewInFlight.current;
  }, [applySnapshot]);
  const act = useCallback((operation: Operation | ((s: Snapshot) => Operation)) => {
    actionQueue.current = actionQueue.current.catch(() => {}).then(async () => {
      await flushPreview();
      if (!latest.current) return;
      const result = await api.command(typeof operation === 'function' ? operation(latest.current) : operation);
      applySnapshot(result);
    }).catch(error => setNotice(String(error)));
    return actionQueue.current;
  }, [applySnapshot, flushPreview]);
  const edit = (next: Profile) => {
    currentDraft.current = next; setDraft(next); pendingPreview.current = next;
    if (!previewTimer.current) previewTimer.current = setTimeout(() => { void flushPreview().catch(error => setNotice(String(error))); }, 90);
  };
  const updateSettings = (change: Partial<Settings>) => act(s => ({ type: 'saveConfig', payload: { ...s.config, settings: { ...s.config.settings, ...change } } }));
  const setShortcut = (id: string, shortcut: string) => act(s => ({ type: 'saveConfig', payload: { ...s.config, presets: s.config.presets.map(p => p.id === id ? { ...p, shortcut } : p) } }));
  const cycle = () => act(s => ({ type: 'selectPreset', payload: s.config.presets[(s.config.presets.findIndex(p => p.id === s.config.activePreset) + 1) % s.config.presets.length].id }));
  useEffect(() => {
    if (api.desktop) return;
    const listener = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement)?.closest('input,textarea,.shortcut-field') || event.repeat || !latest.current) return;
      let shortcut: string | null; try { shortcut = shortcutFromEvent(event); } catch { return; }
      const config = latest.current.config; const preset = config.presets.find(p => p.shortcut && p.shortcut === shortcut);
      if (preset) { event.preventDefault(); void act({ type: 'selectPreset', payload: preset.id }); }
      else if (shortcut === config.settings.toggleShortcut) { event.preventDefault(); void act(s => ({ type: 'setEnabled', payload: !s.enabled })); }
      else if (shortcut === config.settings.cycleShortcut) { event.preventDefault(); void act(s => ({ type: 'selectPreset', payload: s.config.presets[(s.config.presets.findIndex(p => p.id === s.config.activePreset) + 1) % s.config.presets.length].id })); }
    };
    window.addEventListener('keydown', listener); return () => window.removeEventListener('keydown', listener);
  }, [act]);

  const device = snapshot?.displays.find(d => d.id === snapshot.config.selectedDisplay);
  const saved = snapshot?.config.presets.find(p => p.id === draft?.id);
  const dirty = !!draft && !!saved && (JSON.stringify(draft.tone) !== JSON.stringify(saved.tone) || JSON.stringify(draft.hardware) !== JSON.stringify(saved.hardware) || (draft.hardwareEnabled !== false) !== (saved.hardwareEnabled !== false));
  const editTone = (key: keyof Tone, value: number) => { if (draft) edit({ ...draft, tone: { ...draft.tone, [key]: value } }); };
  const editHardware = (key: string, value?: number) => { if (!draft) return; const hardware = { ...draft.hardware }; if (value === undefined) delete hardware[key]; else hardware[key] = value; edit({ ...draft, hardware }); };
  const statusText = (feature: Feature) => feature.status === 'unsupported' ? t('未提供此控制', 'Not supported') : feature.status === 'unavailable' ? t('当前不可用', 'Currently unavailable') : t('未能读取', 'Could not read');
  const hardwareRow = (feature: Feature) => {
    const label = hardwareLabels[feature.key]?.[en ? 1 : 0] ?? feature.key; const supported = feature.status === 'available'; const hardwareEnabled = draft?.hardwareEnabled !== false; const included = !!draft && feature.key in draft.hardware;
    const Icon = feature.key === 'brightness' ? Sun : feature.key === 'contrast' ? Contrast : feature.key === 'saturation' ? Palette : SlidersHorizontal;
    return <div className={`hardware-row ${!supported ? 'unavailable' : ''}`} key={feature.key}>
      <div className="hardware-label"><Icon size={21} className={feature.key === 'saturation' ? 'color-icon' : ''} /><span>{label}</span>
        {supported ? <label className={`include-control ${included ? 'included' : ''}`} title={t('此参数是否随预设一起应用', 'Include this parameter in the preset')}><input type="checkbox" aria-label={t(`将${label}加入预设`, `Include ${label} in preset`)} checked={included} disabled={!hardwareEnabled} onChange={e => editHardware(feature.key, e.target.checked ? feature.value ?? 50 : undefined)} /><span>{included ? t('随预设', 'Included') : t('不改变', 'Unchanged')}</span></label> : <span className="unavailable-label" title={feature.detail}>{statusText(feature)}</span>}
      </div>
      {supported && draft && <Range label={label} disabled={!hardwareEnabled} value={draft.hardware[feature.key] ?? feature.value ?? 50} onChange={value => editHardware(feature.key, value)} />}
    </div>;
  };
  const exportConfig = async (scope: 'all' | 'presets') => { try { if (await api.exportFile(scope)) setNotice(t('已导出保存的配置', 'Saved configuration exported')); } catch (error) { setNotice(String(error)); } };
  const requestImport = (scope: string) => { importScope.current = scope; fileInput.current?.click(); };
  const copyDiagnostics = async () => { try { await navigator.clipboard.writeText(JSON.stringify({ app: 'LumaShift', version: appVersion, mode: api.desktop ? 'desktop' : 'layout-preview', displays: snapshot?.displays, error: snapshot?.error, warnings: snapshot?.warnings, shortcutErrors: snapshot?.shortcutErrors }, null, 2)); setNotice(t('诊断信息已复制', 'Diagnostics copied')); } catch (error) { setNotice(String(error)); } };
  const settingRow = (title: string, description: string, control: ReactNode) => <div className="setting-row"><div><strong>{title}</strong><p>{description}</p></div>{control}</div>;

  return <div className="app-shell">
    <header className="titlebar"><div className="titlebar-drag" onMouseDown={e => { if (e.button === 0) void api.windowAction('drag'); }} onDoubleClick={() => void api.windowAction('maximize')}><img src="/lumashift.svg" alt="" /><span>LumaShift</span><span className="version-tag">{appVersion}</span></div>
      {!api.desktop && <span className="preview-badge">{t('布局预览 · 不修改显示器', 'Layout preview · no display changes')}</span>}
      <div className="window-controls"><button aria-label={t('最小化', 'Minimize')} disabled={!api.desktop} onClick={() => void api.windowAction('minimize')}><Minus size={15} /></button><button aria-label={t('最大化', 'Maximize')} disabled={!api.desktop} onClick={() => void api.windowAction('maximize')}><Square size={13} /></button><button className="close-window" aria-label={t('关闭到托盘', 'Close to tray')} title={t('关闭到托盘，效果继续保持', 'Close to tray and keep effects active')} disabled={!api.desktop} onClick={() => void api.windowAction('close')}><X size={17} /></button></div>
    </header>
    {!snapshot || !draft ? <div className="boot-screen"><img src="/lumashift.svg" alt="" /><h2>LumaShift</h2>{bootError ? <><p>{bootError}</p><button className="primary" onClick={() => location.reload()}>{t('重试', 'Retry')}</button></> : <><LoaderCircle className="spin" /><p>{t('准备你的显示控制台…', 'Preparing your display controls…')}</p></>}</div> : <div className="workspace">
      <aside className="sidebar"><div className="sidebar-heading"><span>{t('预设', 'PRESETS')}</span><span>{snapshot.config.presets.length.toString().padStart(2, '0')}</span></div>
        <div className="preset-list">{snapshot.config.presets.map((preset, i) => <div className={`preset-row ${preset.id === snapshot.config.activePreset && page === 'adjust' ? 'selected' : ''}`} key={preset.id}>
          <button className="preset-select" onClick={() => { setPage('adjust'); if (preset.id !== snapshot.config.activePreset) void act({ type: 'selectPreset', payload: preset.id }); }}><span>{i === 0 ? <Monitor size={21} /> : preset.id === 'tarkov' ? <Crosshair size={21} /> : <File size={20} />}</span><span className="preset-name">{preset.name}</span>{preset.id === draft.id && dirty && <span className="dirty-dot" />}</button>
          <ShortcutField compact en={en} value={preset.shortcut} label={t(`${preset.name} 快捷键`, `${preset.name} shortcut`)} onChange={value => void setShortcut(preset.id, value)} onError={setNotice} />
        </div>)}</div>
        <button className="new-preset" onClick={() => setModal({ type: 'create', value: t('自定义预设', 'Custom preset') })}><Plus size={20} />{t('新建预设', 'New preset')}</button>
        <div className="sidebar-bottom"><button className={`nav-item ${page === 'shortcuts' ? 'active' : ''}`} onClick={() => setPage('shortcuts')}><Keyboard size={20} />{t('快捷键', 'Shortcuts')}</button><button className={`nav-item ${page === 'settings' ? 'active' : ''}`} onClick={() => setPage('settings')}><SettingsIcon size={20} />{t('设置', 'Settings')}</button><div className="sidebar-foot"><span className={`status-dot ${snapshot.enabled && !snapshot.comparing ? 'on' : ''}`} />{snapshot.enabled && !snapshot.comparing ? t('效果运行中', 'Effects active') : t('Gamma 未启用', 'Gamma inactive')}</div></div>
      </aside>
      <main className={`main ${page === 'adjust' ? 'main-adjust' : 'main-secondary'}`}>
        <div className="notifications">
        {snapshot.recoveryPending && <div className="banner recovery"><AlertTriangle size={19} /><div><strong>{snapshot.gammaRecoveryPending ? t('上次 Gamma 设置等待恢复', 'Previous Gamma settings need recovery') : t('部分显示器控制已暂停，Gamma 可继续使用', 'Some monitor controls are paused; Gamma is still available')}</strong><p>{snapshot.gammaRecoveryPending ? t('开启效果时会先单独恢复 Gamma。硬件参数的恢复记录独立保留。', 'Enabling effects first restores Gamma independently. Hardware originals are kept separately.') : t('失败的硬件项已停用，原值仍有记录。可继续调整 Gamma、切换预设；连接并唤醒显示器后可重试硬件恢复。', 'Failed controls are disabled and originals retained. Continue adjusting Gamma or switching presets; reconnect and wake the monitor to retry hardware recovery.')}</p></div><button disabled={snapshot.busy} onClick={() => void act({ type: 'recover' })}>{snapshot.busy ? t('处理中…', 'Working…') : t('重新检测并恢复', 'Reconnect & restore')}</button><button className="text-button" disabled={snapshot.busy} onClick={() => void act({ type: 'forceQuit' })}>{t('保留记录并退出', 'Keep record & exit')}</button></div>}
        {snapshot.error && <div className="banner error" role="alert"><AlertTriangle size={18} /><span>{snapshot.error}</span></div>}
        {page !== 'shortcuts' && !!snapshot.shortcutErrors.length && <div className="banner warning"><Keyboard size={18} /><span>{t('部分快捷键无法注册，请到快捷键页修改：', 'Some shortcuts could not be registered. Edit them in Shortcuts: ')}{snapshot.shortcutErrors.join(' · ')}</span></div>}
        {!!snapshot.warnings.length && <div className="banner warning"><Info size={18} /><span>{snapshot.warnings.join(' · ')}</span></div>}
        </div>
        {page === 'adjust' && <>
          <div className="toolbar"><div className="display-select"><Monitor size={21} /><select aria-label={t('目标显示器', 'Target display')} value={snapshot.config.selectedDisplay ?? ''} disabled={!snapshot.displays.length} onChange={e => void act({ type: 'selectDisplay', payload: e.target.value })}>{!snapshot.displays.length && <option value="">{snapshot.busy ? t('正在检测显示器…', 'Detecting displays…') : t('没有检测到显示器', 'No displays detected')}</option>}{snapshot.displays.map((d, i) => <option key={d.id} value={d.id}>{i + 1} · {d.name}{d.primary ? t(' · 主显示器', ' · Primary') : ''}</option>)}</select></div>
            <div className="master-switch"><Toggle checked={snapshot.enabled} label={t('启用效果', 'Enable effects')} disabled={!device} onChange={() => void act(s => ({ type: 'setEnabled', payload: !s.enabled }))} /><span>{snapshot.enabled ? t('效果已开启', 'Effects enabled') : t('效果已关闭', 'Effects disabled')}</span></div>
          </div>
          <div className="page-heading"><div className="preset-heading"><h1>{draft.name}</h1><button className="icon-button muted" title={t('重命名预设', 'Rename preset')} aria-label={t('重命名预设', 'Rename preset')} onClick={() => setModal({ type: 'rename', value: draft.name })}><Pencil size={16} /></button><span className={`save-status ${dirty ? 'unsaved' : ''}`}>{dirty ? <><span className="dirty-dot" />{t('未保存修改', 'Unsaved changes')}</> : <><Check size={13} />{t('已保存', 'Saved')}</>}</span></div><button className="primary save-button" disabled={!dirty || snapshot.busy} onClick={() => void act({ type: 'savePreset', payload: draft.name })}><Check size={17} />{t('保存预设', 'Save preset')}</button></div>
          {!device && !snapshot.busy ? <div className="empty-device"><Monitor size={42} /><h2>{t('连接一台显示器开始调节', 'Connect a display to get started')}</h2><button onClick={() => void act({ type: 'refresh' })}><RefreshCw size={16} />{t('重新检测', 'Detect again')}</button></div> : <div className="control-grid">
            <section className="panel gamma-panel"><div className="panel-heading"><div><h2>{t('画面调节', 'Picture')}</h2><p>{t('Gamma 曲线', 'Gamma curve')}</p></div><span className="small-badge">SDR</span></div>
              <div className="panel-body gamma-body">
              <CurveGraph tone={draft.tone} label={t('当前参数的 Gamma 曲线示意', 'Gamma curve for the current parameters')} />
              <div className="tone-sliders">{toneFields.slice(0, 3).map(field => <div className="tone-row" key={field.key}><label>{field.label[en ? 1 : 0]}</label><Range label={field.label[en ? 1 : 0]} value={draft.tone[field.key]} min={field.min} max={field.max} step={field.step} disabled={!device?.gammaAvailable} onChange={value => editTone(field.key, value)} /></div>)}</div>
              {device && !device.gammaAvailable && <p className="inline-note"><Info size={14} />{device.hdr ? t('HDR / 高级色彩模式下暂停 Gamma 调节', 'Gamma paused in HDR / advanced color mode') : t('当前显示模式或驱动无法提供 Gamma 调节', 'Gamma is unavailable in this display mode or driver')}</p>}
              {advanced && <div className="advanced-controls">{toneFields.slice(3).map(field => <div className="tone-row" key={field.key}><label>{field.label[en ? 1 : 0]}</label><Range label={field.label[en ? 1 : 0]} value={draft.tone[field.key]} min={field.min} max={field.max} step={field.step} disabled={!device?.gammaAvailable} onChange={value => editTone(field.key, value)} /></div>)}</div>}
              </div>
              <div className="panel-actions"><button className="text-button" onClick={() => edit({ ...draft, tone: { ...neutralTone } })}><RotateCcw size={16} />{t('重置画面参数', 'Reset picture')}</button><button className={`text-button disclosure ${advanced ? 'expanded' : ''}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t('高级调节', 'Advanced')}<ChevronRight size={17} /></button></div>
            </section>
            <section className="panel hardware-panel"><div className="panel-heading"><div><h2>{t('显示器', 'Monitor')}</h2><p>{t('调整显示器自身参数', 'Controls on your physical monitor')}</p></div><Toggle label={t('此预设使用显示器参数', 'Use monitor controls in this preset')} checked={draft.hardwareEnabled !== false} onChange={() => edit({ ...draft, hardwareEnabled: draft.hardwareEnabled === false })} /></div>
              <div className="panel-body hardware-body">
              <p className="inline-note">{draft.hardwareEnabled === false ? t('仅调整 Gamma；显示器参数保持当前值。', 'Gamma only; monitor settings stay unchanged.') : t('只应用勾选且可用的参数；失败的控制自动暂停。', 'Apply only included, available controls; failed controls pause automatically.')}</p>
              <div className="hardware-controls">{device?.features.slice(0, 3).map(hardwareRow)}</div>
              {!device && <div className="device-loading"><LoaderCircle className="spin" size={22} /><p>{t('读取显示器能力…', 'Reading monitor capabilities…')}</p></div>}
              {moreHardware && <div className="more-hardware">{device?.features.slice(3).map(hardwareRow)}</div>}
              </div>
              <button className={`more-link ${moreHardware ? 'expanded' : ''}`} aria-expanded={moreHardware} onClick={() => setMoreHardware(!moreHardware)}>{t('更多显示器选项', 'More monitor controls')}<ChevronRight size={18} /></button>
              <div className="hardware-footer"><span className={`status-dot ${device?.features.some(f => f.status === 'available') ? 'on' : ''}`} /><span>{device?.features.some(f => f.status === 'available') ? t('硬件控制可用', 'Hardware controls available') : t('硬件控制未就绪', 'Hardware controls unavailable')}</span><button className="icon-button" title={t('重新检测能力，会先恢复原设置', 'Refresh capabilities after restoring originals')} aria-label={t('重新检测显示器', 'Refresh displays')} disabled={snapshot.busy} onClick={() => void act({ type: 'refresh' })}><RefreshCw size={14} className={snapshot.busy ? 'spin' : ''} /></button></div>
            </section>
          </div>}
          <div className="comparison-bar"><div className="live-status">{snapshot.busy ? <LoaderCircle size={14} className="spin" /> : <span className={`status-dot ${snapshot.enabled && !snapshot.comparing ? 'on' : ''}`} />}<span>{snapshot.busy ? t('正在应用…', 'Applying…') : snapshot.comparing ? t('正在查看原始效果', 'Viewing the original') : snapshot.enabled ? t('调整即时生效', 'Changes apply live') : t('开启效果后实时生效', 'Enable effects for live adjustment')}</span></div><div className="segmented compare"><button className={snapshot.comparing ? 'selected' : ''} disabled={!snapshot.enabled} onClick={() => void act({ type: 'compare', payload: true })}><Eye size={15} />{t('原始效果', 'Original')}</button><button className={!snapshot.comparing ? 'selected' : ''} disabled={!snapshot.enabled} onClick={() => void act({ type: 'compare', payload: false })}>{t('当前效果', 'Current')}</button></div></div>
          <footer className="shortcut-footer"><button className="hint-action" onClick={() => void act(s => ({ type: 'setEnabled', payload: !s.enabled }))}>{t('开关效果', 'Toggle effects')}<kbd>{shortcutText(snapshot.config.settings.toggleShortcut) || '—'}</kbd></button><span className="divider" /><button className="hint-action" onClick={cycle}>{t('循环预设', 'Cycle presets')}<kbd>{shortcutText(snapshot.config.settings.cycleShortcut) || '—'}</kbd></button><button className="text-button configure-shortcuts" onClick={() => setPage('shortcuts')}><Keyboard size={16} />{t('配置快捷键', 'Edit shortcuts')}</button></footer>
        </>}
        {page === 'shortcuts' && <div className="secondary-page"><div className="section-kicker">{t('触手可及', 'AT YOUR FINGERTIPS')}</div><h1>{t('快捷键', 'Keyboard shortcuts')}</h1><p className="page-description">{t('留在游戏里，一键切换你的画面。', 'Stay in the game. Change your view with a single key.')}</p>
          {!!snapshot.shortcutErrors.length && <div className="banner warning"><AlertTriangle size={18} /><span>{snapshot.shortcutErrors.join(' · ')}</span></div>}
          <section className="settings-group"><div className="group-heading"><Crosshair size={18} /><h2>{t('直接切换预设', 'Jump to a preset')}</h2></div>{snapshot.config.presets.map(p => <div className="shortcut-row" key={p.id}><div><strong>{p.name}</strong><p>{t('应用此预设，保留其他预设未保存的调整', 'Apply this preset; keep unsaved edits in this session')}</p></div><ShortcutField en={en} value={p.shortcut} label={`${p.name} shortcut`} onChange={value => void setShortcut(p.id, value)} onError={setNotice} /><button className="icon-button muted" title={t('删除预设', 'Delete preset')} aria-label={t(`删除 ${p.name}`, `Delete ${p.name}`)} disabled={snapshot.config.presets.length === 1} onClick={() => setModal({ type: 'delete', value: p.id })}><Trash2 size={16} /></button></div>)}</section>
          <section className="settings-group"><div className="group-heading"><SlidersHorizontal size={18} /><h2>{t('全局操作', 'Global actions')}</h2></div>
            {settingRow(t('开关效果', 'Toggle effects'), t('关闭时恢复调整前的显示状态', 'Restore original display settings when disabled'), <ShortcutField en={en} value={snapshot.config.settings.toggleShortcut} label={t('开关效果快捷键', 'Toggle shortcut')} onChange={value => void updateSettings({ toggleShortcut: value })} onError={setNotice} />)}
            {settingRow(t('循环预设', 'Cycle presets'), t('按列表顺序切换到下一个预设', 'Switch to the next preset in the list'), <ShortcutField en={en} value={snapshot.config.settings.cycleShortcut} label={t('循环预设快捷键', 'Cycle shortcut')} onChange={value => void updateSettings({ cycleShortcut: value })} onError={setNotice} />)}
          </section><div className="help-card"><Keyboard size={20} /><div><strong>{t('点击快捷键字段，然后按下你想使用的按键', 'Click a shortcut field, then press your preferred keys')}</strong><p>{t('支持单个 F 键或组合键。退格键清除，Esc 取消；F12 为 Windows 保留。请避开游戏内已有绑定。', 'Use an F key or a key combination. Backspace clears; Esc cancels. F12 is reserved by Windows. Avoid existing in-game bindings.')}</p></div></div>
        </div>}
        {page === 'settings' && <div className="secondary-page settings-page"><div className="section-kicker">{t('按你的习惯', 'MAKE IT YOURS')}</div><h1>{t('设置', 'Settings')}</h1><p className="page-description">{t('让 LumaShift 融入你的桌面。设置会自动保存。', 'Make LumaShift at home on your desktop. Settings save automatically.')}</p>
          <section className="settings-group"><div className="group-heading"><Palette size={18} /><h2>{t('外观', 'Appearance')}</h2></div>
            {settingRow(t('主题', 'Theme'), t('选择喜欢的外观，或跟随系统', 'Choose an appearance or follow your system'), <div className="segmented theme-picker">{(['light', 'dark', 'system'] as const).map((theme, i) => <button key={theme} className={snapshot.config.settings.theme === theme ? 'selected' : ''} onClick={() => void updateSettings({ theme })}>{[<Sun size={16} />, <Moon size={16} />, <Laptop size={16} />][i]}{[t('浅色', 'Light'), t('深色', 'Dark'), t('系统', 'System')][i]}</button>)}</div>)}
            {settingRow(t('界面语言', 'Language'), t('切换后立即生效', 'Applied immediately'), <select className="setting-select" aria-label={t('界面语言', 'Language')} value={snapshot.config.settings.language} onChange={e => void updateSettings({ language: e.target.value as 'zh' | 'en' })}><option value="zh">简体中文</option><option value="en">English</option></select>)}
          </section>
          <section className="settings-group"><div className="group-heading"><Power size={18} /><h2>{t('启动与后台', 'Launch & background')}</h2></div>
            {settingRow(t('启动后进入托盘', 'Start minimized to tray'), t('手动打开应用时，先在后台运行', 'Keep the main window hidden when you launch the app'), <Toggle label={t('启动后进入托盘', 'Start minimized to tray')} checked={snapshot.config.settings.startMinimized} onChange={() => void updateSettings({ startMinimized: !snapshot.config.settings.startMinimized })} />)}
            {settingRow(t('自动应用上次预设', 'Apply last preset on launch'), t('打开应用时，应用上次保存的预设', 'Apply the last saved preset when launching the app'), <Toggle label={t('自动应用上次预设', 'Apply last preset on launch')} checked={snapshot.config.settings.applyLastOnStart} onChange={() => void updateSettings({ applyLastOnStart: !snapshot.config.settings.applyLastOnStart })} />)}
            <p className="group-note">{t('关闭窗口会收进托盘；选择“退出”会先恢复原设置。', 'Closing the window keeps it in the tray. Quitting restores original settings first.')}</p>
          </section>
          <section className="settings-group"><div className="group-heading"><FolderOpen size={18} /><h2>{t('配置管理', 'Configuration')}</h2></div>
            {settingRow(t('预设', 'Presets'), t('备份或分享已保存的调色方案', 'Back up or share your saved presets'), <div className="button-pair"><button onClick={() => requestImport('presets')}><Upload size={15} />{t('导入', 'Import')}</button><button onClick={() => void exportConfig('presets')}><Download size={15} />{t('导出', 'Export')}</button></div>)}
            {settingRow(t('全部配置', 'All settings'), t('包含预设、快捷键和应用偏好', 'Includes presets, shortcuts and app preferences'), <div className="button-pair"><button onClick={() => requestImport('all')}><Upload size={15} />{t('导入', 'Import')}</button><button onClick={() => void exportConfig('all')}><Download size={15} />{t('导出', 'Export')}</button></div>)}
          </section>
          <section className="settings-group"><div className="group-heading"><Monitor size={18} /><h2>{t('显示器能力', 'Display capabilities')}</h2><button className="text-button push-right" disabled={snapshot.busy} onClick={() => void act({ type: 'refresh' })}><RefreshCw size={15} className={snapshot.busy ? 'spin' : ''} />{t('重新检测', 'Refresh')}</button></div><p className="device-name">{device?.name ?? t('未连接显示器', 'No display connected')}</p>
            <div className="capability-grid"><div><span>Gamma / SDR</span><span className={device?.gammaAvailable ? 'cap-yes' : 'muted'}>{device?.gammaAvailable ? t('可用', 'Available') : t('不可用', 'Unavailable')}</span></div>{device?.features.map(feature => <div key={feature.key} title={feature.detail}><span>{hardwareLabels[feature.key]?.[en ? 1 : 0]}</span><span className={feature.status === 'available' ? 'cap-yes' : 'muted'}>{feature.status === 'available' ? t('可用', 'Available') : statusText(feature)}</span></div>)}</div>
          </section>
          <section className="about-row"><div className="about-brand"><img src="/lumashift.svg" alt="" /><div><strong>LumaShift <span>{appVersion}</span></strong><p>{t('让画面，恰到好处。', 'Your display. Your balance.')}</p></div></div><div className="button-pair"><button title={t('打开日志目录', 'Open log folder')} disabled={!api.desktop} onClick={() => void api.openLogs().catch(error => setNotice(String(error)))}><FolderOpen size={15} />{t('日志', 'Logs')}</button><button onClick={() => void copyDiagnostics()}><Copy size={15} />{t('诊断信息', 'Diagnostics')}</button></div></section>
          <button className="quit-button" onClick={() => void act({ type: 'quit' })}><Power size={16} />{t('恢复原设置并退出', 'Restore originals & quit')}</button>
        </div>}
      </main>
    </div>}
    {notice && <div className="toast" role="status"><Info size={17} /><span>{notice}</span><button aria-label={t('关闭提示', 'Dismiss')} onClick={() => setNotice('')}><X size={15} /></button></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)} onKeyDown={e => { if (e.key === 'Escape') setModal(null); }}><form className="modal" role="dialog" aria-modal="true" aria-label={modal.type === 'create' ? t('新建预设', 'New preset') : modal.type === 'rename' ? t('重命名预设', 'Rename preset') : modal.type === 'delete' ? t('删除预设', 'Delete preset') : t('导入配置', 'Import configuration')} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault();
      if (modal.type === 'import') void act({ type: 'import', payload: { json: modal.json, scope: modal.value } });
      else void act({ type: modal.type === 'create' ? 'createPreset' : modal.type === 'rename' ? 'savePreset' : 'deletePreset', payload: modal.value });
      if (modal.type === 'create') setPage('adjust'); setModal(null);
    }}><h2>{modal.type === 'create' ? t('新建预设', 'New preset') : modal.type === 'rename' ? t('重命名预设', 'Rename preset') : modal.type === 'delete' ? t('删除这个预设？', 'Delete this preset?') : t('导入配置？', 'Import configuration?')}</h2>
      {modal.type === 'create' || modal.type === 'rename' ? <><p>{t('使用当前调节值保存。', 'Save using the current adjustments.')}</p><input autoFocus aria-label={t('预设名称', 'Preset name')} maxLength={40} value={modal.value} onChange={e => setModal({ ...modal, value: e.target.value })} onFocus={e => e.target.select()} /></> : <p>{modal.type === 'delete' ? t('删除后无法撤销。如果正在使用，会先恢复原设置。', 'This cannot be undone. Original settings will be restored if this preset is active.') : modal.value === 'all' ? t('这会替换当前配置，并先恢复显示原设置。', 'This replaces your configuration and restores original display settings first.') : t('预设将作为新条目加入，快捷键留空以避免冲突。', 'Presets will be added as new entries, without shortcut assignments.')}</p>}
      <div className="modal-actions"><button type="button" onClick={() => setModal(null)}>{t('取消', 'Cancel')}</button><button className={modal.type === 'delete' ? 'danger' : 'primary'} type="submit" disabled={!modal.value.trim()}>{modal.type === 'delete' ? t('删除', 'Delete') : modal.type === 'import' ? t('导入', 'Import') : t('保存', 'Save')}</button></div></form></div>}
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; if (file.size > 1_000_000) { setNotice(t('文件不能超过 1 MB', 'File must be under 1 MB')); return; } try { const json = await file.text(); JSON.parse(json); setModal({ type: 'import', value: importScope.current, json }); } catch { setNotice(t('无法读取有效的 JSON 文件', 'Could not read a valid JSON file')); } }} />
  </div>;
}
