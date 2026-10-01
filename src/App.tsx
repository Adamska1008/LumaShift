import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Monitor, Crosshair, Keyboard, Settings as SettingsIcon, ArrowLeft, Plus, Sun, Moon, Laptop, Contrast, Palette, RotateCcw, Undo2, ChevronRight, Check, X, Minus, Square, Pencil, Download, Upload, RefreshCw, FolderOpen, Copy, Power, Trash2, SlidersHorizontal, AlertTriangle, LoaderCircle, Eye, Info } from 'lucide-react';
import * as api from './bridge';
import { useAdjustmentSession } from './useAdjustmentSession';
import { version as appVersion } from '../package.json';
import { curve, neutralTone, shortcutFromEvent, shortcutText, type Settings, type Tone } from './types';

type Page = 'adjust' | 'shortcuts' | 'settings';
type Modal = { type: 'create' | 'rename' | 'delete'; value: string } | { type: 'import'; value: string; json: string } | null;
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
  return <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} title={label} disabled={disabled} onClick={onChange}><span /></button>;
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
function ShortcutField({ value, label, onChange, onError, compact = false, emptyLabel, en }: { value: string; label: string; onChange: (value: string) => void; onError: (error: string) => void; compact?: boolean; emptyLabel?: string; en: boolean }) {
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
  }}>{recording ? (en ? 'Press key…' : '请按键…') : value ? shortcutText(value) : (emptyLabel ?? (compact ? '—' : en ? 'Not assigned' : '未设置'))}</button>;
}

export default function App() {
  const [page, setPage] = useState<Page>('adjust');
  const [advanced, setAdvanced] = useState(false);
  const [modal, setModal] = useState<Modal>(null); const [notice, setNotice] = useState('');
  const { snapshot, draft, bootError, edit, act } = useAdjustmentSession(setNotice);
  const [systemDark, setSystemDark] = useState(window.matchMedia('(prefers-color-scheme: dark)').matches);
  const fileInput = useRef<HTMLInputElement>(null); const importScope = useRef('presets');
  const en = snapshot?.config.settings.language === 'en'; const t = (zh: string, english: string) => en ? english : zh;
  useEffect(() => { const mq = window.matchMedia('(prefers-color-scheme: dark)'); const change = () => setSystemDark(mq.matches); mq.addEventListener('change', change); return () => mq.removeEventListener('change', change); }, []);
  useEffect(() => {
    const theme = snapshot?.config.settings.theme ?? 'system';
    document.documentElement.dataset.theme = theme === 'system' ? (systemDark ? 'dark' : 'light') : theme;
    document.documentElement.lang = en ? 'en' : 'zh-CN';
  }, [snapshot?.config.settings.theme, systemDark, en]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 6500); return () => clearTimeout(timer); }, [notice]);
  const updateSettings = (change: Partial<Settings>) => act(s => ({ type: 'saveConfig', payload: { ...s.config, settings: { ...s.config.settings, ...change } } }));
  const setShortcut = (id: string, shortcut: string) => act(s => ({ type: 'saveConfig', payload: { ...s.config, presets: s.config.presets.map(p => p.id === id ? { ...p, shortcut } : p) } }));

  const device = snapshot?.displays.find(d => d.id === snapshot.config.selectedDisplay);
  const saved = snapshot?.config.presets.find(p => p.id === draft?.id);
  const hasSaved = saved?.hasSaved !== false;
  const dirty = !!draft && !!saved && JSON.stringify(draft.tone) !== JSON.stringify(saved.tone);
  const editTone = (key: keyof Tone, value: number) => { if (draft) edit({ ...draft, tone: { ...draft.tone, [key]: value } }); };
  const exportConfig = async (scope: 'all' | 'presets') => { try { if (await api.exportFile(scope)) setNotice(t('已导出保存的配置', 'Saved configuration exported')); } catch (error) { setNotice(String(error)); } };
  const requestImport = (scope: string) => { importScope.current = scope; fileInput.current?.click(); };
  const copyDiagnostics = async () => { try { await navigator.clipboard.writeText(JSON.stringify({ app: 'LumaShift', version: appVersion, mode: api.desktop ? 'desktop' : 'layout-preview', displays: snapshot?.displays, error: snapshot?.error, warnings: snapshot?.warnings, shortcutErrors: snapshot?.shortcutErrors }, null, 2)); setNotice(t('诊断信息已复制', 'Diagnostics copied')); } catch (error) { setNotice(String(error)); } };
  const settingRow = (title: string, control: ReactNode) => <div className="setting-row"><div><strong>{title}</strong></div>{control}</div>;

  return <div className="app-shell">
    <header className="titlebar"><div className="titlebar-drag" onMouseDown={e => { if (e.button === 0) void api.windowAction('drag'); }} onDoubleClick={() => void api.windowAction('maximize')}><img src="/lumashift.svg" alt="" /><span>LumaShift</span><span className="version-tag">{appVersion}</span></div>
      {!api.desktop && <span className="preview-badge">{t('布局预览 · 不修改显示器', 'Layout preview · no display changes')}</span>}
      <div className="window-controls"><button aria-label={t('最小化', 'Minimize')} disabled={!api.desktop} onClick={() => void api.windowAction('minimize')}><Minus size={15} /></button><button aria-label={t('最大化', 'Maximize')} disabled={!api.desktop} onClick={() => void api.windowAction('maximize')}><Square size={13} /></button><button className="close-window" aria-label={t('关闭窗口', 'Close window')} title={snapshot?.config.settings.closeAction === 'quit' ? t('恢复原设置并退出', 'Restore originals & quit') : t('隐藏到托盘', 'Hide to tray')} disabled={!api.desktop} onClick={() => void api.windowAction('close')}><X size={17} /></button></div>
    </header>
    {!snapshot || !draft ? <div className="boot-screen"><img src="/lumashift.svg" alt="" /><h2>LumaShift</h2>{bootError ? <><p>{bootError}</p><button className="primary" onClick={() => location.reload()}>{t('重试', 'Retry')}</button></> : <><LoaderCircle className="spin" /><p>{t('准备你的显示控制台…', 'Preparing your display controls…')}</p></>}</div> : <div className="workspace">
      <aside id="preset-sidebar" aria-label={t('预设', 'Presets')} className="sidebar sidebar-mini">
        <div className="preset-list">{snapshot.config.presets.map((preset, i) => <div className={`preset-row ${preset.id === snapshot.config.activePreset && page === 'adjust' ? 'selected' : ''}`} key={preset.id}>
          <button className="preset-select" aria-label={preset.name} aria-current={preset.id === snapshot.config.activePreset && page === 'adjust' ? 'true' : undefined} title={`${preset.name}${preset.shortcut ? ` · ${shortcutText(preset.shortcut)}` : ''}`} onClick={() => { setPage('adjust'); if (preset.id !== snapshot.config.activePreset) void act({ type: 'selectPreset', payload: preset.id }); }}><span className="preset-number" aria-hidden="true">{i + 1}</span></button>
        </div>)}</div>
        <button className="new-preset" aria-label={t('新建预设', 'New preset')} title={t('新建预设', 'New preset')} onClick={() => setModal({ type: 'create', value: t('自定义预设', 'Custom preset') })}><Plus size={20} /></button>
      </aside>
      <main className={`main ${page === 'adjust' ? 'main-adjust' : 'main-secondary'}`}>
        <div className="notifications">
        {snapshot.recoveryPending && <div className="banner recovery"><AlertTriangle size={19} /><div><strong>{t('上次画面设置等待恢复', 'Previous picture settings need recovery')}</strong><p>{t('应用会先恢复上次保存的原始画面设置，然后再继续。', 'The app will restore the previous original picture settings before continuing.')}</p></div><button disabled={snapshot.busy} onClick={() => void act({ type: 'recover' })}>{snapshot.busy ? t('处理中…', 'Working…') : t('重新检测并恢复', 'Reconnect & restore')}</button><button className="text-button" disabled={snapshot.busy} onClick={() => void act({ type: 'forceQuit' })}>{t('保留记录并退出', 'Keep record & exit')}</button></div>}
        {snapshot.error && <div className="banner error" role="alert"><AlertTriangle size={18} /><span>{snapshot.error}</span></div>}
        {page !== 'shortcuts' && !!snapshot.shortcutErrors.length && <div className="banner warning"><Keyboard size={18} /><span>{t('部分快捷键无法注册，请到设置中的快捷键修改：', 'Some shortcuts could not be registered. Edit them in Settings: ')}{snapshot.shortcutErrors.join(' · ')}</span></div>}
        {!!snapshot.warnings.length && <div className="banner warning"><Info size={18} /><span>{snapshot.warnings.join(' · ')}</span></div>}
        </div>
        {page === 'adjust' && <>
          <div className="page-heading"><div className="preset-heading"><h1>{draft.name}</h1><div className="preset-shortcut"><ShortcutField key={draft.id} en={en} value={saved?.shortcut ?? ''} label={t(`${draft.name} 快捷键`, `${draft.name} shortcut`)} emptyLabel={t('设置快捷键', 'Set shortcut')} onChange={value => void setShortcut(draft.id, value)} onError={setNotice} /></div><button className="icon-button muted" title={t('重命名预设', 'Rename preset')} aria-label={t('重命名预设', 'Rename preset')} onClick={() => setModal({ type: 'rename', value: draft.name })}><Pencil size={16} /></button><button className="icon-button muted" title={snapshot.config.presets.length === 1 ? t('至少保留一个预设', 'Keep at least one preset') : t('删除预设', 'Delete preset')} aria-label={t('删除预设', 'Delete preset')} disabled={snapshot.config.presets.length === 1 || snapshot.busy} onClick={() => setModal({ type: 'delete', value: draft.id })}><Trash2 size={16} /></button><span className={`save-status ${dirty || !hasSaved ? 'unsaved' : ''}`}>{dirty || !hasSaved ? <><span className="dirty-dot" />{t('未保存修改', 'Unsaved changes')}</> : <><Check size={13} />{t('已保存', 'Saved')}</>}</span></div><div className="preset-actions"><Toggle checked={snapshot.enabled} label={t('启用效果', 'Enable effects')} disabled={!device} onChange={() => void act(s => ({ type: 'setEnabled', payload: !s.enabled }))} /><button className="primary save-button" disabled={(!dirty && hasSaved) || snapshot.busy} onClick={() => void act({ type: 'savePreset', payload: draft.name })}><Check size={17} />{t('保存预设', 'Save preset')}</button></div></div>
          {!device && !snapshot.busy ? <div className="empty-device"><Monitor size={42} /><h2>{t('连接一台显示器开始调节', 'Connect a display to get started')}</h2><button onClick={() => void act({ type: 'refresh' })}><RefreshCw size={16} />{t('重新检测', 'Detect again')}</button></div> : <div className="control-grid">
            <section className="panel gamma-panel"><div className="panel-heading"><div><h2>{t('画面调节', 'Picture')}</h2><p>{t('Gamma 曲线', 'Gamma curve')}</p></div><span className="small-badge">SDR</span></div>
              <div className="panel-body gamma-body">
              <CurveGraph tone={draft.tone} label={t('当前参数的 Gamma 曲线示意', 'Gamma curve for the current parameters')} />
              <div className="tone-sliders">{toneFields.slice(0, 3).map(field => <div className="tone-row" key={field.key}><label>{field.label[en ? 1 : 0]}</label><Range label={field.label[en ? 1 : 0]} value={draft.tone[field.key]} min={field.min} max={field.max} step={field.step} disabled={!device?.gammaAvailable} onChange={value => editTone(field.key, value)} /></div>)}
                <div className="tone-row"><label title={t('作用于所有屏幕；100 保持原色', 'Affects all screens; 100 keeps original colors')}>{t('饱和度', 'Saturation')}</label><Range label={t('饱和度', 'Saturation')} value={draft.tone.saturation} min={0} max={200} disabled={!device || !!snapshot.saturationError || snapshot.displays.some(d => d.hdr !== false)} onChange={value => editTone('saturation', value)} /></div>
                {snapshot.saturationError && <div className="saturation-error" role="status"><span title={snapshot.saturationError}>{t('饱和度已暂停', 'Saturation paused')}</span><button className="icon-button" title={t('重试饱和度', 'Retry saturation')} aria-label={t('重试饱和度', 'Retry saturation')} disabled={snapshot.busy} onClick={() => void act({ type: 'retrySaturation' })}><RefreshCw size={14} /></button></div>}
              </div>
              {device && !device.gammaAvailable && <p className="inline-note"><Info size={14} />{device.hdr ? t('HDR / 高级色彩模式下暂停 Gamma 调节', 'Gamma paused in HDR / advanced color mode') : t('当前显示模式或驱动无法提供 Gamma 调节', 'Gamma is unavailable in this display mode or driver')}</p>}
              {advanced && <div className="advanced-controls">{toneFields.slice(3).map(field => <div className="tone-row" key={field.key}><label>{field.label[en ? 1 : 0]}</label><Range label={field.label[en ? 1 : 0]} value={draft.tone[field.key]} min={field.min} max={field.max} step={field.step} disabled={!device?.gammaAvailable} onChange={value => editTone(field.key, value)} /></div>)}</div>}
              </div>
              <div className="panel-actions"><div className="reset-actions"><button className="text-button" disabled={!dirty || snapshot.busy} onClick={() => { if (saved) edit({ ...draft, tone: { ...saved.tone } }); }}><Undo2 size={16} />{t('撤销修改', 'Revert changes')}</button><button className="text-button" onClick={() => edit({ ...draft, tone: { ...neutralTone } })}><RotateCcw size={16} />{t('恢复默认', 'Restore defaults')}</button></div><button className={`text-button disclosure ${advanced ? 'expanded' : ''}`} aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>{t('高级调节', 'Advanced')}<ChevronRight size={17} /></button></div>
            </section>
          </div>}
          <div className="comparison-bar"><div className="segmented compare"><button className={snapshot.comparing ? 'selected' : ''} disabled={!snapshot.enabled} onClick={() => void act({ type: 'compare', payload: true })}><Eye size={15} />{hasSaved ? t('已保存效果', 'Saved') : t('原始效果', 'Original')}</button><button className={!snapshot.comparing ? 'selected' : ''} disabled={!snapshot.enabled} onClick={() => void act({ type: 'compare', payload: false })}>{t('当前效果', 'Current')}</button></div></div>
        </>}
        {page === 'shortcuts' && <div className="secondary-page"><button className="text-button" onClick={() => setPage('settings')}><ArrowLeft size={16} />{t('返回设置', 'Back to settings')}</button><h1>{t('快捷键', 'Keyboard shortcuts')}</h1>
          {!!snapshot.shortcutErrors.length && <div className="banner warning"><AlertTriangle size={18} /><span>{snapshot.shortcutErrors.join(' · ')}</span></div>}
          <section className="settings-group"><div className="group-heading"><Crosshair size={18} /><h2>{t('直接切换预设', 'Jump to a preset')}</h2></div>{snapshot.config.presets.map(p => <div className="shortcut-row" key={p.id}><div><strong>{p.name}</strong></div><ShortcutField en={en} value={p.shortcut} label={`${p.name} shortcut`} onChange={value => void setShortcut(p.id, value)} onError={setNotice} /><button className="icon-button muted" title={t('删除预设', 'Delete preset')} aria-label={t(`删除 ${p.name}`, `Delete ${p.name}`)} disabled={snapshot.config.presets.length === 1 || snapshot.busy} onClick={() => setModal({ type: 'delete', value: p.id })}><Trash2 size={16} /></button></div>)}</section>
          <section className="settings-group"><div className="group-heading"><SlidersHorizontal size={18} /><h2>{t('全局操作', 'Global actions')}</h2></div>
            {settingRow(t('开关效果', 'Toggle effects'), <ShortcutField en={en} value={snapshot.config.settings.toggleShortcut} label={t('开关效果快捷键', 'Toggle shortcut')} onChange={value => void updateSettings({ toggleShortcut: value })} onError={setNotice} />)}
            {settingRow(t('循环预设', 'Cycle presets'), <ShortcutField en={en} value={snapshot.config.settings.cycleShortcut} label={t('循环预设快捷键', 'Cycle shortcut')} onChange={value => void updateSettings({ cycleShortcut: value })} onError={setNotice} />)}
          </section>
        </div>}
        {page === 'settings' && <div className="secondary-page settings-page"><button className="text-button" onClick={() => setPage('adjust')}><ArrowLeft size={16} />{t('返回调节', 'Back to picture')}</button><h1>{t('设置', 'Settings')}</h1>
          <section className="settings-group"><div className="group-heading"><Palette size={18} /><h2>{t('外观', 'Appearance')}</h2></div>
            {settingRow(t('主题', 'Theme'), <div className="segmented theme-picker">{(['light', 'dark', 'system'] as const).map((theme, i) => <button key={theme} className={snapshot.config.settings.theme === theme ? 'selected' : ''} onClick={() => void updateSettings({ theme })}>{[<Sun size={16} />, <Moon size={16} />, <Laptop size={16} />][i]}{[t('浅色', 'Light'), t('深色', 'Dark'), t('系统', 'System')][i]}</button>)}</div>)}
            {settingRow(t('界面语言', 'Language'), <select className="setting-select" aria-label={t('界面语言', 'Language')} value={snapshot.config.settings.language} onChange={e => void updateSettings({ language: e.target.value as 'zh' | 'en' })}><option value="zh">简体中文</option><option value="en">English</option></select>)}
          </section>
          <section className="settings-group"><button className="settings-shortcuts" onClick={() => setPage('shortcuts')}><Keyboard size={18} /><span>{t('快捷键', 'Keyboard shortcuts')}</span><ChevronRight size={18} /></button></section>
          <section className="settings-group"><div className="group-heading"><Power size={18} /><h2>{t('窗口', 'Window')}</h2></div>
            {settingRow(t('关闭窗口时', 'When closing the window'), <select className="setting-select" aria-label={t('关闭窗口时', 'When closing the window')} value={snapshot.config.settings.closeAction} onChange={e => void updateSettings({ closeAction: e.target.value as Settings['closeAction'] })}><option value="tray">{t('隐藏到托盘', 'Hide to tray')}</option><option value="quit">{t('退出程序', 'Quit application')}</option></select>)}
          </section>
          <section className="settings-group"><div className="group-heading"><FolderOpen size={18} /><h2>{t('配置管理', 'Configuration')}</h2></div>
            {settingRow(t('预设', 'Presets'), <div className="button-pair"><button onClick={() => requestImport('presets')}><Upload size={15} />{t('导入', 'Import')}</button><button onClick={() => void exportConfig('presets')}><Download size={15} />{t('导出', 'Export')}</button></div>)}
            {settingRow(t('全部配置', 'All settings'), <div className="button-pair"><button onClick={() => requestImport('all')}><Upload size={15} />{t('导入', 'Import')}</button><button onClick={() => void exportConfig('all')}><Download size={15} />{t('导出', 'Export')}</button></div>)}
          </section>
          <section className="about-row"><div className="about-brand"><img src="/lumashift.svg" alt="" /><div><strong>LumaShift <span>{appVersion}</span></strong></div></div><div className="button-pair"><button title={t('打开日志目录', 'Open log folder')} disabled={!api.desktop} onClick={() => void api.openLogs().catch(error => setNotice(String(error)))}><FolderOpen size={15} />{t('日志', 'Logs')}</button><button onClick={() => void copyDiagnostics()}><Copy size={15} />{t('诊断信息', 'Diagnostics')}</button></div></section>
          <button className="quit-button" onClick={() => void act({ type: 'quit' })}><Power size={16} />{t('恢复原设置并退出', 'Restore originals & quit')}</button>
        </div>}
      </main>
    </div>}
    {snapshot && draft && <footer className="utility-bar">
      <button className={`icon-button ${page !== 'adjust' ? 'active' : ''}`} title={t('设置', 'Settings')} aria-label={t('设置', 'Settings')} aria-pressed={page !== 'adjust'} onClick={() => setPage(page === 'adjust' ? 'settings' : 'adjust')}><SettingsIcon size={20} /></button>
      <span className="utility-status" role="status">{snapshot.busy ? <LoaderCircle size={14} className="spin" /> : <span className={`status-dot ${snapshot.enabled && !snapshot.comparing ? 'on' : ''}`} />}{snapshot.busy ? t('处理中…', 'Working…') : snapshot.comparing ? (hasSaved ? t('正在查看已保存效果', 'Viewing saved preset') : t('正在查看原始效果', 'Viewing the original')) : snapshot.enabled ? t('效果已开启', 'Effects enabled') : t('效果已关闭', 'Effects disabled')}</span>
    </footer>}
    {notice && <div className="toast" role="status"><Info size={17} /><span>{notice}</span><button aria-label={t('关闭提示', 'Dismiss')} onClick={() => setNotice('')}><X size={15} /></button></div>}
    {modal && <div className="modal-backdrop" onClick={() => setModal(null)} onKeyDown={e => { if (e.key === 'Escape') setModal(null); }}><form className="modal" role="dialog" aria-modal="true" aria-label={modal.type === 'create' ? t('新建预设', 'New preset') : modal.type === 'rename' ? t('重命名预设', 'Rename preset') : modal.type === 'delete' ? t('删除预设', 'Delete preset') : t('导入配置', 'Import configuration')} onClick={e => e.stopPropagation()} onSubmit={e => { e.preventDefault();
      if (modal.type === 'import') void act({ type: 'import', payload: { json: modal.json, scope: modal.value } });
      else void act({ type: modal.type === 'create' ? 'createPreset' : modal.type === 'rename' ? 'savePreset' : 'deletePreset', payload: modal.value });
      if (modal.type === 'create') setPage('adjust'); setModal(null);
    }}><h2>{modal.type === 'create' ? t('新建预设', 'New preset') : modal.type === 'rename' ? t('重命名预设', 'Rename preset') : modal.type === 'delete' ? t('删除这个预设？', 'Delete this preset?') : t('导入配置？', 'Import configuration?')}</h2>
      {modal.type === 'delete' && <p><strong>{snapshot?.config.presets.find(p => p.id === modal.value)?.name}</strong></p>}
      {modal.type === 'create' || modal.type === 'rename' ? <><p>{t('使用当前调节值保存。', 'Save using the current adjustments.')}</p><input autoFocus aria-label={t('预设名称', 'Preset name')} maxLength={40} value={modal.value} onChange={e => setModal({ ...modal, value: e.target.value })} onFocus={e => e.target.select()} /></> : <p>{modal.type === 'delete' ? t('删除后无法撤销。如果正在使用，会先恢复原设置。', 'This cannot be undone. Original settings will be restored if this preset is active.') : modal.value === 'all' ? t('这会替换当前配置，并先恢复显示原设置。', 'This replaces your configuration and restores original display settings first.') : t('预设将作为新条目加入，快捷键留空以避免冲突。', 'Presets will be added as new entries, without shortcut assignments.')}</p>}
      <div className="modal-actions"><button type="button" autoFocus={modal.type === 'delete'} onClick={() => setModal(null)}>{t('取消', 'Cancel')}</button><button className={modal.type === 'delete' ? 'danger' : 'primary'} type="submit" disabled={!modal.value.trim() || (modal.type === 'delete' && (!snapshot || snapshot.busy || snapshot.config.presets.length === 1 || !snapshot.config.presets.some(p => p.id === modal.value)))}>{modal.type === 'delete' ? t('删除', 'Delete') : modal.type === 'import' ? t('导入', 'Import') : t('保存', 'Save')}</button></div></form></div>}
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async e => { const file = e.target.files?.[0]; e.target.value = ''; if (!file) return; if (file.size > 1_000_000) { setNotice(t('文件不能超过 1 MB', 'File must be under 1 MB')); return; } try { const json = await file.text(); JSON.parse(json); setModal({ type: 'import', value: importScope.current, json }); } catch { setNotice(t('无法读取有效的 JSON 文件', 'Could not read a valid JSON file')); } }} />
  </div>;
}
