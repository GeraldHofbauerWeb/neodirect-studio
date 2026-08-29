/**
 * Keeps one panel's mistake from being the whole studio's.
 *
 * Without this, a single throw anywhere below the rail unmounts the tree and leaves a black
 * rectangle: no rail, no transport, no way back, and nothing on screen that says what happened —
 * a stack trace in a console nobody has open. That is a bad trade for a tool that is often looked
 * at while something else is being recorded.
 *
 * So the blast radius stops here. The panel says what it hit, the rest of the studio keeps
 * working, and switching panels clears it, because the boundary is keyed by which panel is showing.
 */

import { Component, type ReactNode } from 'react';

export class Boundary extends Component<{ what: string; children: ReactNode },
  { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string | null }) {
    // Still logged: the message on screen is for the person, the stack is for whoever debugs it.
    console.error(`the ${this.props.what} panel threw`, error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="empty" style={{ alignItems: 'flex-start', textAlign: 'left' }}>
        <h2 style={{ margin: 0 }}>The {this.props.what} panel stopped</h2>
        <p className="dim" style={{ maxWidth: '48rem' }}>
          Everything else still works — pick another panel from the rail, or try this one again.
          If it keeps happening, the message below is the thing worth repeating.
        </p>
        <pre className="mono" style={{
          background: 'var(--bg-sunken)', border: '1px solid var(--line)', borderRadius: 5,
          padding: '0.6rem 0.8rem', maxWidth: '48rem', maxHeight: '18rem',
          overflow: 'auto', whiteSpace: 'pre-wrap',
        }}>{error.message}{error.stack ? `\n\n${error.stack}` : ''}</pre>
        <button onClick={() => this.setState({ error: null })}>Try again</button>
      </div>
    );
  }
}
