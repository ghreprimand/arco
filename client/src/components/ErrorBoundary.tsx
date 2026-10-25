import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

// App-wide render guard. Until now a single component hitting an uncaught
// render error (e.g. React #185 "maximum update depth exceeded") unmounted the
// WHOLE tree and left a black screen — the operator lost access to every tab,
// not just the broken one. This boundary contains the failure to the active
// content region so SystemHeader + TabBar stay alive and the operator can
// switch to a working tab. The fallback surfaces the component stack so the
// failing component is identifiable from a screenshot (readable in a non-
// minified build). Keyed by active tab upstream: changing tabs remounts the
// boundary, clearing the error for the new (working) view.
interface Props {
  children: ReactNode;
  label?: string;
}
interface State {
  error: Error | null;
  componentStack: string | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? null });
    // Surface to the console too, so it lands in any log capture.
    console.error('[archon] render boundary caught:', error, info.componentStack);
  }

  private reset = () => this.setState({ error: null, componentStack: null });

  render(): ReactNode {
    const { error, componentStack } = this.state;
    if (!error) return this.props.children;
    return (
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflow: 'auto',
          padding: '24px',
          fontFamily: 'var(--font-code)',
          color: 'var(--color-fg)',
        }}
      >
        <div
          className="display-font"
          style={{ color: 'var(--color-danger)', fontSize: '13px', letterSpacing: '1.5px', marginBottom: '10px' }}
        >
          THIS VIEW HIT A RENDER ERROR
        </div>
        <div style={{ fontSize: '12px', color: 'var(--color-fg-muted)', marginBottom: '14px', lineHeight: 1.5 }}>
          The rest of Arco is fine — your tabs and data are intact. Switch to another
          tab in the bar above, or click below to retry this one.
        </div>
        <button
          type="button"
          onClick={this.reset}
          className="display-font"
          style={{
            fontSize: '10px',
            letterSpacing: '1px',
            color: 'var(--color-accent-primary)',
            background: 'transparent',
            border: '1px solid var(--color-accent-primary)',
            padding: '5px 12px',
            cursor: 'pointer',
            marginBottom: '16px',
          }}
        >
          RETRY THIS VIEW
        </button>
        <pre
          style={{
            fontSize: '11px',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--color-danger)',
            margin: 0,
            marginBottom: '12px',
          }}
        >
          {error.message}
        </pre>
        {componentStack && (
          <pre
            style={{
              fontSize: '10px',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              color: 'var(--color-fg-muted)',
              margin: 0,
            }}
          >
            {componentStack}
          </pre>
        )}
      </div>
    );
  }
}
