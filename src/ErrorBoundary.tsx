import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeError, reportUi } from './diagnostics';

export default class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state: { error: string | null } = { error: null };
  static getDerivedStateFromError(error: unknown) { return { error: describeError(error) }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    reportUi(`React render failed: ${describeError(error)}\n${info.componentStack}`);
  }
  render() {
    if (this.state.error) return <main className="ui-error" role="alert">
      <h1>界面加载失败 / Interface error</h1>
      <p>错误已尝试写入日志。可以重新加载界面，或从托盘恢复设置并退出。</p>
      <p>The error has been reported to the app log. Reload the interface, or restore and quit from the tray.</p>
      <button onClick={() => location.reload()}>重新加载界面 / Reload</button>
      <details><summary>错误详情 / Details</summary><pre>{this.state.error}</pre></details>
    </main>;
    return this.props.children;
  }
}
