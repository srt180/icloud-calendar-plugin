/**
 * 中国区 iCloud 日历/通讯录插件（DSH Host 插件）。
 *
 * Registers CalDAV/CardDAV tools against the user's Apple ID using an
 * App 专用密码: list calendars, find events, create/update/delete events, and
 * look up contacts.
 *
 * Credentials live in the profile credential store as a `grant` record under
 * `icloud-calendar/<account>` — never in configuration and never in the
 * conversation. It is re-read for every request, so a rotated password applies
 * without restarting the plugin.
 *
 * Configuration (non-secret only):
 *   - `account`      credential record name, default `default`
 *   - `timeZone`     IANA zone for queries and display, default Asia/Shanghai
 *   - `timeoutMs`    per-request limit
 *   - `calendarHost` / `contactsHost`  advanced overrides (test or private DAV)
 *
 * Saving the account: pass `credentials: { username, password }` once through
 * the row config; `apply` moves it into the credential store and then clears it
 * from the row so the secret never stays in the profile patch file.
 */

import { ICloudAccount } from './src/icloud.js'
import { buildTools } from './src/tools.js'
import { DavError } from './src/http.js'

export const name = 'icloud-calendar'
export const inject = ['tools', 'credentials']

/** Credential record id used when configuration names no account. */
const DEFAULT_ACCOUNT = 'default'

/** Non-secret configuration fields and their runtime types. */
const CONFIG_FIELDS = {
  account: 'string',
  timeZone: 'string',
  timeoutMs: 'integer',
  proxy: 'string',
  calendarHost: 'string',
  contactsHost: 'string',
  credentials: 'object',
}

/**
 * Config validator in Standard Schema v1 form, which is what the Loader calls
 * before the plugin starts. Only non-secret settings are declared; `credentials`
 * is accepted for one-shot account setup and then removed from the row.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'icloud-calendar',
    /**
     * @param {unknown} value - the row's config object.
     * @returns {{ value: object } | { issues: Array<{ message: string, path: string[] }> }}
     */
    validate(value) {
      const issues = []
      const input = value !== null && typeof value === 'object' ? value : {}
      for (const [key, raw] of Object.entries(input)) {
        const type = CONFIG_FIELDS[key]
        if (type === undefined) {
          issues.push({ message: `未知配置项「${key}」`, path: [key] })
          continue
        }
        if (raw === undefined || raw === null) continue
        const ok = type === 'object'
          ? typeof raw === 'object' && !Array.isArray(raw)
          : type === 'integer' ? Number.isInteger(raw) : typeof raw === type
        if (!ok) issues.push({ message: `配置项「${key}」应为 ${type === 'integer' ? '整数' : type === 'object' ? '对象' : '文本'}`, path: [key] })
      }
      return issues.length > 0 ? { issues } : { value: input }
    },
  },
}

/**
 * Credential record key for one configured account: `icloud-calendar/<id>`.
 * @param {string} accountId
 */
export function recordKey(accountId = DEFAULT_ACCOUNT) {
  return `icloud-calendar/${sanitizeSegment(accountId)}`
}

/**
 * Read the stored Apple ID + App 专用密码 for one account.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} accountId
 * @returns {Promise<{ username: string, password: string } | null>}
 */
export async function loadCredentials(ctx, accountId = DEFAULT_ACCOUNT) {
  const credentials = await ctx.credentials
  const record = await credentials.readRecord(recordKey(accountId))
  if (!record || record.kind !== 'grant') return null
  const payload = record.payload
  if (!payload || typeof payload !== 'object') return null
  const { username, password } = payload
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return null
  return { username, password }
}

/**
 * Validate and store account credentials as a grant record.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ account?: string, username: string, password: string }} input
 * @returns {Promise<{ account: string }>}
 */
export async function installCredentials(ctx, input) {
  const accountId = sanitizeSegment(input.account ?? DEFAULT_ACCOUNT)
  const username = String(input.username ?? '').trim()
  // App 专用密码 is shown as xxxx-xxxx-xxxx-xxxx, but users paste it without
  // dashes too; Apple accepts either form.
  const password = String(input.password ?? '').trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(username)) {
    throw new DavError('Apple ID 邮箱格式不正确。', { code: 'ICLOUD_INVALID_INPUT' })
  }
  if (password.length === 0) {
    throw new DavError('App 专用密码不能为空。请到 appleid.apple.com 生成 App 专用密码，而不是使用 Apple ID 登录密码。', { code: 'ICLOUD_INVALID_INPUT' })
  }
  const credentials = await ctx.credentials
  await credentials.modifyRecord(recordKey(accountId), async () => ({
    kind: 'grant',
    payload: { username, password },
  }))
  return { account: accountId }
}

/**
 * Remove stored credentials for one account.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {string} [accountId]
 */
export async function deleteCredentials(ctx, accountId = DEFAULT_ACCOUNT) {
  const credentials = await ctx.credentials
  await credentials.deleteRecord(recordKey(accountId))
}

/**
 * Build an account bound to the stored credentials.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<ICloudAccount>}
 */
async function createAccount(ctx, config) {
  const accountId = sanitizeSegment(config.account ?? DEFAULT_ACCOUNT)
  const creds = await loadCredentials(ctx, accountId)
  if (!creds) {
    throw new DavError(
      `尚未配置 iCloud 账号。请向我索要中国区 Apple ID（邮箱）与 App 专用密码（在 appleid.apple.com 的「登录与安全 → App 专用密码」生成，不是登录密码），然后告知已准备好；Apple ID 密码永远不应索取。`,
      { code: 'ICLOUD_NOT_CONFIGURED' },
    )
  }
  const account = new ICloudAccount({
    username: creds.username,
    password: creds.password,
    zone: config.timeZone ?? 'Asia/Shanghai',
    timeoutMs: config.timeoutMs ?? 30000,
    proxy: config.proxy,
    calendarHost: config.calendarHost,
    contactsHost: config.contactsHost,
  })
  account.email = creds.username
  return account
}

/**
 * Verify one account by listing its calendars.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {Promise<{ ok: boolean, message: string, calendars?: string[] }>}
 */
export async function testConnection(ctx, config = {}) {
  try {
    const account = await createAccount(ctx, config)
    const calendars = await account.listCalendars()
    return { ok: true, message: `已连接 iCloud：${calendars.length} 个日历。`, calendars: calendars.map(c => c.name) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config = {}) {
  const accountId = sanitizeSegment(config.account ?? DEFAULT_ACCOUNT)
  const zone = config.timeZone ?? 'Asia/Shanghai'
  const timeoutMs = config.timeoutMs ?? 30000
  const proxy = config.proxy

  /** @type {ICloudAccount | null} */
  let account = null
  /** Identity of the credentials the cached account was built from. */
  let cachedIdentity = null

  /** Cached account for the current credentials; swapped when they change. */
  async function currentAccount() {
    const creds = await loadCredentials(ctx, accountId)
    if (!creds) {
      account = null
      cachedIdentity = null
      throw new DavError(
        `尚未配置 iCloud 账号。请向我索要中国区 Apple ID（邮箱）与 App 专用密码（在 appleid.apple.com 的「登录与安全 → App 专用密码」生成，不是登录密码），然后告知已准备好；Apple ID 密码永远不应索取。`,
        { code: 'ICLOUD_NOT_CONFIGURED' },
      )
    }
    const identity = `${creds.username}\u0000${creds.password}`
    if (account === null || cachedIdentity !== identity) {
      account = new ICloudAccount({
        username: creds.username,
        password: creds.password,
        zone,
        timeoutMs,
        proxy: config.proxy,
        calendarHost: config.calendarHost,
        contactsHost: config.contactsHost,
      })
      account.email = creds.username
      cachedIdentity = identity
    }
    return account
  }

  // A settings surface may write credentials after this plugin loaded; drop
  // cached discovery state so the next tool call authenticates fresh.
  ctx.on('credentials/record-updated', (key) => {
    if (key === recordKey(accountId)) account?.resetDiscovery()
  })

  // Store credentials handed in through the config row (then cleared).
  if (config.credentials && typeof config.credentials === 'object') {
    const pending = config.credentials
    installCredentials(ctx, { account: accountId, ...pending })
      .then(function clearInlineCredentials() {
        // Never leave the secret in the profile patch file.
        const editor = ctx.get('configEditor')
        const entry = ctx.fiber?.entry
        if (!editor || !entry) return
        return editor.edit(entry, current => ({ ...current, credentials: undefined }))
      })
      .catch((err) => {
        ctx.logger?.warn?.(`icloud-calendar: 无法保存配置中的凭据：${err instanceof Error ? err.message : err}`)
      })
  }

  const facade = {
    get email() { return account?.email ?? '' },
    describeEvent: (href) => account?.describeEvent(href),
    listCalendars: () => currentAccount().then(a => a.listCalendars()),
    findEvents: q => currentAccount().then(a => a.findEvents(q)),
    saveEvent: e => currentAccount().then(a => a.saveEvent(e)),
    deleteEvent: e => currentAccount().then(a => a.deleteEvent(e)),
    findContacts: q => currentAccount().then(a => a.findContacts(q)),
  }

  for (const tool of buildTools(facade, { defaultZone: zone })) {
    ctx.tools.register(tool)
  }
}

/** Credential key segments must be lower-case hyphenated identifiers. */
function sanitizeSegment(value) {
  const cleaned = String(value ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return cleaned || DEFAULT_ACCOUNT
}
