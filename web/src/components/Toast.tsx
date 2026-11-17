export type ToastTone = 'info' | 'success' | 'error';

export interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div className={`toast-host`} aria-live="polite">
      <div className={`toast toast-${toast.tone}`} role="status">
        <span className="toast-dot" aria-hidden="true" />
        <span>{toast.message}</span>
      </div>
    </div>
  );
}
