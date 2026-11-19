/**
 * Mock iCloud DAV server for tests.
 *
 * Emulates the response shapes iCloud's CalDAV/CardDAV endpoints produce:
 * PROPFIND (principal, home sets, collections), calendar-query REPORT,
 * addressbook-query REPORT, GET/PUT(with If-Match)/DELETE of resources, ETags,
 * 207 multistatus bodies with `D:`/`C:` prefixes, and Basic auth 401s.
 *
 * Usage: node mock-server.mjs [--port 0] [--state /tmp/xxx-state.json]
 * Prints `LISTENING <port>` on stdout.
 */

import http from 'node:http'
import fs from 'node:fs'

const args = process.argv.slice(2)
const portIdx = args.indexOf('--port')
const stateIdx = args.indexOf('--state')
const port = portIdx === -1 ? 0 : Number(args[portIdx + 1])
const stateFile = stateIdx === -1 ? null : args[stateIdx + 1]

const USER = 'example-user@example.com'
const PASS = 'FAKE-TEST-PASSWORD'
const BASE = 'https://caldav.icloud.com.cn'

/** Today in Asia/Shanghai, for seeded events. */
function shanghaiDate(daysFromNow) {
  const now = new Date(Date.now() + 8 * 3600000 + daysFromNow * 86400000)
  return now.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Seeded state
// ---------------------------------------------------------------------------
const state = {
  calendars: {
    '/123/calendars/home/': { name: '个人', color: '#1badf8FF', writable: true },
    '/123/calendars/work/': { name: '工作', color: '#ff9500FF', writable: true },
    '/123/calendars/holiday/': { name: '中国节假日', color: '#ff3b30FF', writable: false },
  },
  objects: new Map(),
  addressbooks: {
    '/123/carddavhome/card/': { name: '所有联系人' },
  },
  contacts: new Map(),
}

function ics(lines) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Apple Inc.//iOS 17.4//EN', ...lines, 'END:VCALENDAR'].join('\r\n') + '\r\n'
}

state.objects.set('/123/calendars/home/weekly.ics', {
  etag: '"etag-weekly-1"',
  body: ics([
    'BEGIN:VEVENT',
    'UID:weekly-0001',
    `DTSTART;TZID=Asia/Shanghai:${shanghaiDate(-14).replace(/-/g, '')}T090000`,
    `DTEND;TZID=Asia/Shanghai:${shanghaiDate(-14).replace(/-/g, '')}T100000`,
    'SUMMARY:产品周会',
    'LOCATION:会议室 A\\, 2 楼',
    'DESCRIPTION:同步本周进展\\n准备 Q4 路线图',
    'RRULE:FREQ=WEEKLY;BYDAY=FR',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:产品周会提醒',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
  ]),
})
state.objects.set('/123/calendars/home/dentist.ics', {
  etag: '"etag-dentist-1"',
  body: ics([
    'BEGIN:VEVENT',
    'UID:dentist-0001',
    `DTSTART;TZID=Asia/Shanghai:${shanghaiDate(2).replace(/-/g, '')}T143000`,
    `DTEND;TZID=Asia/Shanghai:${shanghaiDate(2).replace(/-/g, '')}T153000`,
    'SUMMARY:牙医复诊',
    'LOCATION:口腔医院',
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:牙医复诊',
    'TRIGGER:-P1D',
    'END:VALARM',
    'END:VEVENT',
  ]),
})
state.objects.set('/123/calendars/work/allhands.ics', {
  etag: '"etag-allhands-1"',
  body: ics([
    'BEGIN:VEVENT',
    'UID:allhands-0001',
    `DTSTART;VALUE=DATE:${shanghaiDate(5).replace(/-/g, '')}`,
    'SUMMARY:全员大会',
    'DESCRIPTION:全天活动',
    'END:VEVENT',
  ]),
})

const vcard = (lines) => [...lines, 'END:VCARD'].join('\r\n')

state.contacts.set('/123/carddavhome/card/zhangwei.vcf', {
  etag: '"etag-card-1"',
  body: vcard([
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:card-zhangwei', 'FN:张伟', 'N:张;伟;;;',
    'ORG:贵州云智科技有限公司;;技术部', 'TITLE:技术总监',
    'EMAIL;type=INTERNET;type=WORK:zhang.wei@example.cn',
    'TEL;type=CELL:+86 138 1234 5678',
    'ADR;type=WORK:;;观山湖区长岭北路 8 号;贵阳市;贵州省;550081;中国',
    'NOTE:2024 年 5 月在北京会议认识', 'BDAY:1988-03-12',
  ]),
})
state.contacts.set('/123/carddavhome/card/lina.vcf', {
  etag: '"etag-card-2"',
  body: vcard([
    'BEGIN:VCARD', 'VERSION:3.0', 'UID:card-lina', 'FN:Li Na', 'N:Li;Na;;;',
    'ORG:Acme Corp', 'EMAIL;type=INTERNET;type=HOME:lina@example.com',
    'TEL;type=CELL:+1 415 555 0100',
  ]),
})

/** Request log for assertions. */
const log = []
let counter = 0

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const multistatus = (parts) => `<?xml version="1.0" encoding="UTF-8"?>
<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:CR="urn:ietf:params:xml:ns:carddav" xmlns:CS="http://calendarserver.org/ns/" xmlns:I="http://apple.com/ns/ical/">
${parts.join('\n')}
</D:multistatus>`

const response = (href, props) => `  <D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', c => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8')
    log.push({ method: req.method, path: req.url, depth: req.headers.depth, body: body.slice(0, 200) })
    const url = new URL(req.url, 'https://mock')
    const path = url.pathname
    if (path === '/__log') return json(res, 200, log.splice(0))
    if (path === '/__state') return json(res, 200, { objects: [...state.objects.keys()], contacts: [...state.contacts.keys()] })
    handle(req, res, path, body)
  })
})

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(value))
}

function xml(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' })
  res.end(text)
}

function handle(req, res, path, body) {
  // Auth: everything except the root discovery probes requires Basic auth.
  const auth = req.headers.authorization ?? ''
  const expected = `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`
  if (req.method === 'PROPFIND' && path === '/' && !auth) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="iCloud"' })
    return res.end('')
  }
  if (auth !== expected) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="iCloud"' })
    return res.end('')
  }

  if (req.method === 'PROPFIND') return propfind(res, path, body, req.headers.depth ?? '0')
  if (req.method === 'REPORT') return report(req, res, path, body)
  if (req.method === 'GET') return get(res, path)
  if (req.method === 'PUT') return put(req, res, path, body)
  if (req.method === 'DELETE') return del(req, res, path)
  res.writeHead(405)
  res.end()
}

function propfind(res, path, body, depth) {
  const wants = (name) => body.includes(name)
  if (path === '/') {
    return xml(res, 207, multistatus([response('/', '<D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal>')]))
  }
  if (path === '/123/principal/') {
    const props = [response('/123/principal/', '<C:calendar-home-set><D:href>/123/calendars/</D:href></C:calendar-home-set><CR:addressbook-home-set><D:href>/123/carddavhome/</D:href></CR:addressbook-home-set>')]
    return xml(res, 207, multistatus(props))
  }
  if (path === '/123/calendars/' || path === '/123/carddavhome/') {
    const isCal = path === '/123/calendars/'
    const entries = isCal ? Object.entries(state.calendars) : Object.entries(state.addressbooks)
    const parts = [response(path, '<D:resourcetype><D:collection/></D:resourcetype><D:displayname>home</D:displayname>')]
    for (const [href, meta] of entries) {
      parts.push(response(href, isCal
        ? `<D:resourcetype><D:collection/><C:calendar/></D:resourcetype><D:displayname>${esc(meta.name)}</D:displayname><I:calendar-color>${meta.color}</I:calendar-color><C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>${meta.writable ? '<D:current-user-privilege-set><D:privilege><D:write/></D:privilege><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>' : '<D:current-user-privilege-set><D:privilege><D:read/></D:privilege></D:current-user-privilege-set>'}`
        : `<D:resourcetype><D:collection/><CR:addressbook/></D:resourcetype><D:displayname>${esc(meta.name)}</D:displayname>`))
      if (depth === '1' && !isCal) {
        for (const [chref, c] of state.contacts) {
          if (!chref.startsWith(href)) continue
          parts.push(response(chref, `<D:getetag>${c.etag}</D:getetag>${wants('address-data') ? `<CR:address-data>${esc(c.body)}</CR:address-data>` : ''}`))
        }
      }
      if (depth === '1' && isCal) {
        for (const [ohref, o] of state.objects) {
          if (!ohref.startsWith(href)) continue
          parts.push(response(ohref, `<D:getetag>${o.etag}</D:getetag>${wants('calendar-data') ? `<C:calendar-data>${esc(o.body)}</C:calendar-data>` : ''}`))
        }
      }
    }
    return xml(res, 207, multistatus(parts))
  }
  xml(res, 404, '')
}

function report(req, res, path, body) {
  if (path.startsWith('/123/carddavhome/card')) {
    // Every text-match must match (server-side filter), and a filtered report
    // returns only matching cards.
    // Extract each <c:text-match> payload; the `c:` prefix is validated by the
    // element closer, keeping the search term itself free of namespace noise.
    const needles = [...body.matchAll(/[<]c:text-match\b[^>]*>([^<]*)<\/c:text-match>/g)].map(m => m[1].toLowerCase())
    const parts = []
    for (const [href, c] of state.contacts) {
      if (!href.startsWith(path)) continue
      const matches = needles.every((needle) => c.body.toLowerCase().includes(needle))
      if (matches) parts.push(response(href, `<D:getetag>${c.etag}</D:getetag><CR:address-data>${esc(c.body)}</CR:address-data>`))
    }
    return xml(res, 207, multistatus(parts))
  }
  // calendar-query / calendar-multiget
  if (body.includes('time-range') || body.includes('calendar-query')) {
    const start = parseRangeBound(/time-range\s+start="([^"]+)"/.exec(body)?.[1])
    const end = parseRangeBound(/time-range\s+end="([^"]+)"/.exec(body)?.[1])
    const parts = []
    for (const [href, o] of state.objects) {
      if (!href.startsWith(path)) continue
      const instants = eventInstants(o.body).sort((a, b) => a - b)
      const first = instants[0] ?? 0
      const last = instants[instants.length - 1] ?? first
      // Recurring masters match when the series could reach the window; the
      // client owns expansion, exactly like a real server.
      const recurring = /RRULE/.test(o.body) && (start === undefined || first < end)
      const overlap = (start === undefined || last >= start) && (end === undefined || first < end)
      if (overlap || recurring) parts.push(response(href, `<D:getetag>${o.etag}</D:getetag><C:calendar-data>${esc(o.body)}</C:calendar-data>`))
    }
    return xml(res, 207, multistatus(parts))
  }
  const parts = []
  for (const [href, o] of state.objects) {
    if (!href.startsWith(path)) continue
    parts.push(response(href, `<D:getetag>${o.etag}</D:getetag><C:calendar-data>${esc(o.body)}</C:calendar-data>`))
  }
  xml(res, 207, multistatus(parts))
}

/**
 * All instants mentioned by an .ics body as comparable UTC-millisecond
 * numbers, so a time-range REPORT can decide overlap exactly.
 * @param {string} text
 * @returns {number[]}
 */
function eventInstants(text) {
  const zoneOffsetMs = 8 * 3600000 // Asia/Shanghai, no DST
  const out = []
  for (const m of text.matchAll(/:(\d{8})(T(\d{6})(Z)?)?/g)) {
    const [, date, , time, z] = m
    const y = Number(date.slice(0, 4)); const mo = Number(date.slice(4, 6)); const d = Number(date.slice(6, 8))
    if (!time) { out.push(Date.UTC(y, mo - 1, d)); continue }
    const h = Number(time.slice(0, 2)); const mi = Number(time.slice(2, 4)); const s = Number(time.slice(4, 6))
    out.push(Date.UTC(y, mo - 1, d, h, mi, s) - (z ? 0 : zoneOffsetMs))
  }
  return out
}

/** Compare a UTC instant against an iCal-style UTC timestamp string. */
function parseRangeBound(raw) {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(raw ?? '')
  if (!m) return undefined
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}

function get(res, path) {
  const obj = state.objects.get(path) ?? state.contacts.get(path)
  if (!obj) { res.writeHead(404); return res.end() }
  res.writeHead(200, {
    'Content-Type': path.endsWith('.vcf') ? 'text/vcard; charset=utf-8' : 'text/calendar; charset=utf-8',
    'ETag': obj.etag,
  })
  res.end(obj.body)
}

function put(req, res, path, body) {
  const existing = state.objects.get(path)
  const ifMatch = req.headers['if-match']
  const ifNone = req.headers['if-none-match']
  // Validate the iCal envelope like iCloud does.
  if (!/BEGIN:VCALENDAR[\s\S]*END:VCALENDAR/.test(body) || !/BEGIN:VEVENT[\s\S]*END:VEVENT/.test(body)) {
    res.writeHead(403)
    return res.end('<D:error xmlns:D="DAV:"><C:valid-calendar-data/></D:error>')
  }
  const uid = /UID:(.+)/.exec(body)?.[1]?.trim()
  if (!existing && req.headers['if-none-match'] === '*') {
    // iCloud allows it; mimic success unless a different object shares the UID.
    const dup = [...state.objects].find(([h, o]) => h !== path && /UID:(.+)/.exec(o.body)?.[1]?.trim() === uid)
    if (dup) { res.writeHead(412); return res.end() }
  }
  if (ifMatch && ifMatch !== '*' && existing && existing.etag !== ifMatch) {
    res.writeHead(412)
    return res.end()
  }
  const etag = `"etag-${++counter}"`
  state.objects.set(path, { etag, body })
  res.writeHead(existing ? 204 : 201, { ETag: etag, Location: path })
  res.end()
  persist()
}

function del(req, res, path) {
  if (!state.objects.has(path)) { res.writeHead(404); return res.end() }
  state.objects.delete(path)
  res.writeHead(204)
  res.end()
  persist()
}

function persist() {
  if (!stateFile) return
  fs.writeFileSync(stateFile, JSON.stringify({
    objects: [...state.objects.entries()],
    contacts: [...state.contacts.entries()],
  }))
}

server.listen(port, '127.0.0.1', () => {
  const p = server.address().port
  process.stdout.write(`LISTENING ${p}\n`)
})
