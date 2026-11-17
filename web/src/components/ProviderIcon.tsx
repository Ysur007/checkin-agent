import type { ProviderMeta } from '../types';

export function ProviderIcon({ provider, size = 30 }: { provider: Pick<ProviderMeta, 'short' | 'tint' | 'name'>; size?: number }) {
  return (
    <span
      className="p-tile"
      style={{ width: size, height: size, background: provider.tint, fontSize: Math.round(size * 0.38) }}
      aria-hidden="true"
      title={provider.name}
    >
      {provider.short}
    </span>
  );
}
