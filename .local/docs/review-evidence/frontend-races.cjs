// Review evidence for 5d9ed4e. Reads production functions, mocks IPC / hooks only.
// Run from the repository root: node .local/docs/review-evidence/frontend-races.cjs
// These assertions describe current defects, not the desired future behavior.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const ts = require('typescript');
const source = fs.readFileSync('src/App.tsx', 'utf8').replaceAll('\r\n', '\n');
function extract(start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first);
  assert(first >= 0 && last > first, 'Source changed: update the evidence extraction');
  return source.slice(first, last);
}
const functions = extract('  const applySnapshot =', '  useEffect(() => {\n    let active')
  + '\n' + extract('  const flushPreview =', '  const updateSettings =');
const compiled = ts.transpile(functions, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None });
const tick = () => new Promise(resolve => setImmediate(resolve));
function setup() {
  const profile = { id: 'desktop', name: 'Desktop', shortcut: 'F6', tone: { gamma: 1 }, hardware: {} };
  const initial = { revision: 1, reason: 'ready', config: { activePreset: 'desktop', presets: [profile] }, draft: structuredClone(profile) };
  const ref = value => ({ current: value });
  const observed = { draft: structuredClone(profile), snapshot: initial, commands: [], resolvers: [] };
  const api = { command: operation => {
    observed.commands.push(structuredClone(operation));
    return new Promise(resolve => observed.resolvers.push(resolve));
  } };
  const build = new Function('latest', 'currentDraft', 'previewTimer', 'pendingPreview', 'previewInFlight', 'actionQueue', 'api', 'useCallback', 'setSnapshot', 'setDraft', 'setNotice',
    compiled + '; return { applySnapshot, flushPreview, act, edit };');
  const controls = build(ref(initial), ref(structuredClone(profile)), ref(null), ref(null), ref(Promise.resolve()), ref(Promise.resolve()), api,
    fn => fn, snapshot => observed.snapshot = snapshot, draft => observed.draft = draft, () => {});
  return { initial, observed, controls };
}
async function queuedPreviews() {
  const { initial, observed, controls } = setup();
  for (let i = 1; i <= 6; i++) {
    controls.edit({ ...initial.draft, tone: { gamma: 1 + i / 10 } });
    void controls.flushPreview();
    await tick();
  }
  const off = controls.act({ type: 'setEnabled', payload: false });
  await tick();
  assert.equal(observed.commands.length, 1);
  for (let i = 0; i < 6; i++) {
    observed.resolvers[i]({ ...initial, revision: i + 2, reason: 'preview', draft: observed.commands[i].payload });
    await tick();
  }
  const sequence = observed.commands.map(command => command.type === 'preview' ? command.payload.tone.gamma : 'off');
  assert.deepEqual(sequence, [1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 'off']);
  observed.resolvers[6]({ ...initial, revision: 8, reason: 'updated' });
  await off;
  return sequence;
}
async function staleSaveResponse() {
  const { initial, observed, controls } = setup();
  const profile = gamma => ({ ...initial.draft, tone: { gamma } });
  controls.edit(profile(1.2));
  const first = controls.flushPreview();
  await tick();
  observed.resolvers[0]({ ...initial, revision: 2, reason: 'preview', draft: profile(1.2) });
  await first;
  const saving = controls.act({ type: 'savePreset', payload: 'Desktop' });
  await tick();
  controls.edit(profile(1.5));
  const saved = { ...initial, revision: 3, reason: 'saved', config: { ...initial.config, presets: [profile(1.2)] }, draft: profile(1.2) };
  observed.resolvers[1](saved);
  await saving;
  const preview = controls.flushPreview();
  await tick();
  observed.resolvers[2]({ ...saved, revision: 4, reason: 'preview', draft: profile(1.5) });
  await preview;
  const result = { uiGamma: observed.draft.tone.gamma, backendDraftGamma: observed.snapshot.draft.tone.gamma, savedGamma: observed.snapshot.config.presets[0].tone.gamma };
  assert.deepEqual(result, { uiGamma: 1.2, backendDraftGamma: 1.5, savedGamma: 1.2 });
  return result;
}
function uncommittedInputChangesPreset() {
  const code = ts.transpile(extract('function Range(', 'function CurveGraph('), { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX });
  const hooks = []; let cursor = 0; const pending = [];
  const same = (a, b) => a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const useState = initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = initial; return [hooks[index], value => hooks[index] = value]; };
  const useRef = initial => { const index = cursor++; if (!(index in hooks)) hooks[index] = { current: initial }; return hooks[index]; };
  const useEffect = (fn, dependencies) => { const index = cursor++; if (!same(hooks[index], dependencies)) { hooks[index] = dependencies; pending.push(fn); } };
  const jsx = (type, props) => ({ type, props });
  const Range = new Function('require', 'exports', 'useState', 'useRef', 'useEffect', code + ';return Range;')(() => ({ jsx, jsxs: jsx }), {}, useState, useRef, useEffect);
  const writes = [];
  const render = (value, id) => {
    cursor = 0;
    const result = Range({ label: 'Gamma', value, min: .6, max: 2.2, step: .01, onChange: value => writes.push({ id, value }) });
    pending.splice(0).forEach(fn => fn());
    return result.props.children[1];
  };
  render(1, 'desktop'); let field = render(1, 'desktop');
  field.props.onFocus({ target: { select() {} } });
  field.props.onChange({ target: { value: '1.9' } });
  render(1, 'desktop'); field = render(1.2, 'tarkov');
  assert.equal(field.props.value, '1.9');
  field.props.onBlur();
  assert.deepEqual(writes, [{ id: 'tarkov', value: 1.9 }]);
  return { newPresetGamma: 1.2, uncommittedInput: field.props.value, writes };
}
(async () => {
  console.log(JSON.stringify({ previewBacklog: await queuedPreviews(), saveRace: await staleSaveResponse(), inputAcrossPresets: uncommittedInputChangesPreset() }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
