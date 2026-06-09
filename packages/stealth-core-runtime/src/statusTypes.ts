export interface StatusPayload {
  text: string;
  stepId?: string;
  phase?: 'start' | 'progress' | 'complete' | 'error';
  detail?: string;
  icon?: 'plan' | 'search' | 'code' | 'terminal' | 'review' | 'success' | 'warn' | 'info';
}

export interface LogPayload {
  message: string;
  stepId?: string;
  level?: 'info' | 'warn' | 'error';
}
