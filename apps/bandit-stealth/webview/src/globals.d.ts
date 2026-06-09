interface VsCodeApi<TState = unknown> {
  postMessage(message: unknown): void;
  getState(): TState | undefined;
  setState(data: TState): void;
}

declare function acquireVsCodeApi<TState = unknown>(): VsCodeApi<TState>;

declare const vscode: VsCodeApi;
