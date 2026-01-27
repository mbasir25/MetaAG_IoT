// src/utils/dateUtils.js
export function extractDates(text) {
  const now = new Date();
  const lower = text.toLowerCase();
  let start, end;

  if (lower.includes('today')) {
    start = end = now;
  } else if (lower.includes('yesterday')) {
    const y = new Date(now);
    y.setDate(y.getDate() - 1);
    start = end = y;
  } else if (lower.match(/(\d+)\s*days?\s*ago/)) {
    const n = parseInt(lower.match(/(\d+)\s*days?\s*ago/)[1]);
    const d = new Date(now);
    d.setDate(d.getDate() - n);
    start = end = d;
  } else if (lower.includes('last week')) {
    end = new Date(now);
    start = new Date(now);
    start.setDate(start.getDate() - 7);
  } else if (lower.includes('next week')) {
    start = new Date(now);
    start.setDate(start.getDate() + 1);
    end = new Date(start);
    end.setDate(start.getDate() + 7);
  } else if (lower.match(/\b(\d{4}-\d{2}-\d{2})\b/)) {
    const match = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/)[1];
    start = end = new Date(match);
  }

  if (start && end) {
    return {
      start: start.toISOString().slice(0, 10),
      end: end.toISOString().slice(0, 10),
    };
  }
  return null;
}
