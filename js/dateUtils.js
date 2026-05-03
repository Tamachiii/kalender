export const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function startOfDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

export function endOfDay(date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

export function addDays(date, days) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export function addMonths(date, months) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

export function startOfWeek(date) {
  const next = startOfDay(date);
  const day = next.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDays(next, mondayOffset);
}

export function startOfMonthGrid(date) {
  const first = new Date(date.getFullYear(), date.getMonth(), 1);
  return startOfWeek(first);
}

export function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function toLocalInputValue(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(
    date.getDate(),
  )}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInputValue(value) {
  return new Date(value);
}

export function formatRangeTitle(date, view) {
  const formatter = new Intl.DateTimeFormat(undefined, {
    month: 'long',
    year: 'numeric',
  });

  if (view === 'month') return formatter.format(date);
  if (view === 'day') {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(date);
  }

  const start = startOfWeek(date);
  const end = addDays(start, 6);
  const short = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  });
  return `${short.format(start)} - ${short.format(end)}, ${end.getFullYear()}`;
}

export function dateKey(date) {
  const local = startOfDay(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(
    local.getDate(),
  )}`;
}

export function eventOccursOn(event, date) {
  const dayStart = startOfDay(date);
  const dayEnd = endOfDay(date);
  return new Date(event.starts_at) <= dayEnd && new Date(event.ends_at) >= dayStart;
}

export function minutesSinceStartOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}
