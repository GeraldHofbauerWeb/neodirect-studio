/**
 * Talking to the studio.
 *
 * One function, because there is one kind of call: an operation by name. The catalogue behind it
 * is the same table the MCP server offers, so anything an agent can do is reachable from here
 * without anybody adding a route.
 */

export type Op = {
  name: string;
  group: string;
  describe: string;
  sideEffects: 'none' | 'files' | 'world';
  needsDirector: boolean;
  input: { properties?: Record<string, unknown> };
};

export class OpError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

export async function op<T = any>(name: string, params: Record<string, unknown> = {}): Promise<T> {
  const response = await fetch(`/api/op/${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await response.json();
  if (!response.ok) throw new OpError(body.error ?? `${name} failed`, body.code);
  return body as T;
}

export async function catalogue(): Promise<Op[]> {
  const response = await fetch('/api/ops');
  return (await response.json()).ops;
}

/** The live side: job output, and whether the game is still there. */
export function listen(handlers: {
  line?: (event: { id: string; line: string }) => void;
  start?: (event: { id: string; label: string }) => void;
  end?: (event: { id: string; exitCode: number; ms: number }) => void;
  director?: (state: any) => void;
}): () => void {
  const source = new EventSource('/api/events');
  const on = (name: string, handler?: (data: any) => void) => {
    if (handler) source.addEventListener(name, (event) => handler(JSON.parse((event as MessageEvent).data)));
  };
  on('job-line', handlers.line);
  on('job-start', handlers.start);
  on('job-end', handlers.end);
  on('director', handlers.director);
  return () => source.close();
}

/** A fresh frame from the game. The query string is what stops the browser caching it. */
export const screenshotUrl = () => `/api/screenshot?at=${Date.now()}`;

/** Something out of out/ — a take, its narration, its subtitles. */
export const mediaUrl = (path: string) => `/api/media?path=${encodeURIComponent(path)}`;
