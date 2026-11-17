import { statusLabel, statusTone } from '../format';

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return (
    <span className={`pill pill-${statusTone(status)}`}>
      <i aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}
