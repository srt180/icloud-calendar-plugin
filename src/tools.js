/**
 * Model-facing tool definitions.
 *
 * Names mirror the capability described by the OpenAI iCloud Calendar plugin
 * (list calendars, find events, create or change events, look up contacts),
 * split into create/update/delete so a destructive intent is never inferred
 * from a vague "change" argument.
 *
 * Schemas are plain JSON Schema (the DSH tool registry accepts the raw
 * `JsonSchemaNode` wire form): every parameter is an object property, and each
 * object node declares `additionalProperties: false` explicitly.
 */

import { DavError } from './http.js'

/** @typedef {{ type: string, required?: boolean, description?: string, enum?: string[], items?: object, oneOf?: object[], properties?: object, additionalProperties?: boolean, default?: unknown }} Node */

const CALENDAR_PARAM = {
  type: 'string',
  description: '日历名称或 id（取自 list_iCloud_calendars 的结果）。省略时使用第一个可写日历。',
}

const EVENT_ID_PARAM = {
  type: 'string',
  description: '事件 id（取自 find_iCloud_events 的结果；即该事件的 .ics 资源 URL）。',
}

const TIME_PARAM = (label) => ({
  type: 'string',
  description: `${label}，本地时间格式 2026-11-20 或 2026-11-20T09:30；带偏移量（如 +08:00 / Z）时按偏移量解释。全天事件只写日期。`,
})

/**
 * Build the tool set bound to one account instance.
 * @param {import('./icloud.js').ICloudAccount} account
 * @param {{ defaultZone: string, maxResults?: number }} options
 */
export function buildTools(account, options) {
  const zone = options.defaultZone
  const now = () => new Date(account.now?.() ?? Date.now())

  /** Resolve a `range` + `after`/`before` pair into absolute ms. */
  function resolveWindow(args) {
    const base = now()
    let from = args.after ? parseBound(args.after) : undefined
    let to = args.before ? parseBound(args.before, true) : undefined
    if (from === undefined && to === undefined) {
      const range = args.range ?? 'this_week'
      const start = startOfLocalDay(base, zone)
      const weekday = new Date(start).getUTCDay() // start is UTC midnight of the local date
      switch (range) {
        case 'today': from = start; to = start + 86400000; break
        case 'tomorrow': from = start + 86400000; to = start + 2 * 86400000; break
        case 'yesterday': from = start - 86400000; to = start; break
        case 'this_week': {
          // Monday-based week, matching the Chinese calendar convention.
          const sinceMonday = (weekday + 6) % 7
          from = start - sinceMonday * 86400000
          to = from + 7 * 86400000
          break
        }
        case 'next_week': {
          const sinceMonday = (weekday + 6) % 7
          from = start - sinceMonday * 86400000 + 7 * 86400000
          to = from + 7 * 86400000
          break
        }
        case 'last_week': {
          const sinceMonday = (weekday + 6) % 7
          from = start - (sinceMonday + 7) * 86400000
          to = from + 7 * 86400000
          break
        }
        case 'this_month': from = startOfMonth(base, zone); to = startOfNextMonth(base, zone); break
        case 'next_month': from = startOfNextMonth(base, zone); to = startOfNextMonth(new Date(startOfNextMonth(base, zone)), zone); break
        case 'next_7_days': from = start; to = start + 7 * 86400000; break
        case 'next_30_days': from = start; to = start + 30 * 86400000; break
        case 'past_30_days': from = start - 30 * 86400000; to = start + 86400000; break
        default: from = start; to = start + 7 * 86400000
      }
    }
    if (to === undefined) to = (from ?? 0) + 7 * 86400000
    if (from === undefined) from = to - 7 * 86400000
    return { fromMs: from, toMs: to }
  }

  /** Parse an ISO-ish bound in the display zone. */
  function parseBound(value, endOfDay = false) {
    const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(String(value).trim())
    if (!m) {
      throw new DavError(`无法识别日期「${value}」。请使用 2026-11-20 或 2026-11-20T09:30 格式。`, { code: 'ICLOUD_INVALID_TIME' })
    }
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const dateOnly = m[4] === undefined
    const h = dateOnly ? 0 : Number(m[4])
    const mi = dateOnly ? 0 : Number(m[5])
    const s = m[6] ? Number(m[6]) : 0
    if (m[7] && m[7] !== 'Z') {
      const sign = m[7][0] === '-' ? -1 : 1
      const digits = m[7].slice(1).replace(':', '')
      const offset = sign * (Number(digits.slice(0, 2)) * 3600000 + Number(digits.slice(2)) * 60000)
      return Date.UTC(y, mo - 1, d, h, mi, s) - offset
    }
    const ms = zonedWall(y, mo - 1, d, h, mi, s)
    return dateOnly && endOfDay ? ms + 86400000 : ms
  }

  /** Wall-clock -> UTC using the display zone. */
  function zonedWall(y, mo, d, h, mi, s) {
    const naive = Date.UTC(y, mo, d, h, mi, s)
    const first = zoneOffset(naive)
    const second = zoneOffset(naive - first)
    return naive - second
  }

  /** Offset (ms) of the display zone at an instant. */
  function zoneOffset(utcMs) {
    const parts = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(utcMs))) parts[p.type] = p.value
    const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second))
    return asUtc - utcMs
  }

  /** UTC ms of local midnight for the day containing `ms`. */
  function startOfLocalDay(ms, _zone) {
    const w = wallParts(ms)
    return zonedWall(w.year, w.month - 1, w.day, 0, 0, 0)
  }

  function startOfMonth(ms) {
    const w = wallParts(ms)
    return zonedWall(w.year, w.month - 1, 1, 0, 0, 0)
  }

  function startOfNextMonth(ms) {
    const w = wallParts(ms)
    return zonedWall(w.year, w.month, 1, 0, 0, 0)
  }

  function wallParts(ms) {
    const parts = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms))) parts[p.type] = p.value
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24 }
  }

  /** Shared field nodes for create/update. */
  const writableFields = {
    title: { type: 'string', description: '事件标题（必填）。' },
    start: TIME_PARAM('开始时间'),
    end: {
      type: 'string',
      description: '结束时间，格式同 start。全天事件只写日期，该日期为最后一天（含）。与 durationMinutes 二选一；都省略时按 60 分钟计算。',
    },
    durationMinutes: { type: 'integer', description: '时长（分钟），与 end 二选一；未提供 end 时使用，默认 60。' },
    allDay: { type: 'boolean', description: '是否为全天事件（为 true 时只使用日期部分）。' },
    location: { type: 'string', description: '地点。' },
    notes: { type: 'string', description: '备注 / 描述。' },
    timeZone: { type: 'string', description: `事件的 IANA 时区，如 Asia/Shanghai。默认 ${zone}。` },
    recurrence: {
      type: 'string',
      description: '重复规则（iCal RRULE 值），例如 FREQ=DAILY、FREQ=WEEKLY;BYDAY=MO,WE、FREQ=MONTHLY;COUNT=10。省略表示不重复。',
    },
    alarmMinutesBefore: { type: 'integer', description: '提前多少分钟提醒（例如 15）。' },
    attendees: {
      type: 'array',
      description: '参与者邮箱列表（只接受邮箱地址）。只有姓名时，先调用 lookup_iCloud_contacts 查到邮箱；出现多个候选邮箱时先向用户确认。',
      items: { type: 'string' },
    },
  }

  /** Shared output schema for create/update: the saved event and its calendar. */
  const savedOutputSchema = {
    type: 'object',
    additionalProperties: false,
    properties: {
      created: { type: 'boolean' },
      calendar: { type: 'object', additionalProperties: true, properties: {} },
      event: { type: 'object', additionalProperties: true, properties: {} },
    },
    required: ['created', 'calendar', 'event'],
  }

  return [
    // ---------------------------------------------------------------------
    {
      name: 'list_iCloud_calendars',
      description: '列出当前 iCloud 账号（中国区，支持 caldav.icloud.com.cn）中的日历，以及每个日历是否可写。返回值中的 name 可直接用作其他日历类工具的 calendar 参数。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            account: { type: 'string' },
            timeZone: { type: 'string' },
            defaultCalendar: { type: 'string' },
            calendars: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  readOnly: { type: 'boolean' },
                  color: { type: 'string' },
                  description: { type: 'string' },
                },
              },
            },
          },
          required: ['account', 'calendars'],
        },
        render: (_args, value) => [{ type: 'text', text: renderCalendars(value) }],
      },
      timeoutMs: 60000,
      isConcurrencySafe: () => true,
      async execute() {
        const calendars = await account.listCalendars()
        const fallback = calendars.find(c => !c.readOnly) ?? calendars[0]
        return { account: account.email, timeZone: zone, defaultCalendar: fallback?.name, calendars }
      },
    },

    // ---------------------------------------------------------------------
    {
      name: 'find_iCloud_events',
      description: `在 iCloud 日历中查找事件（自动按本地时区 ${zone} 换算并展开重复事件）。
返回每个事件的 start/end（带时区偏移）、标题、地点、备注、所属日历，以及修改时需要的 id。
用 after/before 指定精确时间段，或用 range 选常用时间段；两者都省略时默认本周。`,
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          range: {
            type: 'string',
            enum: ['today', 'tomorrow', 'yesterday', 'this_week', 'next_week', 'last_week', 'this_month', 'next_month', 'next_7_days', 'next_30_days', 'past_30_days'],
            description: '常用时间段（仅在没有提供 after/before 时生效），默认 this_week。周从周一开始。',
          },
          after: { type: 'string', description: '时间范围起点（含），如 2026-11-20 或 2026-11-20T09:00。' },
          before: { type: 'string', description: '时间范围终点（含当天），如 2026-11-27。' },
          search: { type: 'string', description: '按标题、地点或备注关键字过滤（不区分大小写）。' },
          calendar: CALENDAR_PARAM,
          limit: { type: 'integer', description: '最多返回多少条，默认 50，最多 500。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            window: { type: 'object', additionalProperties: true, properties: {} },
            events: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            count: { type: 'integer' },
            truncated: { type: 'boolean' },
          },
          required: ['window', 'events', 'count', 'truncated'],
        },
        render: (args, value) => [{ type: 'text', text: renderEvents(args, value) }],
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const { fromMs, toMs } = resolveWindow(args)
        const found = await account.findEvents({
          fromMs,
          toMs,
          search: args.search,
          calendar: args.calendar,
          limit: Math.min(args.limit ?? 50, 500),
        })
        return {
          window: { after: localIso(fromMs, zone), before: localIso(toMs, zone), timeZone: zone },
          events: found.events,
          count: found.events.length,
          truncated: found.truncated,
        }
      },
    },

    // ---------------------------------------------------------------------
    {
      name: 'create_iCloud_event',
      description: '在 iCloud 日历中新建一个事件。默认写入第一个可写日历，可用 calendar 指定。成功后返回新事件（含 id，可用于后续修改）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { ...writableFields, calendar: CALENDAR_PARAM },
        required: ['title', 'start'],
      },
      output: {
        schema: savedOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderSaved(value, '已创建事件') }],
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args) {
        validateEventArgs(args, { requireStart: true })
        const result = await account.saveEvent(normalizeEventArgs(args))
        return { created: true, calendar: result.calendar, event: result.event }
      },
    },

    // ---------------------------------------------------------------------
    {
      name: 'update_iCloud_event',
      description: '修改已有事件。只修改传入的字段，其余字段（包括已有的提醒与其他属性）保持不变。可用 find_iCloud_events 得到 id 和新的 calendar。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: EVENT_ID_PARAM,
          calendar: CALENDAR_PARAM,
          ...writableFields,
          title: { type: 'string', description: '新的事件标题。' },
          clearNotes: { type: 'boolean', description: '设为 true 时清空备注。' },
          clearLocation: { type: 'boolean', description: '设为 true 时清空地点。' },
          clearRecurrence: { type: 'boolean', description: '设为 true 时取消重复。' },
        },
        required: ['id'],
      },
      output: {
        schema: savedOutputSchema,
        render: (_args, value) => [{ type: 'text', text: renderSaved(value, '已更新事件') }],
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args) {
        if (args.start === undefined && args.end === undefined && args.durationMinutes === undefined && args.title === undefined
          && args.location === undefined && args.notes === undefined && args.recurrence === undefined
          && args.alarmMinutesBefore === undefined && args.attendees === undefined && args.allDay === undefined
          && !args.clearNotes && !args.clearLocation && !args.clearRecurrence) {
          throw new DavError('没有要修改的字段。请至少提供 title、start、end 等其中一项。', { code: 'ICLOUD_INVALID_INPUT' })
        }
        validateEventArgs(args, { requireStart: false })
        const result = await account.saveEvent({ ...normalizeEventArgs(args), id: args.id })
        return { created: false, calendar: result.calendar, event: result.event }
      },
    },

    // ---------------------------------------------------------------------
    {
      name: 'delete_iCloud_event',
      description: '删除事件。occurrenceStart 有值时只取消重复事件的这一次发生（加入 EXDATE），否则删除整个事件（含全部重复）。这是不可撤销的操作。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: EVENT_ID_PARAM,
          occurrenceStart: { type: 'string', description: '要取消的那一次发生的开始时间（取自 find_iCloud_events 的 start）；省略则删除整个事件。' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deleted: { type: 'boolean' },
            id: { type: 'string' },
            scope: { type: 'string' },
            title: { type: 'string' },
            start: { type: 'string' },
            occurrenceStart: { type: 'string' },
          },
          required: ['deleted', 'id', 'scope'],
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.scope === 'occurrence'
            ? `已取消「${value.title ?? '事件'}」的这一次发生：${value.occurrenceStart}\n（该事件的其他重复仍然保留。）\nid：${value.id}`
            : `已删除事件「${value.title ?? '事件'}」${value.start ? `（${value.start}）` : ''}\n（该删除已同步到 iCloud，无法撤销。）\nid：${value.id}`,
        }],
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      async execute(args) {
        const result = await account.deleteEvent({ id: args.id, occurrenceStart: args.occurrenceStart })
        // Echo what was removed so the user can catch a wrong-target delete.
        const known = account.describeEvent?.(args.id) ?? null
        return {
          deleted: true,
          id: result.id,
          scope: result.scope,
          ...(known?.title ? { title: known.title } : {}),
          ...(known?.start ? { start: known.start } : {}),
          ...(result.occurrenceStart ? { occurrenceStart: result.occurrenceStart } : {}),
        }
      },
    },

    // ---------------------------------------------------------------------
    {
      name: 'lookup_iCloud_contacts',
      description: '在 iCloud 通讯录中查找联系人（支持中文姓名、拼音首字母、邮箱、公司、电话前缀匹配）。返回姓名、公司、职位、邮箱、电话、地址。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          search: { type: 'string', description: '姓名、邮箱、公司或电话的一部分；例：「张伟」「zhangwei」「zhang」「@apple.com」「138」。' },
          addressbook: { type: 'string', description: '通讯录名称（省略时搜索所有通讯录）。' },
          limit: { type: 'integer', description: '最多返回多少位联系人，默认 10，最多 100。' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            contacts: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
            count: { type: 'integer' },
            truncated: { type: 'boolean' },
            addressbooks: { type: 'array', items: { type: 'object', additionalProperties: true, properties: {} } },
          },
          required: ['contacts', 'count', 'truncated'],
        },
        render: (args, value) => [{ type: 'text', text: renderContacts(args, value) }],
      },
      timeoutMs: 120000,
      isConcurrencySafe: () => true,
      async execute(args) {
        const found = await account.findContacts({
          search: args.search,
          addressbook: args.addressbook,
          limit: Math.min(args.limit ?? 10, 100),
        })
        return { contacts: found.contacts, count: found.contacts.length, truncated: found.truncated, addressbooks: found.addressbooks }
      },
    },
  ]
}

/** Validate the writable fields that cannot be validated through JSON Schema. */
function validateEventArgs(args, { requireStart }) {
  if (args.title !== undefined && String(args.title).trim() === '') {
    throw new DavError('事件标题不能为空。', { code: 'ICLOUD_INVALID_INPUT' })
  }
  if (requireStart && !args.start) {
    throw new DavError('创建事件需要 start（开始时间）。', { code: 'ICLOUD_INVALID_INPUT' })
  }
  if (args.end !== undefined) {
    const t = (v) => Date.parse(String(v).replace(' ', 'T')) || Date.parse(`${String(v).slice(0, 10)}T00:00:00`)
    if (args.start !== undefined && t(args.end) < t(args.start)) {
      throw new DavError(`结束时间 ${args.end} 早于开始时间 ${args.start}。`, { code: 'ICLOUD_INVALID_TIME' })
    }
  }
  if (args.recurrence !== undefined && args.recurrence !== null) {
    const rule = String(args.recurrence).trim().toUpperCase()
    if (rule && !/^(FREQ=(SECONDLY|MINUTELY|HOURLY|DAILY|WEEKLY|MONTHLY|YEARLY))(\s*;.+)?$/.test(rule)) {
      throw new DavError(`重复规则「${args.recurrence}」无效：必须以 FREQ=DAILY/WEEKLY/MONTHLY/YEARLY 开头，例如 FREQ=WEEKLY;BYDAY=MO。`, { code: 'ICLOUD_INVALID_INPUT' })
    }
    args = { ...args, recurrence: rule || undefined }
  }
  for (const email of args.attendees ?? []) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email))) {
      throw new DavError(`参与者邮箱「${email}」格式不正确。`, { code: 'ICLOUD_INVALID_INPUT' })
    }
  }
}

/** Whole days from `from` to `to`, both `YYYY-MM-DD`; NaN when either is unparsable. */
function dayDistance(from, to) {
  const a = Date.parse(`${String(from).slice(0, 10)}T00:00:00Z`)
  const b = Date.parse(`${String(to).slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN
  return Math.round((b - a) / 86400000)
}

/** Translate tool args into the account layer's `saveEvent` input. */
export function normalizeEventArgs(args) {
  const input = {
    id: args.id,
    calendar: args.calendar,
    title: args.title === undefined ? undefined : String(args.title).trim(),
    start: args.start,
    end: args.end,
    allDay: args.allDay === true || (args.start && !String(args.start).includes('T')),
    timeZone: args.timeZone,
    location: args.location,
    notes: args.notes,
    recurrence: args.recurrence ? String(args.recurrence).toUpperCase() : (args.clearRecurrence ? '' : undefined),
    url: args.url,
    attendees: args.attendees?.map((email) => ({ email: String(email) })),
    clearFields: [
      ...(args.clearNotes ? ['notes'] : []),
      ...(args.clearLocation ? ['location'] : []),
      ...(args.clearRecurrence ? ['recurrence'] : []),
    ],
  }
  if (args.end !== undefined && args.durationMinutes !== undefined) {
    throw new DavError('请只提供 end 或 durationMinutes 其中之一。', { code: 'ICLOUD_INVALID_INPUT' })
  }
  if (args.end !== undefined) {
    if (input.allDay) {
      // A date-only end is the last day the event covers, so the exclusive
      // DTEND is the following day unless start and end name the same date.
      const startDate = String(args.start ?? '').slice(0, 10)
      const endDate = String(args.end).slice(0, 10)
      input.durationDays = dayDistance(startDate, endDate) + 1
      if (!Number.isFinite(input.durationDays) || input.durationDays < 1) {
        throw new DavError(`全天事件的结束日期 ${args.end} 不能早于开始日期 ${args.start}。`, { code: 'ICLOUD_INVALID_TIME' })
      }
    } else {
      input.end = args.end
    }
  }
  if (args.durationMinutes !== undefined) input.durationMs = Number(args.durationMinutes) * 60000
  if (args.alarmMinutesBefore !== undefined) {
    input.alarm = Number(args.alarmMinutesBefore) > 0 ? { minutesBefore: Number(args.alarmMinutesBefore) } : null
  }
  return input
}

/** ISO-8601 instant with the display zone's offset, e.g. 2026-11-17T00:00:00+08:00. */
function localIso(ms, zone) {
  const offsetMs = (() => {
    const parts = {}
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(new Date(ms))) parts[p.type] = p.value
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) - ms
  })()
  const d = new Date(ms + offsetMs)
  const pad = n => String(n).padStart(2, '0')
  const sign = offsetMs < 0 ? '-' : '+'
  const abs = Math.abs(offsetMs)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 3600000))}:${pad(Math.floor((abs % 3600000) / 60000))}`
}

// ---------------------------------------------------------------------------
// Renderers — the model-facing text a tool returns to the conversation.
// ---------------------------------------------------------------------------

/** Render the calendar list. */
function renderCalendars(value) {
  const lines = [`iCloud 账号 ${value.account} 共有 ${value.calendars.length} 个日历（时区 ${value.timeZone ?? 'Asia/Shanghai'}）：`]
  if (value.defaultCalendar) lines.push(`省略 calendar 参数时默认写入：${value.defaultCalendar}（可通过 calendar 指定其他日历）`)
  for (const c of value.calendars) {
    const flags = [c.readOnly ? '只读' : '可写', c.color ? `颜色 ${c.color}` : null, c.description ? `说明 ${c.description}` : null]
      .filter(Boolean).join(' · ')
    lines.push(`- ${c.name}（${flags}）`)
  }
  return lines.join('\n')
}

/** Render event search results. */
function renderEvents(args, value) {
  const head = `时间范围：${value.window.after} 至 ${value.window.before}（${value.window.timeZone}）`
  if (value.count === 0) {
    const hint = args.search ? `没有找到包含「${args.search}」的事件。` : '该时间段内没有事件。'
    return `${head}\n${hint}\n可以扩大范围（after/before 或 range）后重试。`
  }
  const lines = [`${head}，共 ${value.count} 个事件${value.truncated ? '（已截断）' : ''}：`]
  for (const ev of value.events) {
    const when = ev.allDay ? `${ev.start}（全天）` : `${ev.start} → ${ev.end}`
    lines.push(`- ${when} · ${ev.title}${ev.calendarName ? ` · [${ev.calendarName}]` : ''}`)
    if (ev.location) lines.push(`  地点：${ev.location}`)
    if (ev.recurring) {
      lines.push(`  重复：${ev.recurrence}`)
      if (ev.otherStarts?.length) {
        // Every in-window instant, so a weekly meeting shows each time it hits.
        lines.push(`  本范围内另发生 ${ev.otherStarts.length} 次：${ev.otherStarts.join('、')}`)
      }
    }
    if (ev.notes) lines.push(`  备注：${ev.notes.replace(/\n/g, ' / ')}`)
    if (ev.id) lines.push(`  id：${ev.id}`)
  }
  if (value.truncated) lines.push('（结果已截断，请缩小时间范围或提高 limit。）')
  return lines.join('\n')
}

/** Render a created/updated event. */
function renderSaved(value, verb) {
  const ev = value.event
  const when = ev.allDay ? `${ev.start}（全天）` : `${ev.start} → ${ev.end}`
  const lines = [
    `${verb}：${ev.title}`,
    `时间：${when}`,
    `日历：${value.calendar.name}`,
  ]
  if (ev.location) lines.push(`地点：${ev.location}`)
  if (ev.notes) lines.push(`备注：${ev.notes.replace(/\n/g, ' / ')}`)
  if (ev.recurring) lines.push(`重复：${ev.recurrence}`)
  if (ev.id) lines.push(`id：${ev.id}`)
  return lines.join('\n')
}

/** Render contact results. */
function renderContacts(args, value) {
  if (value.count === 0) {
    const books = (value.addressbooks ?? []).map(b => b.name).join('、')
    const where = books ? `当前通讯录：${books}。` : ''
    return args.search
      ? `通讯录中没有找到与「${args.search}」匹配的联系人。${where}\n可以换用邮箱、公司名或电话号码重试，或确认该联系人是否保存在 iCloud 通讯录中。`
      : `通讯录中还没有联系人。${where}`
  }
  const lines = [`找到 ${value.count} 位联系人${value.truncated ? '（已截断）' : ''}：`]
  for (const c of value.contacts) {
    const bits = []
    if (c.organization) bits.push(c.organization)
    if (c.title) bits.push(c.title)
    lines.push(`- ${c.name}${bits.length ? ` · ${bits.join(' / ')}` : ''}${c.addressbook ? ` · [${c.addressbook}]` : ''}`)
    if (c.emails?.length) lines.push(`  邮箱：${c.emails.map(e => `${e.address}${e.type ? `(${e.type})` : ''}`).join('，')}`)
    if (c.phones?.length) lines.push(`  电话：${c.phones.map(p => `${p.number}${p.type ? `(${p.type})` : ''}`).join('，')}`)
    if (c.addresses?.length) lines.push(`  地址：${c.addresses.map(a => a.formatted).join('；')}`)
    if (c.birthday) lines.push(`  生日：${c.birthday}`)
  }
  if (value.truncated) lines.push('（结果已截断，请提供更精确的 search 或提高 limit。）')
  return lines.join('\n')
}
