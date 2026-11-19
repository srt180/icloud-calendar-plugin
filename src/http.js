/**
 * Minimal HTTP(S) transport for WebDAV-style servers.
 *
 * Uses `node:http`/`node:https` directly instead of `fetch` because CalDAV
 * needs request methods (`PROPFIND`, `REPORT`, `PUT` with `If-Match`) and
 * non-HTTP-semantic behaviours (301 on MOVE, raw `207 Multi-Status` bodies)
 * that undici quietly rewrites. This layer also owns:
 *
 * - a serialized request queue per origin, so one account never fires a
 *   burst of parallel PROPFINDs at iCloud (server-side rate limiting),
 * - a single 401 retry after invalidating the cached discovery state,
 * - both HTTP status and DAV error parsing,
 * - connection reuse through keep-alive agents.
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import zlib from 'node:zlib'
import { URL } from 'node:url'

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 8 })
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 8 })

/**
 * An https.Agent that opens each connection through an HTTP CONNECT tunnel.
 * Node's https client ignores the macOS system proxy, so a machine that reaches
 * iCloud only through a local proxy needs this to avoid resets mid-session.
 */
class ProxyTunnelAgent extends https.Agent {
  /**
   * @param {URL} proxyUrl - http://host:port proxy endpoint.
   * @param {object} [options] - https.Agent options.
   */
  constructor(proxyUrl, options = {}) {
    super(options)
    this.proxy = proxyUrl
  }

  /** @param {{ host?: string, port?: string|number }} options @param {(err: Error|null, socket?: any) => void} callback */
  createConnection(options, callback) {
    const targetHost = options.host
    const targetPort = Number(options.port ?? 443)
    const connectReq = http.request({
      host: this.proxy.hostname,
      port: Number(this.proxy.port || 80),
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
      agent: false,
    })
    connectReq.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        callback(new Error(`代理隧道建立失败：HTTP ${res.statusCode}`))
        return
      }
      const secured = tls.connect({
        socket,
        servername: targetHost,
        rejectUnauthorized: !(process.env.ICLOUD_CALENDAR_INSECURE === '1'),
      })
      secured.once('error', (err) => callback(err))
      secured.once('secureConnect', () => callback(null, secured))
    })
    connectReq.once('error', (err) => callback(err))
    connectReq.end()
  }
}

/** Agent cache keyed by proxy URL, so a configured proxy is reused. */
const proxyAgents = new Map()

/** Resolve the agent for this session and URL. */
function agentFor(session, isHttps) {
  if (session.proxy && isHttps) {
    if (!proxyAgents.has(session.proxy)) {
      proxyAgents.set(session.proxy, new ProxyTunnelAgent(new URL(session.proxy), { keepAlive: true, maxSockets: 4 }))
    }
    return proxyAgents.get(session.proxy)
  }
  return isHttps ? httpsAgent : httpAgent
}

export class DavError extends Error {
  /**
   * @param {string} message - human readable, Chinese.
   * @param {object} [info]
   * @param {number} [info.status] - HTTP status when the failure came from a response.
   * @param {string} [info.code] - stable machine code for the model.
   * @param {string} [info.detail] - short server-provided explanation.
   */
  constructor(message, info = {}) {
    super(message)
    this.name = 'DavError'
    this.status = info.status
    this.code = info.code ?? 'ICLOUD_ERROR'
    this.detail = info.detail
  }
}

/**
 * Explain the handful of status codes iCloud actually returns for each
 * operation, so the model gets an actionable sentence rather than a number.
 * @param {number} status - HTTP status.
 * @param {string} op - operation label used in the message.
 * @param {string} [detail] - server body excerpt.
 * @returns {string} message.
 */
export function describeStatus(status, op, detail) {
  const suffix = detail ? `（服务器说明：${detail.slice(0, 300)}）` : ''
  switch (status) {
    case 401: return `${op}失败：Apple ID 或 App 专用密码不正确。最常见的原因是填写了 Apple ID 登录密码——请到 appleid.apple.com 的「登录与安全 → App 专用密码」重新生成；其次请确认账号已开启双重认证，且该 Apple ID 属于中国区或全球区 iCloud 账号。${suffix}`
    case 403:
    case 507: return `${op}失败：iCloud 拒绝了此次操作（${status}）。中国区账号通常需要等待配额或稍后重试；频繁请求也会被限制。${suffix}`
    case 404: return `${op}失败：目标不存在（404）。它可能已被删除，或该日历/通讯录已从 iCloud 中移除。${suffix}`
    case 409: return `${op}失败：服务器状态冲突（409）。${suffix}`
    case 412: return `${op}失败：该条目在读取后已被其他设备修改（412）。请重新读取后再提交修改，避免覆盖他人的改动。${suffix}`
    case 423: return `${op}失败：该条目被服务器锁定（423），请稍后重试。${suffix}`
    case 429: return `${op}失败：请求过于频繁（429），请稍后重试。${suffix}`
    default: return `${op}失败：HTTP ${status}。${suffix}`
  }
}

/**
 * Turn a 207 response body into a list of DAV response objects, tolerating
 * both namespace prefixes (`D:`, `d:`, `ns1:`) and an empty default ns.
 * @param {string} xml - response body.
 * @returns {Array<{ href: string, status?: number, props: Array<{ name: string, value: string | null, attrs: Record<string,string> }> }>}
 */
export function parseMultiStatus(xml) {
  const out = []
  if (!xml) return out
  const responseRe = /<((?:[\w.-]+:)?response)\b[^>]*>([\s\S]*?)<\/\1>/g
  const hrefRe = /<((?:[\w.-]+:)?href)\b[^>]*>([\s\S]*?)<\/\1>/
  const statusRe = /<((?:[\w.-]+:)?status)\b[^>]*>\s*HTTP\/[\d.]+\s+(\d{3})/
  const propBlockRe = /<((?:[\w.-]+:)?prop)\b[^>]*>([\s\S]*?)<\/\1>/
  let m
  while ((m = responseRe.exec(xml)) !== null) {
    const block = m[2]
    const hrefMatch = hrefRe.exec(block)
    if (!hrefMatch) continue
    const entry = { href: decodeEntities(hrefMatch[2].trim()), status: undefined, props: [] }
    const statusMatch = statusRe.exec(block)
    if (statusMatch) entry.status = Number(statusMatch[2])
    const propMatch = propBlockRe.exec(block)
    if (propMatch) entry.props = scanProperties(propMatch[2])
    out.push(entry)
  }
  return out
}

/**
 * Walk the element stream inside one `<prop>` block. Only leaf elements that
 * carry a scalar value, a resource type, or a named child become properties;
 * aggregate containers (privilege-set, component-set) are not reported.
 * @param {string} inner - content of a `<prop>` element.
 * @returns {Array<{ name: string, value: string | null, attrs: Record<string,string> }>}
 */
function scanProperties(inner) {
  const props = []
  const open = []
  let cursor = 0
  for (;;) {
    const lt = inner.indexOf('<', cursor)
    if (lt === -1) break
    const gt = inner.indexOf('>', lt)
    if (gt === -1) break
    const raw = inner.slice(lt + 1, gt)
    cursor = gt + 1
    if (raw.startsWith('/')) { open.pop(); continue }
    if (raw.startsWith('!') || raw.startsWith('?')) continue

    const selfClosing = raw.endsWith('/')
    const body = selfClosing ? raw.slice(0, -1) : raw
    const nameMatch = /^((?:[\w.-]+:)?[\w.-]+)/.exec(body)
    if (!nameMatch) continue
    const full = nameMatch[1]
    const local = stripPrefix(full).toLowerCase()
    const attrs = {}
    for (const a of body.slice(full.length).matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2])
    if (selfClosing) {
      const isDocumentMarker = /^(collection|addressbook|calendar|principal|schedule-inbox|schedule-outbox)$/.test(local) && Object.keys(attrs).length === 0
      // `<D:collection/>` is a resource-type marker; `<C:comp name="VEVENT"/>`
      // is a named marker; any other empty leaf is reported with its own name.
      props.push({ name: local, value: attrs.name ?? null, attrs, selfClosing: true, documentMarker: isDocumentMarker })
      continue
    }
    const closeIdx = inner.indexOf(`</${full}>`, cursor)
    const text = closeIdx === -1 ? '' : inner.slice(cursor, closeIdx)
    const hasElementChild = text.includes('<')
    if (!hasElementChild) {
      // Leaf with text: displayname, color, etag, principal href, iCal data.
      const dataLike = /calendar-data|address-data/.test(local)
      props.push({ name: local, value: dataLike ? decodeEntities(text) : decodeEntities(text.trim()), attrs })
      cursor = closeIdx === -1 ? cursor : closeIdx + full.length + 3
      continue
    }
    // Container whose direct text is a leaf href (current-user-principal,
    // calendar-home-set, addressbook-home-set): report as a value property,
    // but still walk inside so nothing is lost.
    if (/^(current-user-principal|calendar-home-set|addressbook-home-set|principal-url|owner)$/.test(local)) {
      const inner2 = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/.exec(text)
      if (inner2) props.push({ name: local, value: decodeEntities(inner2[1].trim()), attrs })
    }
    open.push(full)
  }
  return props.map(({ selfClosing, documentMarker, ...rest }) => rest)
}

/** Strip an XML namespace prefix from an element name. */
export function stripPrefix(name) {
  const i = name.indexOf(':')
  return i === -1 ? name : name.slice(i + 1)
}

/** First property with one local name. */
export function prop(entry, name) {
  const hit = entry.props.find(p => p.name.toLowerCase() === name.toLowerCase())
  return hit ? hit.value : undefined
}

/** All properties with one local name. */
export function props(entry, name) {
  return entry.props.filter(p => p.name.toLowerCase() === name.toLowerCase()).map(p => p.value)
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

/** Decode the small XML entity set DAV servers use. */
export function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : all
    }
    return ENTITIES[body] ?? all
  })
}

/** Escape text for inclusion inside XML element content or attributes. */
export function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * One DAV connection owner: a base URL plus Basic credentials, with a
 * serialized request queue and a single 401-triggered rediscovery hook.
 */
export class DavSession {
  /**
   * @param {object} options
   * @param {string} options.username - Apple ID.
   * @param {string} options.password - App 专用密码.
   * @param {string} options.userAgent - client identifier.
   * @param {number} options.timeoutMs - per-request budget.
   * @param {(signal: AbortSignal) => Promise<void>} [options.onUnauthorized] - clears discovery caches before one retry.
   */
  constructor(options) {
    this.username = options.username
    this.password = options.password
    this.userAgent = options.userAgent
    this.timeoutMs = options.timeoutMs ?? 30000
    this.proxy = options.proxy ?? null
    this.retries = options.retries ?? 3
    this.onUnauthorized = options.onUnauthorized
    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
  }

  /** Authorization header value for Basic auth. */
  get authHeader() {
    return `Basic ${Buffer.from(`${this.username}:${this.password}`, 'utf8').toString('base64')}`
  }

  /**
   * Run a request body/header pair, retrying once on 401 after the caller's
   * rediscovery hook runs.
   * @param {string} method
   * @param {string} url
   * @param {object} [options]
   * @param {Record<string,string>} [options.headers]
   * @param {string|Buffer} [options.body]
   * @param {AbortSignal} [options.signal]
   * @param {string} [options.op] - operation label for errors.
   * @param {boolean} [options.acceptStatus] - keep known statuses instead of throwing.
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
   */
  async request(method, url, options = {}) {
    const first = await this.serialize(() => this.rawRequest(method, url, options))
    // Anonymous discovery probes (`options.anonymous`) never trigger a retry:
    // there is no cached state to invalidate yet.
    if (first.status !== 401 || !this.onUnauthorized || options.anonymous) return first
    await this.onUnauthorized(options.signal ?? new AbortController().signal)
    return this.serialize(() => this.rawRequest(method, url, options))
  }

  /**
   * Strict variant: any non-2xx status becomes a {@link DavError}.
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
   */
  async send(method, url, options = {}) {
    const res = await this.withRetry(() => this.request(method, url, { ...options, acceptStatus: true }), options.op ?? method)
    if (res.status >= 200 && res.status < 300) return res
    throw new DavError(describeStatus(res.status, options.op ?? method, res.body), {
      status: res.status,
      code: STATUS_CODES[res.status] ?? 'ICLOUD_HTTP_ERROR',
      detail: res.body.slice(0, 300),
    })
  }

  /**
   * Retry a request when the failure is a transient network error (reset,
   * timeout, refused while a proxy reconnects). Never retries HTTP statuses,
   * so write conflicts and auth failures still surface immediately.
   * @param {() => Promise<any>} task
   * @param {string} label
   */
  async withRetry(task, label) {
    let lastError
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await task()
      } catch (err) {
        lastError = err
        const transient = err instanceof DavError
          && ['ICLOUD_RESET', 'ICLOUD_TIMEOUT', 'ICLOUD_REFUSED', 'ICLOUD_NETWORK', 'ICLOUD_DNS'].includes(err.code)
        if (!transient || attempt === this.retries) throw err
        await new Promise(r => setTimeout(r, 400 * (attempt + 1)))
      }
    }
    throw new DavError(`${label}失败：${lastError instanceof Error ? lastError.message : lastError}`)
  }

  /** Serialize network calls so iCloud never receives a burst from this account. */
  serialize(task) {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => undefined, () => undefined)
    return run
  }

  /**
   * One raw HTTP exchange, decoding gzip/deflate bodies (iCloud sends them).
   * @returns {Promise<{ status: number, headers: Record<string, string>, body: string }>}
   */
  rawRequest(method, rawUrl, { headers = {}, body, signal, acceptStatus = false, anonymous = false } = {}) {
    const url = new URL(rawUrl)
    const isHttps = url.protocol === 'https:'
    const transport = isHttps ? https : http
    const payload = body === undefined || body === null ? undefined : Buffer.from(body, 'utf8')
    const finalHeaders = {
      ...(anonymous ? {} : { 'Authorization': this.authHeader }),
      'User-Agent': this.userAgent,
      'Accept-Encoding': 'gzip, deflate',
      'Accept': '*/*',
      'Connection': 'keep-alive',
      ...headers,
    }
    if (payload) finalHeaders['Content-Length'] = String(payload.length)

    return new Promise((resolve, reject) => {
      const req = transport.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (isHttps ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method,
        headers: finalHeaders,
        agent: agentFor(this, isHttps),
        servername: url.hostname,
        rejectUnauthorized: !(process.env.ICLOUD_CALENDAR_INSECURE === '1'),
        signal,
      }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('error', (err) => reject(translateNetworkError(err, rawUrl)))
        res.on('end', () => {
          let buf = Buffer.concat(chunks)
          const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf)
            else if (enc === 'deflate') buf = zlib.inflateSync(buf)
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf)
          } catch {
            // Leave the body as-is; DAV failures surface through the status.
          }
          const out = {
            status: res.statusCode ?? 0,
            headers: lowerCaseHeaders(res.headers),
            body: buf.toString('utf8'),
          }
          if (acceptStatus || (out.status >= 200 && out.status < 300)) resolve(out)
          else resolve(out)
        })
      })
      req.on('error', (err) => reject(translateNetworkError(err, rawUrl)))
      req.setTimeout(this.timeoutMs, () => {
        req.destroy(new Error(`请求超时（${this.timeoutMs} 毫秒）`))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }
}

const STATUS_CODES = {
  401: 'ICLOUD_AUTH_FAILED',
  403: 'ICLOUD_FORBIDDEN',
  404: 'ICLOUD_NOT_FOUND',
  409: 'ICLOUD_CONFLICT',
  412: 'ICLOUD_PRECONDITION_FAILED',
  423: 'ICLOUD_LOCKED',
  429: 'ICLOUD_RATE_LIMITED',
  507: 'ICLOUD_QUOTA',
  503: 'ICLOUD_UNAVAILABLE',
}

/**
 * Attack the error message so the user is told what to fix (network vs auth),
 * which is the difference between an actionable hint and useless stack noise.
 * @param {Error} err
 * @param {string} url
 * @returns {DavError}
 */
export function translateNetworkError(err, url) {
  const host = (() => { try { return new URL(url).host } catch { return url } })()
  if (err instanceof DavError) return err
  const code = /** @type {any} */ (err).code
  const base = `无法连接 iCloud（${host}）：`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new DavError(`${base}域名解析失败。请检查网络或 DNS 设置。`, { code: 'ICLOUD_DNS' })
  }
  if (code === 'ECONNREFUSED') {
    return new DavError(`${base}连接被拒绝。代理或防火墙可能阻止了 443 端口。`, { code: 'ICLOUD_REFUSED' })
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new DavError(`${base}连接被重置，所在网络可能无法直连中国区 iCloud 域名，请开启可用代理后重试。`, { code: 'ICLOUD_RESET' })
  }
  if (code === 'ETIMEDOUT' || /超时/.test(err.message ?? '')) {
    return new DavError(`${base}连接超时，请检查网络后重试。`, { code: 'ICLOUD_TIMEOUT' })
  }
  const tlsCodes = ['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ERR_TLS_CERT_ALTNAME_INVALID']
  if (tlsCodes.includes(code)) {
    return new DavError(`${base}TLS 证书校验失败（${code}）。若中间有抓包代理，请确认其证书可信。`, { code: 'ICLOUD_TLS' })
  }
  return new DavError(`${base}${err.message ?? String(err)}`, { code: 'ICLOUD_NETWORK' })
}

/** Lower-case header keys for case-insensitive lookups. */
function lowerCaseHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v ?? '')
  }
  return out
}

/**
 * Normalize a DAV href into absolute form. Trailing slashes are significant on
 * DAV servers (they mark collections and some servers answer 404 without one),
 * so they are preserved; comparisons strip them separately.
 * @param {string} href
 * @param {string} base - origin or URL used when href is relative.
 * @returns {string}
 */
export function normalizeHref(href, base) {
  const url = new URL(href, base)
  return `${url.origin}${url.pathname}${url.search}`
}

/** Compare two DAV hrefs ignoring a trailing slash. */
export function sameHref(a, b) {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '')
}

/**
 * Join a collection path with a child name, preserving one slash.
 * @param {string} collection
 * @param {string} name
 */
export function joinUrl(collection, name) {
  return `${collection.replace(/\/+$/, '')}/${encodeURIComponent(name)}`
}
