// src/utils/kyivTime.ts
// Kyiv local time for message templates. Uses Intl (IANA tz, DST-correct);
// falls back to a fixed UTC+3 only if tz data is unavailable in the runtime.

const pad = (n: number) => String(n).padStart(2, '0');

type Parts = { day: string; month: string; year: string; hour: string; minute: string };

function tryZone(unix: number, zone: string): Parts | null {
  try {
    const fmt = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      day: '2-digit', month: '2-digit', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const out: Record<string, string> = {};
    for (const p of fmt.formatToParts(new Date(unix * 1000))) out[p.type] = p.value;
    if (!out.hour) return null;
    return { day: out.day, month: out.month, year: out.year, hour: out.hour === '24' ? '00' : out.hour, minute: out.minute };
  } catch {
    return null;
  }
}

function kyivParts(unix: number): Parts {
  const p = tryZone(unix, 'Europe/Kyiv') || tryZone(unix, 'Europe/Kiev');
  if (p) return p;
  // last-resort fallback: fixed UTC+3 (summer offset)
  const d = new Date((unix + 3 * 3600) * 1000);
  return {
    day: pad(d.getUTCDate()), month: pad(d.getUTCMonth() + 1), year: String(d.getUTCFullYear()),
    hour: pad(d.getUTCHours()), minute: pad(d.getUTCMinutes()),
  };
}

// unix seconds -> "17:00 Kyiv", or "04.06 02:30 Kyiv" when the Kyiv date differs from the UTC date
export function kyivTimeShort(unix: number): string {
  const k = kyivParts(unix);
  const d = new Date(unix * 1000);
  const sameDate = Number(k.day) === d.getUTCDate() && Number(k.month) === d.getUTCMonth() + 1;
  return sameDate ? `${k.hour}:${k.minute} Kyiv` : `${k.day}.${k.month} ${k.hour}:${k.minute} Kyiv`;
}
