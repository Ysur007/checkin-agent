import { useCallback, useEffect, useMemo, useState } from 'react';
import type { RunDto } from '../types';
import { get } from '../api';
import type { ToastTone } from '../components/Toast';
import { RunTable } from '../components/RunTable';
import { IconRefresh } from '../components/icons';

type Filter = 'all' | 'success' | 'failed' | 'unverified' | 'needs_reauth';

interface Props {
  notify: (message: string, tone?: ToastTone) => void;
  onRun: (runId: string) => void;
}

const FILTERS: Array<{ value: Filter; label: string }> = [
  { value: 'all', label: '全部' },
  { value: 'success', label: '成功' },
  { value: 'unverified', label: '未验证' },
  { value: 'failed', label: '失败' },
  { value: 'needs_reauth', label: '需重登' },
];

export function Runs({ notify, onRun }: Props) {
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await get<{ items: RunDto[] }>('/api/runs?limit=100');
      setRuns(result.items);
    } catch (error) {
      notify(error instanceof Error ? error.message : '加载运行记录失败', 'error');
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const isSuccess = (run: RunDto) => run.status === 'succeeded' || run.status === 'already_claimed';
    return {
      all: runs.length,
      success: runs.filter(isSuccess).length,
      failed: runs.filter((run) => run.status === 'failed' || run.status === 'rate_limited').length,
      unverified: runs.filter((run) => run.status === 'unverified').length,
      needs_reauth: runs.filter((run) => run.status === 'needs_reauth').length,
    };
  }, [runs]);

  const filtered = useMemo(() => {
    if (filter === 'all') return runs;
    if (filter === 'success') return runs.filter((run) => run.status === 'succeeded' || run.status === 'already_claimed');
    if (filter === 'failed') return runs.filter((run) => run.status === 'failed' || run.status === 'rate_limited');
    return runs.filter((run) => run.status === filter);
  }, [runs, filter]);

  return (
    <div className="page">
      <div className="list-head">
        <div className="chips" role="group" aria-label="按状态筛选">
          {FILTERS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`chip ${filter === item.value ? 'is-active' : ''}`}
              aria-pressed={filter === item.value}
              onClick={() => setFilter(item.value)}
            >
              {item.label}
              <span>{counts[item.value]}</span>
            </button>
          ))}
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => void load()} disabled={loading}>
          <IconRefresh size={14} />
          {loading ? '刷新中…' : '刷新'}
        </button>
      </div>

      <section className="card">
        <RunTable runs={filtered} onOpen={onRun} />
      </section>
    </div>
  );
}
