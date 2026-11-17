export interface LocalParts {
  date: string;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(timezone: string, date = new Date()): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);

  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
  };
}

export function localDate(timezone: string, date = new Date()): string {
  return localParts(timezone, date).date;
}

export function minutesOfDay(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

export function hashJitter(value: string, maxSeconds: number): number {
  if (maxSeconds <= 0) return 0;
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash) % maxSeconds;
}

export function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function nextRunLabel(
  timezone: string,
  scheduleTime: string,
  jitterSeconds: number,
  accountId: string,
): { label: string; date: string; time: string } {
  const now = localParts(timezone);
  const nowMinutes = now.hour * 60 + now.minute;
  const base = minutesOfDay(scheduleTime);
  const jitter = hashJitter(accountId, jitterSeconds);
  const targetMinutes = Math.min(base + Math.floor(jitter / 60), 23 * 60 + 59);
  const time = formatClock(targetMinutes);
  const isToday = targetMinutes > nowMinutes;
  const date = isToday ? now.date : localDate(timezone, new Date(Date.now() + 86_400_000));
  return {
    label: `${isToday ? '今天' : '明天'} ${time}`,
    date,
    time,
  };
}
