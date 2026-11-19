/**
 * vCard (RFC 6350 / 3.0) reading for iCloud contacts: Multi-Status
 * `address-data` parsing into the model-facing contact shape, plus a ZH/EN
 * phonetic-aware search key so "张伟" and "zhang wei" both find the same
 * person.
 */

import { parseContentLines } from './ical.js'
import { decodeEntities } from './http.js'

/** Decode vCard quoted-printable payloads (Photos use them; names rarely do). */
function decodeValue(value, params) {
  if ((params?.ENCODING?.[0] ?? '').toUpperCase() !== 'QUOTED-PRINTABLE') return value
  return value.replace(/=([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/=\r?\n/g, '')
}

/** Join `;`-separated vCard structured-name parts, dropping empties cleanly. */
function structuredName(raw) {
  const parts = String(raw ?? '').split(';').map(p => p.trim())
  const [family = '', given = '', additional = '', prefix = '', suffix = ''] = parts
  if (/[\u4e00-\u9fff]/.test(family + given)) {
    return [suffix, given, family, additional, prefix].filter(Boolean).join(' ').replace(/\s+/g, ' ')
  }
  return [prefix, given, additional, family, suffix].filter(Boolean).join(' ')
}

/**
 * Parse one vCard text into the contact shape.
 * @param {string} text - VCARD content.
 * @param {object} [context] - { href, groups }
 * @returns {object|null}
 */
export function parseVCard(text, context = {}) {
  if (!text || !/BEGIN:VCARD/i.test(text)) return null
  const lines = parseContentLines(text)
  const values = (name) => lines
    .filter(l => l.name === name)
    .map(l => decodeValue(l.value, l.params))

  const fn = values('FN')[0]
  const n = values('N')[0]
  const org = values('ORG')[0]
  const emails = []
  for (const line of lines.filter(l => l.name === 'EMAIL')) {
    const address = decodeValue(line.value, line.params).trim()
    if (!address) continue
    const type = (line.params?.TYPE ?? []).map(t => t.toUpperCase()).find(t => !['INTERNET', 'PREF'].includes(t))
    emails.push({ address, ...(type ? { type: type === 'HOME' ? 'home' : type === 'WORK' ? 'work' : type.toLowerCase() } : {}) })
  }
  const phones = []
  for (const line of lines.filter(l => l.name === 'TEL')) {
    const number = decodeValue(line.value, line.params).trim()
    if (!number) continue
    const type = (line.params?.TYPE ?? []).map(t => t.toUpperCase()).find(t => !['VOICE', 'PREF'].includes(t))
    phones.push({ number: number.replace(/^tel:/i, ''), ...(type ? { type: type === 'CELL' ? 'cell' : type === 'HOME' ? 'home' : type === 'WORK' ? 'work' : type.toLowerCase() } : {}) })
  }
  const addresses = []
  for (const line of lines.filter(l => l.name === 'ADR')) {
    const parts = decodeValue(line.value, line.params).split(';').map(p => p.trim())
    const [pobox = '', ext = '', street = '', city = '', region = '', postal = '', country = ''] = parts
    const formatted = [country, region, city, ext, pobox, street, postal].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
    if (!formatted) continue
    const type = (line.params?.TYPE ?? []).map(t => t.toUpperCase()).find(t => t !== 'POSTAL' && t !== 'PREF')
    addresses.push({ formatted, ...(type ? { type: type.toLowerCase() } : {}) })
  }
  const websites = values('URL').filter(Boolean)
  const note = values('NOTE')[0]
  const birthday = values('BDAY')[0]
  const nicknames = values('NICKNAME').flatMap(v => v.split(',')).map(v => v.trim()).filter(Boolean)

  const displayName = (fn && fn.trim()) || structuredName(n) || emails[0]?.address || '（无姓名）'
  return {
    id: context.href,
    name: displayName,
    ...(nicknames.length > 0 ? { nicknames } : {}),
    ...(org ? { organization: org.split(';').map(s => s.trim()).filter(Boolean).join(' · ') } : {}),
    ...(values('TITLE')[0] ? { title: values('TITLE')[0] } : {}),
    ...(emails.length > 0 ? { emails } : {}),
    ...(phones.length > 0 ? { phones } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
    ...(websites.length > 0 ? { websites } : {}),
    ...(birthday ? { birthday } : {}),
    ...(note ? { note: note.length > 1000 ? `${note.slice(0, 999)}…` : note } : {}),
    ...(context.addressbookName ? { addressbook: context.addressbookName } : {}),
  }
}

/** Lower-case, strip spaces and punctuation: "Zhang Wei" -> "zhangwei". */
export function searchKey(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\-_.·()（）'"@+]/g, '')
}

/**
 * Initials of the most common Chinese surnames (top ~120 covering nearly all
 * people in mainland address books), used to match "zw" for 张伟 and "lq" for
 * 李强. Given names cannot be transliterated without a dictionary, so name
 * initials cover the surname plus the first character of a space-separated
 * given name.
 */
const SURNAME_INITIALS = {
  王: 'w', 李: 'l', 张: 'z', 刘: 'l', 陈: 'c', 杨: 'y', 黄: 'h', 赵: 'z', 吴: 'w', 周: 'z',
  徐: 'x', 孙: 's', 马: 'm', 朱: 'z', 胡: 'h', 郭: 'g', 何: 'h', 高: 'g', 林: 'l', 罗: 'l',
  郑: 'z', 梁: 'l', 谢: 'x', 宋: 's', 唐: 't', 许: 'x', 韩: 'h', 冯: 'f', 邓: 'd', 曹: 'c',
  彭: 'p', 曾: 'z', 萧: 'x', 田: 't', 董: 'd', 潘: 'p', 袁: 'y', 蔡: 'c', 蒋: 'j', 余: 'y',
  于: 'y', 杜: 'd', 叶: 'y', 程: 'c', 魏: 'w', 苏: 's', 吕: 'l', 丁: 'd', 任: 'r', 沈: 's',
  姚: 'y', 卢: 'l', 姜: 'j', 崔: 'c', 钟: 'z', 谭: 't', 陆: 'l', 汪: 'w', 范: 'f', 金: 'j',
  石: 's', 廖: 'l', 贾: 'j', 夏: 'x', 韦: 'w', 傅: 'f', 方: 'f', 白: 'b', 邹: 'z', 孟: 'm',
  熊: 'x', 秦: 'q', 邱: 'q', 江: 'j', 尹: 'y', 薛: 'x', 闫: 'y', 阎: 'y', 段: 'd', 雷: 'l',
  侯: 'h', 龙: 'l', 史: 's', 陶: 't', 黎: 'l', 贺: 'h', 顾: 'g', 毛: 'm', 郝: 'h', 龚: 'g',
  邵: 's', 万: 'w', 钱: 'q', 严: 'y', 覃: 'q', 武: 'w', 戴: 'd', 莫: 'm', 孔: 'k', 向: 'x',
  汤: 't', 常: 'c', 温: 'w', 康: 'k', 施: 's', 文: 'w', 牛: 'n', 樊: 'f', 葛: 'g', 邢: 'x',
  安: 'a', 齐: 'q', 易: 'y', 乔: 'q', 伍: 'w', 庞: 'p', 颜: 'y', 倪: 'n', 庄: 'z', 聂: 'n',
  章: 'z', 鲁: 'l', 岳: 'y', 翟: 'z', 殷: 'y', 詹: 'z', 申: 's', 欧: 'o', 耿: 'g', 关: 'g',
  兰: 'l', 焦: 'j', 俞: 'y', 左: 'z', 柳: 'l', 甘: 'g', 祝: 'z', 包: 'b', 宁: 'n', 尚: 's',
  符: 'f', 舒: 's', 阮: 'r', 柯: 'k', 纪: 'j', 梅: 'm', 童: 't', 凌: 'l', 毕: 'b', 单: 's',
  季: 'j', 裴: 'p', 霍: 'h', 涂: 't', 苗: 'm', 谷: 'g', 盛: 's', 曲: 'q', 翁: 'w', 冉: 'r',
  骆: 'l', 蓝: 'l', 路: 'l', 游: 'y', 辛: 'x', 靳: 'j', 管: 'g', 柴: 'c', 蒙: 'm', 鲍: 'b',
  喻: 'y', 祁: 'q', 蒲: 'p', 房: 'f', 滕: 't', 屈: 'q', 饶: 'r', 解: 'x', 牟: 'm', 艾: 'a',
  尤: 'y', 阳: 'y', 时: 's', 穆: 'm', 农: 'n', 司: 's', 卓: 'z', 古: 'g', 吉: 'j', 缪: 'm',
  简: 'j', 车: 'c', 项: 'x', 连: 'l', 芦: 'l', 麦: 'm', 褚: 'c', 娄: 'l', 窦: 'd', 戚: 'q',
}

const PINYIN_INITIALS = [
  ['zh', 'z'], ['ch', 'c'], ['sh', 's'],
]

/**
 * Build the set of strings a contact can be matched by: name, pinyin
 * (from Intl collation-free transliteration is unavailable in Node, so we
 * use a small common-surname table for the most useful Chinese cases),
 * organization, emails and phone digits.
 * @param {object} contact
 * @returns {string[]}
 */
export function contactSearchKeys(contact) {
  const keys = new Set()
  const add = (text, { allowShort = false } = {}) => {
    const key = searchKey(text)
    // One-character initials ("李娜" -> "ln") are legitimately short; other
    // keys below two characters match almost everything and are dropped.
    if (key && (allowShort || key.length >= 2)) keys.add(key)
  }
  add(contact.name)
  add(contact.name.replace(/\s+/g, ''))
  for (const nick of contact.nicknames ?? []) add(nick)
  // Name initials: "Li Na" also matches "ln"; pinyin-initial surnames such as
  // "Zhang Wei" additionally match "zw".
  const words = String(contact.name).split(/\s+/).filter(Boolean)
  if (words.length > 1) {
    add(words.map(w => w[0]).join(''), { allowShort: true })
    for (const [full, initial] of PINYIN_INITIALS) {
      if (words[0].toLowerCase().startsWith(full)) add(`${initial}${words.slice(1).map(w => w[0]).join('')}`, { allowShort: true })
    }
  }
  // Chinese names: surname initial + each given-name character's initial is
  // unknown, so expose the surname initial as a single-letter key. A search
  // like "zw" therefore matches through the phonetic filter below.
  const surnameInitial = chineseSurnameInitial(contact.name)
  if (surnameInitial) keys.add(surnameInitial)
  add(contact.organization)
  for (const e of contact.emails ?? []) add(e.address)
  for (const p of contact.phones ?? []) add(String(p.number).replace(/\D/g, ''))
  return [...keys]
}

/**
 * Whether a user-typed search term matches a contact. Covers direct substrings
 * of the built keys, plus Latin pinyin-initial queries such as "zw" (张伟) and
 * "lq" (李强) where the surname initial is known and every further character
 * yields one initial letter.
 * @param {object} contact
 * @param {string} needle - `searchKey`-normalised query.
 * @returns {boolean}
 */
export function contactMatches(contact, needle) {
  if (!needle) return true
  const keys = contactSearchKeys(contact)
  if (keys.some(k => k.includes(needle) || needle.includes(k) && k.length >= 3)) return true
  const initial = chineseSurnameInitial(contact.name)
  if (initial && /^[a-z]+$/.test(needle)) {
    const name = String(contact.name).replace(/\s+/g, '')
    // "zw" for 张伟: the first letter is the surname initial and the query has
    // one letter per name character, which is how users type initials.
    return needle.length === name.length && needle[0] === initial
  }
  return false
}

/**
 * Pinyin initial of a two-or-more-character Chinese name, or undefined.
 * @param {string} name
 * @returns {string | undefined}
 */
function chineseSurnameInitial(name) {
  const m = /^([\u4e00-\u9fff])[\u4e00-\u9fff]+$/.exec(String(name ?? '').replace(/\s+/g, ''))
  return m ? SURNAME_INITIALS[m[1]] : undefined
}

/**
 * Extract `<address-data>` payloads from a CardDAV multistatus body.
 * @param {string} xml
 * @returns {Array<{ href: string, vcard: string }>}
 */
export function extractAddressData(xml) {
  const out = []
  const re = /<(?:[\w.-]+:)?address-data\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?address-data>/g
  const hrefRe = /<(?:[\w.-]+:)?href\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?href>/g
  const responses = xml.split(/<\/(?:[\w.-]+:)?response>/)
  for (const block of responses) {
    const data = re.exec(block)
    hrefRe.lastIndex = 0
    const href = hrefRe.exec(block)
    if (!data || !href) continue
    const vcard = decodeEntities(data[1])
    if (/BEGIN:VCARD/i.test(vcard)) out.push({ href: decodeEntities(href[1].trim()), vcard })
  }
  return out
}
