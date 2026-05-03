// Pure Quick Add parser. Tokenizes the input on whitespace, walks tokens in
// passes (date → time-range → single-time → duration), and treats anything
// left as the title. Has no DOM, store, or Supabase dependencies — composing a
// real event draft is the caller's job (see buildQuickAddDraft in app.js).
import { addDays, startOfDay } from './dateUtils.js';

const DAY_NAMES = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function parseTimeToken(token) {
  if (!token) return null;
  const match = token.match(/^(\d{1,2})(?::(\d{2}))?(am|pm)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  const meridiem = (match[3] || '').toLowerCase();
  if (meridiem === 'am') {
    if (hour === 12) hour = 0;
    else if (hour > 12) return null;
  } else if (meridiem === 'pm') {
    if (hour < 12) hour += 12;
    else if (hour > 12) return null;
  }
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return { hour, minute, minutes: hour * 60 + minute };
}

export function parseDurationToken(token) {
  if (!token) return null;
  const match = token.match(/^(?:(\d+)h)?(?:(\d+)m)?$/i);
  if (!match || (!match[1] && !match[2])) return null;
  const minutes = Number(match[1] || 0) * 60 + Number(match[2] || 0);
  return minutes > 0 ? minutes : null;
}

// `referenceDate` anchors relative tokens like "today", "tomorrow", and
// weekday names. It defaults to real `new Date()` so phrases mean what the
// user expects regardless of which day is selected on the calendar.
export function parseQuickAddInput(raw, referenceDate) {
  const trimmed = (raw || '').trim();
  const empty = {
    ok: false,
    title: '',
    date: null,
    startMinutes: null,
    endMinutes: null,
    durationMinutes: null,
  };
  if (!trimmed) return empty;

  const tokens = trimmed.split(/\s+/);
  const consumed = new Array(tokens.length).fill(false);
  const result = { ...empty, ok: false };

  const now = referenceDate || new Date();
  for (let i = 0; i < tokens.length; i += 1) {
    if (consumed[i]) continue;
    const lower = tokens[i].toLowerCase();
    if (lower === 'today') {
      result.date = startOfDay(now);
      consumed[i] = true;
      break;
    }
    if (lower === 'tomorrow') {
      result.date = startOfDay(addDays(now, 1));
      consumed[i] = true;
      break;
    }
    const weekdayIndex = DAY_NAMES.indexOf(lower);
    if (weekdayIndex !== -1) {
      const offset = ((weekdayIndex - now.getDay() + 7) % 7) || 7;
      result.date = startOfDay(addDays(now, offset));
      consumed[i] = true;
      break;
    }
    const iso = lower.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (iso) {
      const candidate = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
      if (!Number.isNaN(candidate.getTime())) {
        result.date = startOfDay(candidate);
        consumed[i] = true;
        break;
      }
    }
  }

  // Pass 2: time range — single-token "H-H[:MM]" or three-token "H to H".
  for (let i = 0; i < tokens.length; i += 1) {
    if (consumed[i]) continue;
    const parts = tokens[i].split(/[-–]/);
    if (parts.length === 2 && parts[0] && parts[1]) {
      const startT = parseTimeToken(parts[0]);
      const endT = parseTimeToken(parts[1]);
      if (startT && endT) {
        result.startMinutes = startT.minutes;
        result.endMinutes = endT.minutes;
        consumed[i] = true;
        break;
      }
    }
    if (i + 2 < tokens.length && tokens[i + 1].toLowerCase() === 'to') {
      const startT = parseTimeToken(tokens[i]);
      const endT = parseTimeToken(tokens[i + 2]);
      if (startT && endT) {
        result.startMinutes = startT.minutes;
        result.endMinutes = endT.minutes;
        consumed[i] = consumed[i + 1] = consumed[i + 2] = true;
        break;
      }
    }
  }

  // Pass 3: single time. "9", "14:00", "9am", or "9 pm" across two tokens.
  if (result.startMinutes == null) {
    for (let i = 0; i < tokens.length; i += 1) {
      if (consumed[i]) continue;
      const startT = parseTimeToken(tokens[i]);
      if (startT) {
        result.startMinutes = startT.minutes;
        consumed[i] = true;
        // Pick up a trailing am/pm in the next token if not already merged.
        const next = tokens[i + 1]?.toLowerCase();
        if (!consumed[i + 1] && (next === 'am' || next === 'pm')) {
          const merged = parseTimeToken(`${tokens[i]}${next}`);
          if (merged) {
            result.startMinutes = merged.minutes;
            consumed[i + 1] = true;
          }
        }
        break;
      }
    }
  }

  // Pass 4: duration — "for 1h", "for 30m", "for 2h30m".
  for (let i = 0; i < tokens.length - 1; i += 1) {
    if (consumed[i] || consumed[i + 1]) continue;
    if (tokens[i].toLowerCase() !== 'for') continue;
    const minutes = parseDurationToken(tokens[i + 1]);
    if (minutes != null) {
      result.durationMinutes = minutes;
      consumed[i] = consumed[i + 1] = true;
      break;
    }
  }

  result.title = tokens
    .filter((_, i) => !consumed[i])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  result.ok = Boolean(
    result.title || result.date || result.startMinutes != null || result.durationMinutes != null,
  );
  return result;
}
