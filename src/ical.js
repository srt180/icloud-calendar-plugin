/**
 * iCalendar (RFC 5545) text handling: unfolding, unescaping, date-time
 * conversion with IANA zone support, occurrence expansion for recurrence
 * rules, and building new/modified VEVENTs that iCloud accepts.
 *
 * Deliberately not a general-purpose iCal library: it covers the fields the
 * plugin exposes (title, time, all-day, location, notes, alarm, participants,
 * recurrence) and preserves everything else it does not touch, including
 * unknown X- properties and VALARM blocks.
 */

const WEEKDAY_MS = 86400000

// ---------------------------------------------------------------------------
// Date handling
// ---------------------------------------------------------------------------

/** In-memory date-time: a wall-clock value with a zone or a floating local. */
export class ICalDate {
  /**
   * @param {object} spec
   * @param {number} [spec.utcMs] - absolute instant, set for UTC/Z and date-times with TZID.
   * @param {string} [spec.tzid] - IANA zone name for zoned values.
   * @param {number[]} [spec.wall] - [year, month(1-12), day, hour, min, sec] for VALUE=DATE.
   * @param {boolean} [spec.dateOnly]
   * @param {number} [spec.floatingMs] - absolute-ms of the wall clock interpreted in the display zone, for floating values.
   */
  constructor(spec) {
    this.utcMs = spec.utcMs
    this.tzid = spec.tzid
    this.wall = spec.wall
    this.dateOnly = Boolean(spec.dateOnly)
    this.floatingMs = spec.floatingMs
  }
}

/**
 * Offset (ms) of one IANA zone at an instant. Positive east of UTC.
 * @param {string} tzid
 * @param {number} utcMs
 * @returns {number}
 */
export function zoneOffsetMs(tzid, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = {}
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return asUtc - utcMs
}

/**
 * Convert a wall-clock reading in an IANA zone to an absolute instant.
 * Resolves the offset at the guess instant, re-checking once for DST edges.
 * @param {string} tzid
 * @param {number} y @param {number} mo @param {number} d @param {number} h @param {number} mi @param {number} s
 * @returns {number} UTC milliseconds.
 */
export function zonedWallToUtc(tzid, y, mo, d, h, mi, s) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s)
  const first = zoneOffsetMs(tzid, naive)
  let result = naive - first
  const second = zoneOffsetMs(tzid, result)
  if (second !== first) result = naive - second
  return result
}

/**
 * Absolute instant to wall-clock parts in an IANA zone.
 * @param {string} tzid
 * @param {number} utcMs
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, weekday: number }}
 */
export function utcToWall(tzid, utcMs) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tzid,
    hourCycle: 'h23',
    weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = {}
  for (const p of dtf.formatToParts(new Date(utcMs))) parts[p.type] = p.value
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: weekdays[parts.weekday] ?? new Date(utcMs).getUTCDay(),
  }
}

/** Validate an IANA zone name. */
export function isValidZone(tzid) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tzid }).format(new Date())
    return true
  } catch {
    return false
  }
}

/**
 * Parse an iCal date-time value with its parameters.
 * @param {string} value - e.g. `20261119T010000Z`, `20261119`, `20261119T010000`.
 * @param {Record<string,string[]>} params - property parameters.
 * @param {string|null} displayZone - zone used to resolve floating times.
 * @returns {ICalDate|null}
 */
export function parseICalDate(value, params, displayZone) {
  const v = (value ?? '').trim()
  const isDate = String(params?.VALUE?.[0] ?? '').toUpperCase() === 'DATE' || /^\d{8}$/.test(v)
  if (isDate && /^\d{8}$/.test(v)) {
    return new ICalDate({
      dateOnly: true,
      wall: [Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)), 0, 0, 0],
    })
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i]))
  if (m[7] === 'Z') {
    return new ICalDate({ utcMs: Date.UTC(y, mo - 1, d, h, mi, s), tzid: 'UTC' })
  }
  const tzid = params?.TZID?.[0]
  if (tzid && isValidZone(tzid)) {
    return new ICalDate({ utcMs: zonedWallToUtc(tzid, y, mo, d, h, mi, s), tzid })
  }
  // Floating or unknown TZID: interpret in the display zone so the model sees
  // the wall-clock time the user actually stored.
  const zone = tzid && isValidZone(tzid) ? tzid : displayZone
  return new ICalDate({ floatingMs: zonedWallToUtc(zone, y, mo, d, h, mi, s), tzid: tzid ?? null })
}

/** Absolute milliseconds for any ICalDate (date-only anchors at local midnight). */
export function dateToMs(date, displayZone) {
  if (!date) return undefined
  if (date.utcMs !== undefined) return date.utcMs
  if (date.floatingMs !== undefined) return date.floatingMs
  if (date.dateOnly) {
    const [y, mo, d] = date.wall
    return zonedWallToUtc(displayZone, y, mo, d, 0, 0, 0)
  }
  return undefined
}

/** Format an instant for output as ISO-8601 with the display zone's offset. */
export function formatInstant(utcMs, displayZone, allDay = false) {
  if (utcMs === undefined) return undefined
  if (allDay) {
    const w = utcToWall(displayZone, utcMs)
    return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
  }
  const offset = zoneOffsetMs(displayZone, utcMs)
  const w = utcToWall(displayZone, utcMs)
  const offSign = offset < 0 ? '-' : '+'
  const offAbs = Math.abs(offset)
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`
    + `${offSign}${pad(Math.floor(offAbs / 3600000))}:${pad(Math.floor((offAbs % 3600000) / 60000))}`
}

/** Format an instant in UTC with a trailing Z. */
export function formatUtc(utcMs) {
  const d = new Date(utcMs)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T`
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`
}

/** Render an iCal VALUE=DATE-TIME in a zone: `TZID=` params plus local text. */
export function toICalZoned(utcMs, tzid) {
  const w = utcToWall(tzid, utcMs)
  return {
    params: `;TZID=${tzid}`,
    value: `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`,
  }
}

/** Render an iCal VALUE=DATE. */
export function toICalDate(y, mo, d) {
  return `${pad(y, 4)}${pad(mo)}${pad(d)}`
}

/** Add days to a `[y, mo, d]` wall-clock triple. */
export function addDaysWall(wall, days) {
  const d = new Date(Date.UTC(wall[0], wall[1] - 1, wall[2] + days))
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0]
}

function pad(n, len = 2) {
  return String(Math.trunc(Number(n))).padStart(len, '0')
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Unfold a raw iCal/vCard text and split into `[name, params, value]` triples.
 * Handles CRLF and bare LF, folded lines (leading space or tab), and quoted
 * parameter values containing `:` or `;`.
 * @param {string} text
 * @returns {Array<{ name: string, params: Record<string,string[]>, value: string }>}
 */
export function parseContentLines(text) {
  // Unfold CRLF/CR/LF alike: real servers use CRLF, but interoperating code and
  // hand-written fixtures can emit bare CR, which must not corrupt folding.
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').reduce((acc, line) => {
    if ((line.startsWith(' ') || line.startsWith('\t')) && acc.length > 0) acc[acc.length - 1] += line.slice(1)
    else if (line.length > 0) acc.push(line)
    return acc
  }, [])

  const out = []
  for (const line of lines) {
    let i = 0
    // name
    while (i < line.length && line[i] !== ';' && line[i] !== ':') i++
    const name = line.slice(0, i).trim().toUpperCase()
    const params = {}
    while (line[i] === ';') {
      i++
      let keyStart = i
      while (i < line.length && line[i] !== '=' && line[i] !== ';' && line[i] !== ':') i++
      const key = line.slice(keyStart, i).trim().toUpperCase()
      const values = []
      if (line[i] === '=') {
        i++
        for (;;) {
          if (line[i] === '"') {
            i++
            let vs = i
            while (i < line.length && line[i] !== '"') i++
            values.push(line.slice(vs, i))
            i++ // closing quote
          } else {
            const vs = i
            while (i < line.length && line[i] !== ',' && line[i] !== ';' && line[i] !== ':') i++
            values.push(line.slice(vs, i))
          }
          if (line[i] === ',') { i++; continue }
          break
        }
      }
      if (key) params[key] = values
    }
    const value = line[i] === ':' ? line.slice(i + 1) : ''
    if (name) out.push({ name, params, value })
  }
  return out
}

/** Unescape iCal TEXT values (`\n`, `\,`, `\;`, `\\`). */
export function unescapeText(value) {
  return String(value ?? '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\')
}

/** Escape a string for an iCal TEXT value. */
export function escapeText(value) {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n')
}

/**
 * Parse one VCALENDAR text into components.
 * @param {string} text
 * @returns {{ calendarProps: Array<[string, string]>, events: ICalComponent[] }}
 */
export function parseICalendar(text) {
  const lines = parseContentLines(text)
  const events = []
  let current = null
  let inAlarm = false
  for (const line of lines) {
    if (line.name === 'BEGIN' && line.value.toUpperCase() === 'VEVENT') {
      current = { props: [], alarms: [] }
      inAlarm = false
      continue
    }
    if (line.name === 'END' && line.value.toUpperCase() === 'VEVENT') {
      if (current) events.push(new ICalComponent(current))
      current = null
      inAlarm = false
      continue
    }
    if (!current) continue
    if (!inAlarm && line.name === 'BEGIN' && line.value.toUpperCase() === 'VALARM') {
      current.alarms.push([])
      inAlarm = true
      continue
    }
    if (inAlarm) {
      if (line.name === 'END' && line.value.toUpperCase() === 'VALARM') inAlarm = false
      else current.alarms[current.alarms.length - 1].push(line)
      continue
    }
    current.props.push(line)
  }
  return { calendarProps: [], events }
}

/** One VEVENT, with helpers for typed access. */
export class ICalComponent {
  constructor(raw) {
    this.props = raw.props
    /** VALARM blocks, each a list of its content lines. */
    this.alarmBlocks = raw.alarms
  }

  /** @param {string} name */
  get(name) {
    const hit = this.props.find(p => p.name === name)
    return hit ? hit : undefined
  }

  /** @param {string} name */
  getAll(name) {
    return this.props.filter(p => p.name === name)
  }

  /** First raw value of a property. */
  text(name) {
    const hit = this.get(name)
    return hit ? unescapeText(hit.value) : undefined
  }

  /** Parse a date property (`DTSTART`/`DTEND`/`DTSTAMP`...). */
  date(name, displayZone) {
    const hit = this.get(name)
    return hit ? parseICalDate(hit.value, hit.params, displayZone) : undefined
  }

  /** Copy the property list for editing, dropping the named properties. */
  without(names) {
    const drop = new Set(names)
    return this.props.filter(p => !drop.has(p.name)).slice()
  }
}

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

const WEEKDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']
const WEEKDAY_NAMES = { SU: '日', MO: '一', TU: '二', WE: '三', TH: '四', FR: '五', SA: '六' }
const FREQ_NAMES = { DAILY: '天', WEEKLY: '周', MONTHLY: '月', YEARLY: '年', HOURLY: '小时' }

/**
 * Parse an `RRULE:` value into a map of upper-case parts.
 * @param {string} rule
 * @returns {Record<string, string>}
 */
export function parseRRule(rule) {
  const out = {}
  for (const part of String(rule ?? '').split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) out[part.slice(0, eq).trim().toUpperCase()] = part.slice(eq + 1).trim()
  }
  return out
}

/**
 * Human-readable recurrence summary in Chinese.
 * @param {string} rule - RRULE value.
 * @returns {string}
 */
export function describeRRule(rule) {
  const r = parseRRule(rule)
  const unit = FREQ_NAMES[r.FREQ]
  if (!unit) return String(rule)
  const interval = Number(r.INTERVAL ?? 1) || 1
  const parts = [interval > 1 ? `每 ${interval} ${unit}` : `每${unit}`]
  if (r.BYDAY) {
    const days = r.BYDAY.split(',').map((d) => {
      const m = /^([+-]?\d+)?([A-Z]{2})$/.exec(d.trim().toUpperCase())
      if (!m) return d
      const nth = r.FREQ === 'MONTHLY' && m[1] ? `第${m[1]}个` : ''
      return `${nth}周${WEEKDAY_NAMES[m[2]] ?? m[2]}`
    })
    parts.push(`（${days.join('、')}）`)
  }
  if (r.COUNT) parts.push(`，共 ${r.COUNT} 次`)
  else if (r.UNTIL) parts.push(`，直到 ${r.UNTIL.replace(/T\d{4,6}Z?$/, '').replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')}`)
  return parts.join('')
}

/**
 * Parse an RRULE `UNTIL` value into absolute milliseconds.
 * @param {string} raw
 * @param {string} zone - zone that floating UNTIL values belong to.
 * @returns {number|undefined}
 */
function parseUntil(raw, zone) {
  const v = raw.trim()
  if (/^\d{8}$/.test(v)) {
    return zonedWallToUtc(zone, Number(v.slice(0, 4)), Number(v.slice(4, 6)), Number(v.slice(6, 8)), 23, 59, 59)
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v)
  if (!m) return undefined
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i]))
  return m[7] === 'Z'
    ? Date.UTC(y, mo - 1, d, h, mi, s)
    : zonedWallToUtc(zone, y, mo, d, h, mi, s)
}

/**
 * Clamp `[year, month, day]` to a valid calendar day (RFC 5545 skip=omit).
 * @returns {[number, number, number]}
 */
function clampDay(year, month, day) {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return [year, month, Math.min(day, last)]
}

/**
 * Generate the start of the `index`-th occurrence as wall-clock parts.
 * Uses one consistent model — an integer day counter plus optional BYDAY
 * expansion inside each FREQ period — so DAILY/WEEKLY/MONTHLY/YEARLY all
 * behave like the RFC says for the rule shapes iCloud UI produces.
 *
 * @param {object} spec
 * @param {number[]} spec.master - [y, mo, d, h, mi, s] of the first occurrence.
 * @param {string} spec.freq
 * @param {number} spec.interval
 * @param {number[]|null} spec.byDay - weekday numbers (0=Sun), sorted ascending.
 * @param {number} spec.index
 * @returns {number[]}
 */
function occurrenceWall(master, freq, interval, byDay, index) {
  const [y, mo, d, h, mi, s] = master
  const baseMs = Date.UTC(y, mo - 1, d)
  const withTime = wall => [wall[0], wall[1], wall[2], h, mi, s]

  if (freq === 'DAILY') {
    // Each interval-th day; BYDAY restricts but does not reorder.
    const wall = addDaysWall([y, mo, d, 0, 0, 0], interval * index)
    if (byDay && byDay.length > 0) {
      let cursor = index
      for (;;) {
        const candidate = addDaysWall([y, mo, d, 0, 0, 0], interval * cursor)
        const wd = new Date(Date.UTC(candidate[0], candidate[1] - 1, candidate[2])).getUTCDay()
        if (byDay.includes(wd)) return withTime(candidate)
        cursor++
      }
    }
    return withTime(wall)
  }

  if (freq === 'WEEKLY') {
    if (!byDay || byDay.length === 0) {
      const wall = addDaysWall([y, mo, d, 0, 0, 0], interval * index * 7)
      return withTime(wall)
    }
    const days = byDay.slice().sort((a, b) => a - b)
    const baseWd = new Date(baseMs).getUTCDay()
    const perWeek = days.length
    const weekIndex = Math.floor(index / perWeek)
    const dayIndex = index % perWeek
    // Week 0 begins on the first listed BYDAY at or before the master
    // (WKST-independent for the rules iCloud writes), then each interval-th
    // week advances by `interval * 7` days and the listed days fill it.
    const leadOffset = ((days[0] - baseWd) + 7) % 7
    const weekStart = addDaysWall([y, mo, d, 0, 0, 0], weekIndex * 7 * interval - leadOffset)
    const target = addDaysWall(weekStart, (days[dayIndex] - days[0] + 7) % 7)
    if (weekIndex === 0 && target[0] === y && target[1] === mo && target[2] < d) {
      // The master is itself a BYDAY of week 0; never emit an earlier day.
      return withTime([y, mo, d])
    }
    return withTime(target)
  }

  if (freq === 'MONTHLY') {
    const periodMonth = mo - 1 + interval * index
    const year = y + Math.floor(periodMonth / 12)
    const month = ((periodMonth % 12) + 12) % 12 + 1
    if (byDay && byDay.length > 0) {
      const target = nthWeekdayOfMonth(year, month, byDay[0], 1)
      return withTime(target)
    }
    return withTime(clampDay(year, month, d))
  }

  if (freq === 'YEARLY') {
    const year = y + interval * index
    return withTime(clampDay(year, mo, d))
  }

  return withTime([y, mo, d])
}

/**
 * The 1st (or `nth`) weekday of a month; NaN-free by construction.
 * @returns {[number, number, number]}
 */
function nthWeekdayOfMonth(year, month, weekday, nth = 1) {
  const firstWd = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + ((weekday - firstWd + 7) % 7) + (nth - 1) * 7
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return day > last ? [year, month, last] : [year, month, day]
}

/**
 * Expand a recurring event's start instants inside a window.
 *
 * Supported: FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, COUNT, UNTIL,
 * BYDAY (including weekly lists and plain monthly ordinals), and EXDATE.
 * Unsupported parts (BYSETPOS, BYMONTHDAY, BYMONTH, RRULE-less RDATE) are
 * ignored rather than approximated wrongly; the master is always reported.
 *
 * @param {object} spec
 * @param {number} spec.startMs - master DTSTART instant.
 * @param {string} spec.rule - RRULE value.
 * @param {number} spec.fromMs - window start.
 * @param {number} spec.toMs - window end (exclusive).
 * @param {string} spec.zone - zone the wall clock lives in.
 * @param {boolean} spec.allDay
 * @param {number[]} [spec.exdates] - EXDATE instants.
 * @param {number} [spec.maxOccurrences] - hard cap on generated occurrences.
 * @returns {number[]}
 */
export function expandRecurrence(spec) {
  const r = parseRRule(spec.rule)
  const freq = r.FREQ
  if (!freq || !FREQ_NAMES[freq]) return [spec.startMs]
  const interval = Math.max(1, Number(r.INTERVAL ?? 1) || 1)
  const count = r.COUNT ? Number(r.COUNT) : undefined
  const untilMs = r.UNTIL ? parseUntil(r.UNTIL, spec.zone) : undefined
  const byDay = r.BYDAY
    ? r.BYDAY.split(',').map(d => WEEKDAY_CODES.indexOf(d.trim().slice(-2).toUpperCase())).filter(d => d >= 0)
    : null
  const excluded = new Set(spec.exdates ?? [])
  const masterWall = spec.allDay
    ? [...utcToWallParts(spec.zone, spec.startMs)]
    : (() => {
        const w = utcToWall(spec.zone, spec.startMs)
        return [w.year, w.month, w.day, w.hour, w.minute, w.second]
      })()
  const cap = spec.maxOccurrences ?? 1000
  const generated = []
  // RSCALE / unsupported BY parts: report the master only, never invent times.
  const unsupported = r.RSCALE || r.BYSETPOS || r.BYMONTHDAY || r.BYHOUR || r.BYMINUTE
  if (unsupported) {
    return spec.startMs >= spec.fromMs && spec.startMs < spec.toMs && !excluded.has(spec.startMs)
      ? [spec.startMs]
      : []
  }

  for (let index = 0; index < cap; index++) {
    if (count !== undefined && index >= count) break
    const occ = occurrenceWall(masterWall, freq, interval, byDay, index)
    const ms = occ[3] === 0 && spec.allDay
      ? zonedWallToUtc(spec.zone, occ[0], occ[1], occ[2], 0, 0, 0)
      : zonedWallToUtc(spec.zone, occ[0], occ[1], occ[2], occ[3], occ[4], occ[5])
    if (untilMs !== undefined && ms > untilMs) break
    if (ms >= spec.toMs) {
      // Occurrences are monotonic: stop as soon as the window is passed.
      break
    }
    if (ms < spec.fromMs) continue
    if (excluded.has(ms)) continue
    generated.push(ms)
  }
  return generated
}

/** Wall parts array form used by recurrence arithmetic. */
function utcToWallParts(zone, utcMs) {
  const w = utcToWall(zone, utcMs)
  return [w.year, w.month, w.day, 0, 0, 0]
}

// ---------------------------------------------------------------------------
// Event projection
// ---------------------------------------------------------------------------

/**
 * Project a VEVENT (master or instance) into the model-facing event shape.
 * A recurring master reports its first occurrence and the rule; individual
 * instances from a REPORT carry RECURRENCE-ID.
 * @param {ICalComponent} ev
 * @param {object} ctx - { zone, calendarId?, calendarName? }
 * @param {string} [href] - resource href, used as the stable event id.
 */
export function projectEvent(ev, ctx, href) {
  const zone = ctx.zone
  const status = ev.text('STATUS')
  const allDay = Boolean(ev.date('DTSTART', zone)?.dateOnly)
  const startDate = ev.date('DTSTART', zone)
  const endDate = ev.date('DTEND', zone) ?? ev.date('DUE', zone)
  const startMs = dateToMs(startDate, zone)
  let endMs = dateToMs(endDate, zone)
  if (endMs === undefined && startMs !== undefined && ev.get('DURATION')) {
    endMs = startMs + parseDuration(ev.get('DURATION').value)
  }
  const rrule = ev.get('RRULE')?.value
  const recurrenceId = ev.get('RECURRENCE-ID')
  const rruleUntil = rrule ? describeRRule(rrule) : undefined
  const organizer = ev.get('ORGANIZER')
  return {
    id: href,
    title: ev.text('SUMMARY') ?? '（无标题）',
    ...(allDay
      ? { start: formatInstant(startMs, zone, true), end: formatInstant(endMs, zone, true), allDay: true }
      : { start: formatInstant(startMs, zone), end: formatInstant(endMs, zone), allDay: false }),
    ...(startDate?.tzid && !allDay ? { startTimeZone: startDate.tzid } : {}),
    ...(status ? { status: mapStatus(status) } : {}),
    ...(ev.text('LOCATION') ? { location: ev.text('LOCATION') } : {}),
    ...(ev.text('DESCRIPTION') ? { notes: truncate(ev.text('DESCRIPTION'), 1500) } : {}),
    ...(organizer ? { organizer: organizerText(organizer) } : {}),
    ...(ev.getAll('ATTENDEE').length > 0
      ? {
          attendees: ev.getAll('ATTENDEE').map((a) => {
            const cn = a.params?.CN?.[0]
            return { ...(cn ? { name: unescapeText(cn) } : {}), ...(a.value.startsWith('mailto:') ? { email: a.value.slice(7) } : {}), ...(a.params?.PARTSTAT?.[0] ? { status: a.params.PARTSTAT[0].toLowerCase() } : {}) }
          }),
        }
      : {}),
    ...(rrule ? { recurring: true, recurrence: rruleUntil, rrule } : {}),
    ...(recurrenceId ? { recurrenceId: formatInstant(dateToMs(parseICalDate(recurrenceId.value, recurrenceId.params, zone), zone), zone, allDay) } : {}),
    ...(ev.getAll('EXDATE').length > 0 ? { exceptions: ev.getAll('EXDATE').map(x => x.value) } : {}),
    ...(ctx.calendarId ? { calendarId: ctx.calendarId } : {}),
    ...(ctx.calendarName ? { calendarName: ctx.calendarName } : {}),
    ...(ev.getAll('VALARM').length > 0 || (ev.alarmBlocks ?? []).length > 0 ? { hasAlarm: true } : {}),
    ...(ev.text('URL') ? { url: ev.text('URL') } : {}),
  }
}

/** Map a VEVENT STATUS to the public vocabulary. */
function mapStatus(status) {
  const s = status.toUpperCase()
  return s === 'CANCELLED' ? 'cancelled' : s === 'TENTATIVE' ? 'tentative' : 'confirmed'
}

/** Render an ORGANIZER property as `Name <mailto:...>` or the raw value. */
function organizerText(prop) {
  const cn = prop.params?.CN?.[0]
  const value = prop.value.startsWith('mailto:') ? prop.value.slice(7) : prop.value
  return cn ? `${unescapeText(cn)} <${value}>` : value
}

/** Parse an RFC 5545 DURATION into milliseconds. */
export function parseDuration(raw) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(raw ?? '').trim().toUpperCase())
  if (!m) return 0
  const sign = m[1] === '-' ? -1 : 1
  const [, , w, d, h, mi, s] = m
  return sign * ((((Number(w || 0) * 7 + Number(d || 0)) * 24 + Number(h || 0)) * 60 + Number(mi || 0)) * 60 + Number(s || 0)) * 1000
}

function truncate(text, max) {
  const s = String(text)
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Read a VALARM into a friendly object.
 * @param {Array<{ name: string, params: Record<string,string[]>, value: string }>} lines
 */
export function projectAlarm(lines) {
  const action = lines.find(l => l.name === 'ACTION')?.value
  const trigger = lines.find(l => l.name === 'TRIGGER')
  const description = lines.find(l => l.name === 'DESCRIPTION')
  if (!trigger) return undefined
  const lead = parseDuration(trigger.value.replace(/^-/, ''))
  return {
    ...(description ? { description: unescapeText(description.value) } : {}),
    ...(action ? { action: action.toLowerCase() } : {}),
    ...(trigger.value.startsWith('-') ? { minutesBefore: Math.round(lead / 60000) } : {}),
    ...(trigger.params?.RELATED?.[0] === 'END' ? { relativeTo: 'end' } : {}),
  }
}
