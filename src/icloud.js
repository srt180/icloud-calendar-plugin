/**
 * iCloud account operations over CalDAV and CardDAV.
 *
 * Discovery follows the DAV convention iCloud implements: the home host
 * answers `current-user-principal`, which answers `calendar-home-set` /
 * `addressbook-home-set`. China-region accounts (`*.icloud.com.cn`, or an
 * account whose payload reports 云上贵州) are probed first and remembered, so
 * later calls skip the failed host. Every discovery result is cached per
 * account; a 401 drops the cache and retries once through the transport.
 */

import {
  DavSession, DavError, joinUrl, normalizeHref, sameHref, parseMultiStatus, prop, describeStatus, escapeXml,
} from './http.js'
import {
  dateToMs, expandRecurrence, formatInstant, formatUtc, parseICalendar, parseICalDate,
  projectAlarm, projectEvent, toICalDate, toICalZoned, utcToWall,
  zoneOffsetMs, zonedWallToUtc, isValidZone, escapeText,
} from './ical.js'
import { extractAddressData, parseVCard, contactMatches, searchKey } from './vcard.js'

/** Hosts probed for calendar service, in order. China-region first. */
const CALDAV_HOSTS = ['caldav.icloud.com.cn', 'caldav.icloud.com']
/** Hosts probed for contact service. */
const CARDDAV_HOSTS = ['contacts.icloud.com.cn', 'contacts.icloud.com']

const MAX_EVENTS = 500
const MAX_CONTACTS = 100

/** A per-account cached discovery record. */
class AccountState {
  constructor() {
    this.calendarHome = null
    this.addressbookHome = null
    /** @type {Map<string, string>} calendar href -> display name */
    this.calendarNames = new Map()
    /** @type {Map<string, string>} */
    this.addressbookNames = new Map()
    /** @type {string|null} */ this.zoneHint = null
    /** @type {string|null} */ this.region = null
    /** @type {Error|null} */ this.contactsError = null
    /** Last-seen events by href, so a delete can name the target. */
    this.seenEvents = new Map()
  }
}

/**
 * The iCloud integration exposed to the tools.
 */
export class ICloudAccount {
  /**
   * @param {object} options
   * @param {string} options.username - Apple ID.
   * @param {string} options.password - App 专用密码 (app-specific password).
   * @param {string} options.zone - IANA display zone.
   * @param {number} options.timeoutMs - per request budget.
   * @param {string} [options.calendarHost] - override for tests / private DAV servers.
   * @param {string} [options.contactsHost] - override for tests / private DAV servers.
   */
  constructor(options) {
    this.username = options.username
    this.zone = options.zone
    this.contactHost = options.contactsHost?.replace(/\/$/, '') ?? null
    this.calendarHost = options.calendarHost?.replace(/\/$/, '') ?? null
    this.state = new AccountState()
    this.inflight = new Map()
    this.session = new DavSession({
      username: options.username,
      password: options.password,
      userAgent: 'DSH-iCloudCalendar/1.0',
      timeoutMs: options.timeoutMs,
      proxy: options.proxy,
      onUnauthorized: () => this.resetDiscovery(),
    })
  }

  /** Drop every cached discovery result (after a 401 or an auth change). */
  resetDiscovery() {
    this.state = new AccountState()
    this.inflight.clear()
    this.session.lastAuthFailed = false
  }

  /**
   * Run discovery once per account even when tools are called in parallel.
   * @param {string} key
   * @param {() => Promise<any>} task
   */
  once(key, task) {
    const running = this.inflight.get(key)
    if (running) return running
    const p = task().finally(() => this.inflight.delete(key))
    this.inflight.set(key, p)
    return p
  }

  // -------------------------------------------------------------------------
  // Discovery
  // -------------------------------------------------------------------------

  /**
   * Probe the configured host list until one answers a principal request.
   * @param {string[]} hosts
   * @param {string} label
   * @returns {Promise<{ origin: string, principal: string }>}
   */
  async discoverBase(hosts, label) {
    /** @type {DavError|undefined} */
    let lastError
    for (const host of hosts) {
      const origin = `https://${host}`
      try {
        const principal = await this.findPrincipal(origin, label)
        return { origin, principal }
      } catch (err) {
        lastError = err
        // Only network/TLS failures mean "try the next region host"; an auth or
        // server error is the account's real answer.
        if (err instanceof DavError && ['ICLOUD_AUTH_FAILED', 'ICLOUD_FORBIDDEN', 'ICLOUD_HTTP_ERROR', 'ICLOUD_NOT_FOUND'].includes(err.code)) throw err
      }
    }
    throw lastError ?? new DavError(`${label}服务不可用`)
  }

  /**
   * `current-user-principal` from a DAV root.
   * @param {string} origin
   * @param {string} label
   * @returns {Promise<string>} absolute principal URL.
   */
  async findPrincipal(origin, label) {
    const body = davProbe('<d:current-user-principal/>')
    const headers = { 'Depth': '0', 'Content-Type': 'application/xml; charset=utf-8' }
    // iCloud answers its root anonymously; a server that challenges it gets one
    // authenticated retry before we conclude the credentials are wrong.
    let res = await this.session.request('PROPFIND', `${origin}/`, { headers, body, op: `发现${label}账号`, anonymous: true, acceptStatus: true })
    if (res.status === 401) {
      res = await this.session.request('PROPFIND', `${origin}/`, { headers, body, op: `发现${label}账号`, acceptStatus: true })
    }
    if (res.status < 200 || res.status >= 300) {
      throw new DavError(describeStatus(res.status, `发现${label}账号`, res.body), {
        status: res.status,
        code: res.status === 401 ? 'ICLOUD_AUTH_FAILED' : 'ICLOUD_DISCOVERY',
      })
    }
    const entries = parseMultiStatus(res.body)
    const principal = entries.length > 0 ? prop(entries[0], 'current-user-principal') : undefined
    if (!principal) {
      throw new DavError(`发现${label}账号失败：服务器未返回 principal。`, { code: 'ICLOUD_DISCOVERY', detail: res.body.slice(0, 200) })
    }
    return normalizeHref(principal, origin)
  }

  /**
   * Resolve both home collections, cached per account.
   * @returns {Promise<AccountState>}
   */
  async loadHomes() {
    return this.once('homes', async () => {
      const calendarHosts = this.calendarHost ? [stripScheme(this.calendarHost)] : CALDAV_HOSTS
      const contactsHosts = this.contactHost ? [stripScheme(this.contactHost)] : CARDDAV_HOSTS
      const calendarStage = (async () => {
        const { origin, principal } = await this.discoverBase(calendarHosts, '日历')
        this.state.calendarHome = await this.homeSet(principal, 'calendar-home-set', '日历')
        this.state.region = /icloud\.com\.cn$/.test(origin) ? 'cn' : 'global'
      })()
      const contactsStage = (async () => {
        const { origin, principal } = await this.discoverBase(contactsHosts, '通讯录')
        this.state.addressbookHome = await this.homeSet(principal, 'addressbook-home-set', '通讯录')
      })()
      // The two services live on different hosts; run them together. A
      // contacts failure must not take down the calendar tools, so it is kept
      // for the contact tools to report instead of failing discovery here.
      const [calendarResult, contactsResult] = await Promise.allSettled([calendarStage, contactsStage])
      this.state.contactsError = contactsResult.status === 'rejected' ? contactsResult.reason : null
      if (calendarResult.status === 'rejected') throw calendarResult.reason
      return this.state
    })
  }

  /**
   * Read a home-set property from the principal.
   * @param {string} principal
   * @param {string} property - `calendar-home-set` or `addressbook-home-set`.
   * @param {string} label
   */
  async homeSet(principal, property, label) {
    const body = davProbe(property === 'calendar-home-set'
      ? '<c:calendar-home-set xmlns:c="urn:ietf:params:xml:ns:caldav"/>'
      : '<c:addressbook-home-set xmlns:c="urn:ietf:params:xml:ns:carddav"/>')
    const res = await this.session.send('PROPFIND', principal, {
      headers: { 'Depth': '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      op: `发现${label}首页`,
    })
    const entries = parseMultiStatus(res.body)
    const href = entries.length > 0 ? prop(entries[0], property) : undefined
    if (!href) throw new DavError(`发现${label}首页失败：账号没有 ${property}。`, { code: 'ICLOUD_DISCOVERY' })
    return normalizeHref(href, principal)
  }

  /**
   * List the calendar collections under the calendar home.
   * @returns {Promise<Array<{ id: string, name: string, color?: string, readOnly: boolean, description?: string }>>}
   */
  async listCalendars() {
    await this.loadHomes()
    const home = this.state.calendarHome
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/" xmlns:ical="http://apple.com/ns/ical/">
  <d:prop>
    <d:displayname/>
    <d:resourcetype/>
    <d:current-user-privilege-set/>
    <d:supported-calendar-component-set/>
    <ical:calendar-color/>
    <c:calendar-description/>
  </d:prop>
</d:propfind>`
    const res = await this.session.send('PROPFIND', home, {
      headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      op: '读取日历列表',
    })
    const entries = parseMultiStatus(res.body)
    const calendars = []
    for (const entry of entries) {
      if (sameHref(normalizeHref(entry.href, home), home)) continue
      const names = entry.props.map(p => p.name)
      // Resource type markers arrive as their own local names (`collection`,
      // `calendar`); privilege markers do too (`read`, `write`).
      if (!names.includes('calendar')) continue
      const components = entry.props.filter(p => p.name === 'comp').map(p => (p.attrs.name ?? p.value)?.toUpperCase())
      if (components.length > 0 && !components.includes('VEVENT')) continue
      const privilegeNames = names.filter(n => ['read', 'write', 'write-content', 'read-current-user-privilege-set'].includes(n))
      const href = normalizeHref(entry.href, home)
      const name = prop(entry, 'displayname') || decodeURIComponent(href.split('/').pop() ?? '未命名日历')
      this.state.calendarNames.set(href, name)
      const color = prop(entry, 'calendar-color') ?? undefined
      calendars.push({
        id: href,
        name,
        ...(color ? { color: colorToHex(color) } : {}),
        ...(prop(entry, 'calendar-description') ? { description: prop(entry, 'calendar-description') } : {}),
        readOnly: privilegeNames.length > 0 && !privilegeNames.includes('write') && !privilegeNames.includes('write-content'),
      })
    }
    // iCloud lists mail/reminders collections too; only VEVENT calendars remain.
    return calendars
  }

  /**
   * Resolve a calendar by id (href), exact name, or case-insensitive name.
   * Defaults to the first writable calendar.
   * @param {string|undefined} ref
   * @param {object} [options]
   * @param {boolean} [options.requireWritable]
   * @returns {Promise<{ id: string, name: string, readOnly: boolean }>}
   */
  async resolveCalendar(ref, options = {}) {
    const calendars = await this.listCalendars()
    if (calendars.length === 0) {
      throw new DavError('该 iCloud 账号下没有可用的日历。请先在 iCloud.com 或“日历”App 中创建日历。', { code: 'ICLOUD_NO_CALENDAR' })
    }
    let hit
    if (!ref) {
      hit = calendars.find(c => !c.readOnly) ?? calendars[0]
    } else {
      const target = String(ref).trim()
      hit = calendars.find(c => c.id === target)
        ?? calendars.find(c => c.name === target)
        ?? calendars.find(c => c.name.toLowerCase() === target.toLowerCase())
        ?? calendars.find(c => searchKey(c.name) === searchKey(target))
    }
    if (!hit) {
      throw new DavError(`找不到日历「${ref}」。可用日历：${calendars.map(c => c.name).join('、')}`, { code: 'ICLOUD_CALENDAR_NOT_FOUND' })
    }
    if (options.requireWritable && hit.readOnly) {
      throw new DavError(`日历「${hit.name}」是只读的（订阅日历），无法在其中写入事件。请选择其他日历。`, { code: 'ICLOUD_CALENDAR_READONLY' })
    }
    return hit
  }

  // -------------------------------------------------------------------------
  // Events: read
  // -------------------------------------------------------------------------

  /**
   * Find events overlapping a window.
   * @param {object} query
   * @param {number} [query.fromMs]
   * @param {number} [query.toMs]
   * @param {string} [query.search] - case-insensitive substring of title/location/notes.
   * @param {string} [query.calendar] - calendar id or name.
   * @param {number} [query.limit]
   * @returns {Promise<{ events: object[], calendars: object[], truncated: boolean }>}
   */
  async findEvents(query) {
    await this.loadHomes()
    const calendars = await this.listCalendars()
    const targets = query.calendar
      ? [await this.resolveCalendar(query.calendar)]
      : calendars
    const fromMs = query.fromMs ?? Date.now() - 30 * 86400000
    const toMs = query.toMs ?? Date.now() + 365 * 86400000
    if (toMs <= fromMs) throw new DavError('查询结束时间必须晚于开始时间。', { code: 'ICLOUD_INVALID_RANGE' })
    const limit = Math.min(Math.max(1, query.limit ?? 100), MAX_EVENTS)
    const needles = (query.search ? [query.search] : []).map(searchKey).filter(Boolean)

    /** @type {object[]} */
    const collected = []
    for (const calendar of targets) {
      const hrefs = await this.calendarQuery(calendar.id, fromMs, toMs, query.search)
      // Fetch the resources serially; each 207/REPORT body carries the data.
      for (const item of hrefs) {
        const text = item.data ?? await this.fetchCalendarObject(item.href)
        if (!text) continue
        for (const ev of extractProjectedEvents(text, calendar, this.zone, { fromMs, toMs, href: item.href })) {
          if (needles.length > 0) {
            const haystack = searchKey([ev.title, ev.location, ev.notes].filter(Boolean).join(' '))
            if (!needles.every(n => haystack.includes(n))) continue
          }
          this.state.seenEvents.set(ev.id, { title: ev.title, start: ev.start })
          collected.push(ev)
        }
      }
    }
    const deduped = dedupeInstances(collected)
    deduped.sort((a, b) => String(a.start).localeCompare(String(b.start)))
    const events = deduped.slice(0, limit)
    return {
      events,
      calendars: calendars.map(c => ({ id: c.id, name: c.name })),
      truncated: deduped.length > limit,
    }
  }

  /**
   * ISSUE a time-range REPORT against one calendar; fall back to a full
   * Depth:1 PROPFIND when the server rejects the report shape.
   * @param {string} calendarHref
   * @param {number} fromMs
   * @param {number} toMs
   * @param {string} [search]
   * @returns {Promise<Array<{ href: string, data?: string }>>}
   */
  async calendarQuery(calendarHref, fromMs, toMs, search) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>
    <d:getetag/>
    <c:calendar-data/>
  </d:prop>
  <c:filter>
    <c:comp-filter name="VCALENDAR">
      <c:comp-filter name="VEVENT">
        ${search ? `<c:prop-filter name="SUMMARY"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>` : ''}
        <c:time-range start="${formatUtc(fromMs)}" end="${formatUtc(toMs)}"/>
      </c:comp-filter>
    </c:comp-filter>
  </c:filter>
</c:calendar-query>`
    let res
    try {
      res = await this.session.send('REPORT', calendarHref, {
        headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
        body,
        op: '查询事件',
      })
    } catch (err) {
      if (!(err instanceof DavError) || !(err.status === 400 || err.status === 415 || err.status === 403)) throw err
      return this.flatList(calendarHref)
    }
    const out = []
    for (const entry of parseMultiStatus(res.body)) {
      if (entry.status !== undefined && entry.status >= 400) continue
      const data = prop(entry, 'calendar-data')
      out.push({ href: normalizeHref(entry.href, calendarHref), data: data?.trim() || undefined })
    }
    return out
  }

  /** Full Depth:1 enumeration of a collection (fallback when REPORT fails). */
  async flatList(collection) {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><c:calendar-data/></d:prop>
</d:propfind>`
    const res = await this.session.send('PROPFIND', collection, {
      headers: { 'Depth': '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      op: '列出日历条目',
    })
    const out = []
    for (const entry of parseMultiStatus(res.body)) {
      const data = prop(entry, 'calendar-data')
      if (!data) continue
      out.push({ href: normalizeHref(entry.href, collection), data })
    }
    return out
  }

  /**
   * Title and start of a recently listed event, or undefined.
   * @param {string} href
   * @returns {{ title?: string, start?: string } | undefined}
   */
  describeEvent(href) {
    return this.state.seenEvents.get(normalizeEventHref(href, this.state.calendarHome ?? ''))
  }

  /** Fetch one .ics resource body + etag. */
  async fetchCalendarObject(href) {
    const res = await this.session.send('GET', href, {
      headers: { Accept: 'text/calendar' },
      op: '读取事件',
    })
    return res.body
  }

  /** Fetch one .vcf resource body + etag. */
  async fetchAddressObject(href) {
    const res = await this.session.send('GET', href, { headers: { Accept: 'text/vcard' }, op: '读取联系人' })
    return res.body
  }

  // -------------------------------------------------------------------------
  // Events: write
  // -------------------------------------------------------------------------

  /**
   * Create or update one event.
   * @param {object} input - normalised event fields.
   * @returns {Promise<object>}
   */
  async saveEvent(input) {
    const calendar = await this.resolveCalendar(input.calendar, { requireWritable: true })
    let existing = null
    let etag
    if (input.id) {
      const href = normalizeEventHref(input.id, calendar.id)
      const current = await this.session.request('GET', href, { op: '读取待修改事件', acceptStatus: true })
      if (current.status === 404) {
        throw new DavError('要修改的事件不存在（404）。它可能已在其他设备上被删除。', { code: 'ICLOUD_NOT_FOUND', status: 404 })
      }
      if (current.status < 200 || current.status >= 300) {
        throw new DavError(`读取待修改事件失败：HTTP ${current.status}`, { code: 'ICLOUD_HTTP_ERROR', status: current.status })
      }
      existing = current.body
      etag = current.headers['etag']
      calendar.id = href.replace(/\/[^/]+$/, '')
    }

    const { ics, uid, hrefSuffix } = buildCalendar(input, existing, this.zone)
    const targetHref = input.id
      ? normalizeEventHref(input.id, calendar.id)
      : joinUrl(calendar.id, `${hrefSuffix}.ics`)

    const headers = {
      'Content-Type': 'text/calendar; charset=utf-8',
      'If-None-Match': '*',
    }
    // iCloud expects `If-Match: "<etag>"` only when the caller read the etag.
    if (input.id && etag) headers['If-Match'] = etag
    else if (input.id) delete headers['If-None-Match']

    const res = await this.session.request('PUT', targetHref, {
      headers: { ...headers, 'Prefer': 'return=representation' },
      body: ics,
      op: input.id ? '保存事件修改' : '创建事件',
      acceptStatus: true,
    })
    if (res.status === 412) {
      throw new DavError('保存失败：该事件在你读取后被其他设备修改（412）。请重新读取事件后再修改。', { code: 'ICLOUD_PRECONDITION_FAILED', status: 412 })
    }
    if (res.status < 200 || res.status >= 300) {
      const detail = res.body?.slice(0, 300)
      throw new DavError(`保存事件失败：HTTP ${res.status}${detail ? `（${detail}）` : ''}`, { code: 'ICLOUD_HTTP_ERROR', status: res.status })
    }

    // 200/204 put the object at the requested URI; 201 means the server
    // created it elsewhere (MOVE redirects); read the Location header.
    let finalHref = targetHref
    const location = res.headers['location']
    if (location) finalHref = normalizeHref(location, calendar.id)
    const created = !input.id
    const reread = await this.session.request('GET', finalHref, { op: '回读事件', acceptStatus: true })
    const icsFinal = reread.status >= 200 && reread.status < 300 ? reread.body : ics
    const events = extractProjectedEvents(icsFinal, calendar, this.zone, { href: finalHref })
    const event = events.find(e => e.recurrenceId === undefined) ?? events[0] ?? { id: finalHref, title: input.title }
    return {
      event: { ...event, id: finalHref, calendarId: calendar.id, calendarName: calendar.name, uid },
      created,
      calendar: { id: calendar.id, name: calendar.name },
    }
  }

  /**
   * Delete one event, or a single occurrence of a recurring event.
   * @param {object} input
   * @param {string} input.id - event href.
   * @param {string} [input.occurrenceStart] - ISO start of the occurrence to skip.
   * @param {string} [input.scope] - 'occurrence' (default for recurrence-id) or 'series'.
   */
  async deleteEvent(input) {
    await this.loadHomes()
    const href = normalizeEventHref(input.id, this.state.calendarHome ?? '')
    if (input.occurrenceStart) {
      // Removing one occurrence: add an EXDATE to the master (iCloud's own
      // behaviour for "delete this event only").
      const current = await this.session.request('GET', href, { op: '读取待修改事件', acceptStatus: true })
      if (current.status === 404) throw new DavError('要删除的事件不存在（404）。', { code: 'ICLOUD_NOT_FOUND', status: 404 })
      if (current.status < 200 || current.status >= 300) throw new DavError(`读取事件失败：HTTP ${current.status}`, { code: 'ICLOUD_HTTP_ERROR' })
      const next = addExDate(current.body, input.occurrenceStart, this.zone)
      const headers = { 'Content-Type': 'text/calendar; charset=utf-8' }
      if (current.headers['etag']) headers['If-Match'] = current.headers['etag']
      await this.session.send('PUT', href, { headers, body: next, op: '删除单次事件' })
      return { deleted: true, id: href, scope: 'occurrence', occurrenceStart: input.occurrenceStart }
    }
    await this.session.send('DELETE', href, { headers: { Prefer: 'return=minimal' }, op: '删除事件' })
    return { deleted: true, id: href, scope: 'series' }
  }

  // -------------------------------------------------------------------------
  // Contacts
  // -------------------------------------------------------------------------

  /**
   * List address books.
   * @returns {Promise<Array<{ id: string, name: string, readOnly?: boolean }>>}
   */
  async listAddressBooks() {
    await this.loadHomes()
    if (this.state.contactsError) {
      const reason = this.state.contactsError
      throw new DavError(`iCloud 通讯录服务不可用：${reason.message ?? reason}`, {
        code: reason.code ?? 'ICLOUD_CONTACTS_UNAVAILABLE',
        status: reason.status,
      })
    }
    const home = this.state.addressbookHome
    const body = `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/></d:prop>
</d:propfind>`
    const res = await this.session.send('PROPFIND', home, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      op: '读取通讯录列表',
    })
    const books = []
    for (const entry of parseMultiStatus(res.body)) {
      const href = normalizeHref(entry.href, home)
      if (sameHref(href, home)) continue
      if (!entry.props.some(p => p.name === 'addressbook')) continue
      const name = prop(entry, 'displayname') || decodeURIComponent(href.split('/').pop() ?? '通讯录')
      this.state.addressbookNames.set(href, name)
      books.push({ id: href, name })
    }
    return books
  }

  /**
   * Address-book REPORT by name substring with a client-side filter fallback.
   * @param {string} book
   * @param {string} [search]
   * @returns {Promise<Array<{ href: string, vcard: string }>>}
   */
  async addressQuery(book, search) {
    // Omit the filter entirely when there is no term: several servers reject an
    // unfiltered addressbook-query, and `Depth: 1` + `address-data` enumerates.
    const textMatch = search
      ? `<c:filter test="anyof">
          <c:prop-filter name="FN"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>
          <c:prop-filter name="N"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>
          <c:prop-filter name="EMAIL"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>
          <c:prop-filter name="ORG"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>
          <c:prop-filter name="NICKNAME"><c:text-match collation="i;unicode-casemap" match-type="contains">${escapeXml(search)}</c:text-match></c:prop-filter>
        </c:filter>`
      : ''
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:addressbook-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:carddav">
  <d:prop><d:getetag/><c:address-data/></d:prop>
  ${textMatch}
</c:addressbook-query>`
    const res = await this.session.send('REPORT', book, {
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body,
      op: '搜索联系人',
    })
    return extractAddressData(res.body).map(x => ({ href: normalizeHref(x.href, book), vcard: x.vcard }))
  }

  /**
   * Search contacts across address books, with a client-side phonetic filter.
   * @param {object} query
   * @param {string} [query.search]
   * @param {string} [query.addressbook]
   * @param {number} [query.limit]
   * @returns {Promise<{ contacts: object[], addressbooks: object[], truncated: boolean }>}
   */
  async findContacts(query) {
    await this.loadHomes()
    const books = await this.listAddressBooks()
    const targets = query.addressbook
      ? books.filter(b => b.id === query.addressbook || searchKey(b.name) === searchKey(query.addressbook))
      : books
    if (query.addressbook && targets.length === 0) {
      throw new DavError(`找不到通讯录「${query.addressbook}」。可用通讯录：${books.map(b => b.name).join('、')}`, { code: 'ICLOUD_ADDRESSBOOK_NOT_FOUND' })
    }
    const limit = Math.min(Math.max(1, query.limit ?? 25), MAX_CONTACTS)
    const needle = query.search ? searchKey(query.search) : ''
    /** @type {Map<string, object>} */
    const seen = new Map()

    for (const book of targets) {
      let hits = []
      try {
        hits = await this.addressQuery(book.id, query.search)
      } catch (err) {
        if (!(err instanceof DavError) || ![400, 403, 415].includes(err.status ?? 0)) throw err
        hits = []
      }
      if (hits.length === 0) {
        // No server-side match (or text-match unsupported): enumerate all cards
        // and filter client-side, which also covers pinyin-initial lookups and
        // phone-digit formatting that no server-side matcher handles.
        hits = await this.addressQuery(book.id, undefined).catch(() => [])
      }
      for (const hit of hits) {
        const contact = parseVCard(hit.vcard, { href: hit.href, addressbookName: book.name })
        if (!contact) continue
        if (!contactMatches(contact, needle)) continue
        if (!seen.has(contact.id)) seen.set(contact.id, contact)
      }
    }
    const contacts = [...seen.values()]
    contacts.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return {
      contacts: contacts.slice(0, limit),
      addressbooks: books.map(b => ({ id: b.id, name: b.name })),
      truncated: contacts.length > limit,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Strip a scheme from a configured host (`https://host` -> `host`). */
function stripScheme(host) {
  return host.replace(/^https?:\/\//, '').replace(/\/+$/, '')
}

/** PROPFIND body around one property element. */
function davProbe(inner) {
  return `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop>${inner}</d:prop>
</d:propfind>`
}

/** iCal writes #RRGGBBAA; the UI shows #RRGGBB. */
function colorToHex(color) {
  const m = /^#([0-9a-fA-F]{6})/.exec(String(color).trim())
  return m ? `#${m[1].toLowerCase()}` : String(color).trim()
}

/**
 * Normalize a model-supplied event or contact href.
 * Accepts an absolute URL, a path, or a bare resource name; in the last two
 * cases `base` (the collection URL or the calendar home) supplies the host.
 * @param {string} id
 * @param {string} base
 */
export function normalizeEventHref(id, base) {
  const raw = String(id ?? '').trim()
  if (!raw) throw new DavError('缺少事件 id。', { code: 'ICLOUD_INVALID_INPUT' })
  if (/^https?:\/\//i.test(raw)) return normalizeHref(raw, base)
  if (!base) throw new DavError(`无法解析事件 id「${raw}」：请使用查询结果中返回的完整 id。`, { code: 'ICLOUD_INVALID_ID' })
  if (raw.startsWith('/')) return normalizeHref(raw, base)
  return `${String(base).replace(/\/+$/, '')}/${raw}`
}

/**
 * Parse one .ics text into projected events, expanding recurrence inside the
 * requested window when the caller is doing an agenda query.
 * @param {string} text
 * @param {{ id: string, name: string }} calendar
 * @param {string} zone
 * @param {{ fromMs?: number, toMs?: number, href?: string }} [window]
 * @returns {object[]}
 */
export function extractProjectedEvents(text, calendar, zone, window = {}) {
  const { events } = parseICalendar(text)
  const principals = events.filter(ev => ev.get('RECURRENCE-ID') === undefined)
  const out = []
  for (const ev of principals) {
    const projected = projectEvent(ev, { zone, calendarId: calendar.id, calendarName: calendar.name }, window.href)
    const alarmBlocks = ev.alarmBlocks ?? []
    if (alarmBlocks.length > 0) {
      const alarm = projectAlarm(alarmBlocks[0])
      if (alarm) projected.alarm = alarm
    }
    const startMs = dateToMs(ev.date('DTSTART', zone), zone)
    if (projected.recurring && startMs !== undefined) {
      const endMs = dateToMs(ev.date('DTEND', zone), zone)
        ?? (ev.get('DURATION') ? startMs + parseDuration(ev.get('DURATION').value) : startMs)
      // EXDATE values are reduced to the zones-aware instant they denote.
      const exdates = ev.getAll('EXDATE').flatMap((p) => {
        const tz = p.params?.TZID?.[0]
        return p.value.split(',').map((v) => {
          const d = parseICalDate(v.trim(), tz ? { ...p.params, TZID: [tz] } : p.params, zone)
          return dateToMs(d, zone)
        }).filter(x => x !== undefined)
      })
      const fromMs = window.fromMs ?? startMs
      const toMs = window.toMs ?? startMs + 366 * 86400000
      const occ = expandRecurrence({
        startMs,
        rule: projected.rrule,
        fromMs,
        toMs,
        zone,
        allDay: Boolean(projected.allDay),
        exdates,
      })
      if (occ.length === 0) continue // recurrence never reaches the window
      const duration = endMs - startMs
      const laterInstants = occ.slice(1)
      projected.start = formatInstant(occ[0], zone, Boolean(projected.allDay))
      projected.end = formatInstant(occ[0] + duration, zone, Boolean(projected.allDay))
      // The model needs every instant this window covers, not just the first.
      projected.occurrences = occ.length
      projected.otherStarts = laterInstants.map(ms => formatInstant(ms, zone, Boolean(projected.allDay)))
    }
    out.push(projected)
  }
  return out
}

function parseDuration(raw) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(raw ?? '').trim().toUpperCase())
  if (!m) return 0
  const sign = m[1] === '-' ? -1 : 1
  const [, , w, d, h, mi, s] = m
  return sign * ((((Number(w || 0) * 7 + Number(d || 0)) * 24 + Number(h || 0)) * 60 + Number(mi || 0)) * 60 + Number(s || 0)) * 1000
}

/** Remove duplicate (same href + same start) results. */
function dedupeInstances(events) {
  const seen = new Set()
  const out = []
  for (const ev of events) {
    const key = `${ev.id ?? ''}|${ev.uid ?? ''}|${ev.start}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ev)
  }
  return out
}

/**
 * Add an EXDATE for one occurrence to an existing VCALENDAR text.
 * @param {string} ics
 * @param {string} occurrenceStart - ISO date-time (with offset) or date.
 * @param {string} zone
 */
export function addExDate(ics, occurrenceStart, zone) {
  const folded = String(ics).replace(/\r\n?/g, '\n').split('\n')
  const dtstartIdx = folded.findIndex(l => /^DTSTART[;:]/i.test(l))
  if (dtstartIdx === -1) throw new DavError('该事件没有 DTSTART，无法单独删除某一次发生。', { code: 'ICLOUD_INVALID_ICS' })
  const dtstartLine = folded[dtstartIdx]
  // Match the DTSTART form exactly: a VALUE=DATE-TIME with TZID needs an
  // EXDATE with the same TZID and a wall clock; a VALUE=DATE needs a date.
  const isAllDay = /VALUE=DATE\b/i.test(dtstartLine.split(':')[0])
  const target = parseLocalInput(occurrenceStart, zone)
  if (!target) throw new DavError(`无法识别的发生时间：${occurrenceStart}`, { code: 'ICLOUD_INVALID_INPUT' })
  let line
  if (isAllDay) {
    line = `EXDATE;VALUE=DATE:${toICalDate(target.year, target.month, target.day)}`
  } else {
    const tzid = /;TZID=([^;:]+)/i.exec(dtstartLine)?.[1]
    if (tzid) {
      line = `EXDATE;TZID=${tzid}:${toICalDate(target.year, target.month, target.day)}T${pad2(target.hour)}${pad2(target.minute)}${pad2(target.second)}`
    } else {
      line = `EXDATE:${toICalDate(target.year, target.month, target.day)}T${pad2(target.hour)}${pad2(target.minute)}${pad2(target.second)}Z`
    }
  }
  folded.splice(dtstartIdx + 1, 0, line)
  return foldLines(folded.filter(l => l.length > 0 && l !== '\r')).join('\r\n') + '\r\n'
}

/** Zero-pad two digits. */
function pad2(n) {
  return String(Math.trunc(Number(n))).padStart(2, '0')
}

/**
 * Interpret a model-supplied local time as wall clock in `zone`, unless it
 * carries an explicit offset.
 * @param {string} input
 * @param {string} zone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number, offsetMs?: number }|null}
 */
export function parseLocalInput(input, zone) {
  const s = String(input ?? '').trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/.exec(s)
  if (!m) return null
  const year = Number(m[1]); const month = Number(m[2]); const day = Number(m[3])
  const hour = m[4] === undefined ? 0 : Number(m[4])
  const minute = m[5] === undefined ? 0 : Number(m[5])
  const second = m[6] === undefined ? 0 : Number(m[6])
  let offsetMs
  if (m[7] === 'Z' || m[7] === 'z') offsetMs = 0
  else if (m[7]) {
    const sign = m[7][0] === '-' ? -1 : 1
    const digits = m[7].slice(1).replace(':', '')
    offsetMs = sign * (Number(digits.slice(0, 2)) * 3600000 + Number(digits.slice(2)) * 60000)
  }
  return { year, month, day, hour, minute, second, offsetMs, dateOnly: m[4] === undefined }
}

/** Fold content lines at 75 octets as iCal requires. */
export function foldLines(lines) {
  const out = []
  for (const line of lines) {
    const bytes = Buffer.from(line, 'utf8')
    if (bytes.length <= 75) { out.push(line); continue }
    let current = ''
    let currentBytes = 0
    let first = true
    for (const ch of line) {
      const chBytes = Buffer.byteLength(ch, 'utf8')
      const limit = first ? 74 : 74
      if (currentBytes + chBytes > limit) {
        out.push(first ? current : ` ${current}`)
        first = false
        current = ''
        currentBytes = 0
      }
      current += ch
      currentBytes += chBytes
    }
    if (current.length > 0) out.push(first ? current : ` ${current}`)
  }
  return out
}

/**
 * Build a VCALENDAR text for a new event or an update to an existing one.
 *
 * On update the existing text is the base: unknown properties and VALARMs
 * survive, and only the fields the caller actually set are replaced.
 *
 * @param {object} input - normalised fields (see calendar.js).
 * @param {string|null} existing - current .ics text.
 * @param {string} zone
 * @returns {{ ics: string, uid: string, hrefSuffix: string }}
 */
export function buildCalendar(input, existing, zone) {
  const nowUtc = formatUtc(Date.now())
  const parsed = existing ? parseICalendar(existing) : { events: [] }
  const master = parsed.events.find(ev => ev.get('RECURRENCE-ID') === undefined) ?? parsed.events[0]
  const baseLines = existing
    ? String(existing).replace(/\r\n?/g, '\n').split('\n').filter((l, i, arr) => l.length > 0 || i < arr.length - 1)
    : []

  const uid = master?.get('UID')?.value ?? input.uid ?? `${cryptoUuid()}`
  const tzid = isValidZone(input.timeZone ?? '') ? input.timeZone : zone
  const allDay = input.allDay
  const created = master?.get('CREATED')?.value
  const sequence = master?.get('SEQUENCE')?.value

  // Remove the properties this call replaces, keeping everything else.
  const replaceNames = new Set(['DTSTART', 'DTEND', 'SUMMARY', 'SEQUENCE', 'DTSTAMP', 'LAST-MODIFIED', 'STATUS'])
  if (input.clearFields?.includes('location') || input.location !== undefined) replaceNames.add('LOCATION')
  if (input.clearFields?.includes('notes') || input.notes !== undefined) replaceNames.add('DESCRIPTION')
  if (input.clearFields?.includes('alarm') || input.alarm !== undefined) replaceNames.add('VALARM')
  if (input.clearFields?.includes('recurrence') || input.recurrence !== undefined) replaceNames.add('RRULE')
  if (input.clearFields?.includes('attendees') || input.attendees !== undefined) replaceNames.add('ATTENDEE')
  if (input.clearFields?.includes('url') || input.url !== undefined) replaceNames.add('URL')

  const kept = []
  if (existing && master) {
    let inAlarm = false
    for (const rawLine of baseLines) {
      const upper = rawLine.toUpperCase()
      if (/^BEGIN:VALARM/.test(upper)) { inAlarm = true }
      if (inAlarm) {
        if (/^END:VALARM/.test(upper)) { inAlarm = false }
        if (!replaceNames.has('VALARM')) kept.push(rawLine)
        continue
      }
      const name = /^([A-Za-z0-9-]+)[;:]/.exec(rawLine)?.[1]?.toUpperCase()
      if (!name) { kept.push(rawLine); continue }
      if (['BEGIN', 'END', 'VERSION', 'PRODID', 'CALSCALE'].includes(name)) continue // rebuilt below
      if (!replaceNames.has(name)) kept.push(rawLine)
    }
  }

  const start = resolveStart(input, tzid, zone)
  if (input.end !== undefined) {
    // Same parsing as `start`: a bare local time belongs to the event zone,
    // while an explicit offset is honoured.
    const resolved = resolveEnd(input.end, tzid, zone, allDay)
    if (resolved.endMs !== undefined) input.endMs = resolved.endMs
    else if (resolved.endDayDate) {
      const far = new Date(Date.UTC(input.endDayAnchor?.y ?? start.date.y, 0, 1))
      void far
      input.durationDays = Math.max(1, (() => {
        const a = new Date(Date.UTC(start.date.y, start.date.mo - 1, start.date.d))
        const b = new Date(Date.UTC(resolved.endDayDate.y, resolved.endDayDate.mo - 1, resolved.endDayDate.d))
        return Math.round((b - a) / 86400000) + 1
      })())
    }
  }
  const dtstart = allDay
    ? `DTSTART;VALUE=DATE:${toICalDate(start.date.y, start.date.mo, start.date.d)}`
    : `DTSTART${toICalZoned(start.ms, tzid).params}:${toICalZoned(start.ms, tzid).value}`
  const endMs = allDay
    // DTEND for VALUE=DATE is exclusive: a one-day event ends the next day.
    ? zonedWallToUtc(tzid, ...(() => {
        const days = Math.max(1, input.durationDays ?? 1)
        const d = new Date(Date.UTC(start.date.y, start.date.mo - 1, start.date.d + days))
        return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), 0, 0, 0]
      })())
    // A caller-provided end wins, then a duration, then the one-hour default.
    : (input.endMs !== undefined && input.endMs > start.ms
        ? input.endMs
        : start.ms + (input.durationMs ?? 3600000))
  const dtend = allDay
    ? `DTEND;VALUE=DATE:${(() => {
        const w = utcToWall(tzid, endMs)
        return toICalDate(w.year, w.month, w.day)
      })()}`
    : `DTEND${toICalZoned(endMs, tzid).params}:${toICalZoned(endMs, tzid).value}`

  const block = []
  block.push('BEGIN:VCALENDAR')
  block.push('VERSION:2.0')
  block.push('PRODID:-//DeepSeek Harness//iCloud Calendar Plugin//CN')
  block.push('CALSCALE:GREGORIAN')
  block.push('METHOD:PUBLISH')
  block.push('BEGIN:VEVENT')
  block.push(`UID:${uid}`)
  block.push(`DTSTAMP:${nowUtc}`)
  if (created) block.push(`CREATED:${created}`)
  block.push(`LAST-MODIFIED:${nowUtc}`)
  const nextSequence = input.recurrence !== undefined || input.title !== undefined
    ? String(Number(sequence ?? 0) + 1)
    : String(Number(sequence ?? 0))
  block.push(`SEQUENCE:${nextSequence}`)
  block.push(dtstart)
  block.push(dtend)
  if (input.recurrence !== undefined) block.push(`RRULE:${input.recurrence}`)
  if (input.title !== undefined) block.push(`SUMMARY:${escapeText(input.title)}`)
  if (input.location !== undefined) block.push(`LOCATION:${escapeText(input.location)}`)
  if (input.notes !== undefined) block.push(`DESCRIPTION:${escapeText(input.notes)}`)
  if (input.url !== undefined) block.push(`URL:${input.url}`)
  if (input.status) block.push(`STATUS:${String(input.status).toUpperCase()}`)
  if (input.attendees?.length) {
    for (const a of input.attendees) {
      const cn = a.name ? `;CN=${escapeText(a.name)}` : ''
      block.push(`ATTENDEE;PARTSTAT=NEEDS-ACTION;ROLE=REQ-PARTICIPANT;CUTYPE=INDIVIDUAL${cn}:mailto:${a.email}`)
    }
  }
  if (input.alarm !== undefined && input.alarm !== null && input.alarm !== 0) {
    block.push('BEGIN:VALARM')
    block.push(`ACTION:${input.alarm.action ? String(input.alarm.action).toUpperCase() : 'DISPLAY'}`)
    block.push(`DESCRIPTION:${escapeText(input.alarm.description ?? input.title ?? 'Reminder')}`)
    block.push(`TRIGGER;RELATED=${input.alarm.relativeTo === 'end' ? 'END' : 'START'}:-PT${Math.max(0, Math.round(input.alarm.minutesBefore))}M`)
    block.push('END:VALARM')
  }

  // End the VEVENT before any preserved blocks (VCALENDAR properties such as
  // X-WR-CALNAME); iCloud tolerates them at either position.
  const calendarLevel = kept.filter(l => /^X-WR-|^CALSCALE|^METHOD/i.test(l))
  const eventLevel = kept.filter(l => !calendarLevel.includes(l))
  block.push(...eventLevel)
  block.push('END:VEVENT')
  block.push(...calendarLevel.filter(l => !/^CALSCALE|^METHOD/i.test(l)))
  block.push('END:VCALENDAR')

  const ics = foldLines(block).join('\r\n') + '\r\n'
  return { ics, uid, hrefSuffix: sanitizeFilename(uid) }
}

/** Start instant and (for all-day) local date from the input. */
function resolveStart(input, tzid, zone) {
  if (input.start) {
    const parsed = parseLocalInput(input.start, zone)
    if (!parsed) throw new DavError(`无法识别开始时间「${input.start}」。请使用 2026-11-20 或 2026-11-20T09:30 格式。`, { code: 'ICLOUD_INVALID_TIME' })
    const date = { y: parsed.year, mo: parsed.month, d: parsed.day }
    if (input.allDay) return { date, ms: zonedWallToUtc(tzid, date.y, date.mo, date.d, 0, 0, 0) }
    const ms = parsed.offsetMs !== undefined
      ? Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second) - parsed.offsetMs
      : zonedWallToUtc(tzid, parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second)
    return { date: { y: utcToWall(tzid, ms).year, mo: utcToWall(tzid, ms).month, d: utcToWall(tzid, ms).day }, ms }
  }
  if (input.allDay) {
    const now = utcToWall(tzid, Date.now())
    return { date: { y: now.year, mo: now.month, d: now.day }, ms: zonedWallToUtc(tzid, now.year, now.month, now.day, 0, 0, 0) }
  }
  throw new DavError('创建事件需要提供开始时间 start。', { code: 'ICLOUD_INVALID_INPUT' })
}

/**
 * Resolve a model-supplied end value to an absolute instant, or to a day count
 * for an all-day span. Uses the same parsing rules as `start`, so
 * `2016-11-20T15:00+08:00` and a bare local time agree.
 * @param {string} end - end value from the tool arguments.
 * @param {string} tzid - event zone.
 * @param {string} zone - display zone, for values without an offset.
 * @param {boolean} allDay
 * @returns {{ endMs?: number, durationDays?: number }}
 */
export function resolveEnd(end, tzid, zone, allDay) {
  const parsed = parseLocalInput(end, zone)
  if (!parsed) throw new DavError(`无法识别结束时间「${end}」。请使用 2026-11-20 或 2026-11-20T09:30 格式。`, { code: 'ICLOUD_INVALID_TIME' })
  if (allDay || parsed.dateOnly) {
    // Count exclusive days between the start date and the end date.
    return { endDayDate: { y: parsed.year, mo: parsed.month, d: parsed.day } }
  }
  const endMs = parsed.offsetMs !== undefined
    ? Date.UTC(parsed.year, parsed.month - 1, parsed.day, parsed.hour, parsed.minute, parsed.second) - parsed.offsetMs
    : zonedWallToUtc(tzid, parsed.year, parsed.month, parsed.day, parsed.hour, parsed.minute, parsed.second)
  return { endMs }
}

/** UUID v4, prefixed like iCloud's own resource names. */
function cryptoUuid() {
  const c = typeof globalThis.crypto?.randomUUID === 'function' ? globalThis.crypto.randomUUID() : (() => {
    const b = Buffer.alloc(16)
    for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
    b[6] = (b[6] & 0x0f) | 0x40
    b[8] = (b[8] & 0x3f) | 0x80
    const h = b.toString('hex')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  })()
  return `${c}`
}

/** RFC 4122 appendix A style URL for the resource name. */
function sanitizeFilename(uid) {
  return uid.replace(/[^A-Za-z0-9-]/g, '').slice(0, 64) || cryptoUuid().replace(/-/g, '')
}

/** Expose internals used by tests without widening the production API. */
export const __test = {
  parseDuration,
  toICalZoned,
  zoneOffsetMs,
  utcToWall,
  zonedWallToUtc,
}
