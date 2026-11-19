/**
 * End-to-end test: the real account layer + tools against the mock DAV server.
 *
 * Exercises discovery (China host first), calendar listing, agenda search with
 * recurrence expansion, creation with a reminder, in-place update that keeps
 * untouched properties, precondition handling, occurrence deletion (EXDATE),
 * series deletion, and contact lookup.
 */

import { spawn } from 'node:child_process'
import { ICloudAccount } from '../src/icloud.js'
import { buildTools } from '../src/tools.js'

const failures = []
let passes = 0
function check(name, condition, detail) {
  if (condition) { passes++; console.log(`  ✓ ${name}`) }
  else { failures.push(name); console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

const mockPath = new URL('./mock-server.mjs', import.meta.url).pathname
const child = spawn(process.execPath, [mockPath], { stdio: ['ignore', 'pipe', 'inherit'] })
const port = await new Promise((resolve, reject) => {
  child.stdout.on('data', (b) => {
    const m = /LISTENING (\d+)/.exec(String(b))
    if (m) resolve(Number(m[1]))
  })
  child.on('exit', code => reject(new Error(`mock exited ${code}`)))
  setTimeout(() => reject(new Error('mock did not start')), 5000)
})

try {
  const account = new ICloudAccount({
    username: 'example-user@example.com',
    password: 'FAKE-TEST-PASSWORD',
    zone: 'Asia/Shanghai',
    timeoutMs: 10000,
    calendarHost: `127.0.0.1:${port}`,
    contactsHost: `127.0.0.1:${port}`,
  })
  // The mock speaks plain HTTP; point the session at it by patching the origin.
  const sessions = [account.session]
  for (const s of sessions) {
    const orig = s.rawRequest.bind(s)
    s.rawRequest = (method, url, opts) => orig(method, url.replace(/^https:/, 'http:'), opts)
  }
  const tools = Object.fromEntries(buildTools({
    get email() { return 'example-user@example.com' },
    listCalendars: () => account.listCalendars(),
    findEvents: q => account.findEvents(q),
    saveEvent: e => account.saveEvent(e),
    deleteEvent: e => account.deleteEvent(e),
    findContacts: q => account.findContacts(q),
  }, { defaultZone: 'Asia/Shanghai' }).map(t => [t.name, t]))

  const run = async (name, args) => {
    const tool = tools[name]
    const value = await tool.execute(args, { signal: new AbortController().signal })
    return { value, text: tool.output.render(args, value)[0].text }
  }

  console.log('\n1. 日历列表')
  const calendars = await run('list_iCloud_calendars', {})
  check('列出 3 个日历', calendars.value.calendars.length === 3, calendars.text)
  check('中国节假日为只读', calendars.value.calendars.find(c => c.name === '中国节假日')?.readOnly === true)
  check('个人日历可写', calendars.value.calendars.find(c => c.name === '个人')?.readOnly === false)
  check('颜色被规范化为 #RRGGBB', calendars.value.calendars.some(c => c.color === '#1badf8'))

  console.log('\n2. 查找事件（本周）')
  const week = await run('find_iCloud_events', { range: 'this_week' })
  check('本周返回了事件', week.value.count > 0, week.text)
  check('重复周会已展开为本周实例', week.value.events.some(e => e.title === '产品周会' && e.start.endsWith('+08:00')))

  console.log('\n3. 关键字搜索')
  const search = await run('find_iCloud_events', { after: '2026-01-01', before: '2027-12-31', search: '牙医' })
  check('按标题命中牙医复诊', search.value.events.length === 1 && search.value.events[0].title === '牙医复诊', search.text)
  check('返回了地点', search.value.events[0]?.location === '口腔医院')

  console.log('\n4. 创建事件（带提醒）')
  const created = await run('create_iCloud_event', {
    title: '项目评审', start: '2026-12-01T10:00', end: '2026-12-01T11:30', location: '线上', notes: '带上原型', alarmMinutesBefore: 30, calendar: '工作',
  })
  check('created=true', created.value.created === true, created.text)
  check('写入到「工作」日历', created.value.calendar.name === '工作')
  check('时间正确回读', created.value.event.start === '2026-12-01T10:00:00+08:00', created.value.event.start)
  check('结束时间按 end 生效（非 60 分钟）', created.value.event.end === '2026-12-01T11:30:00+08:00', created.value.event.end)
  check('提醒已写入', created.value.event.alarm?.minutesBefore === 30, JSON.stringify(created.value.event.alarm))
  const byDuration = await run('create_iCloud_event', {
    title: '时长测试', start: '2026-12-02T09:00', durationMinutes: 90, calendar: '工作',
  })
  check('durationMinutes=90 生效', byDuration.value.event.end === '2026-12-02T10:30:00+08:00', byDuration.value.event.end)
  await run('delete_iCloud_event', { id: byDuration.value.event.id })

  // all-day span: end date is the last covered day
  const multiDay = await run('create_iCloud_event', {
    title: '行业展会', start: '2026-12-10', end: '2026-12-12', calendar: '工作',
  })
  check('全天事件为 allDay', multiDay.value.event.allDay === true, multiDay.text)
  check('全天事件结束日期独占下一天', multiDay.value.event.end === '2026-12-13', multiDay.value.event.end)
  await run('delete_iCloud_event', { id: multiDay.value.event.id })

  // end before start must be rejected before any network write
  try {
    await run('create_iCloud_event', { title: '倒序', start: '2026-12-05T10:00', end: '2026-12-05T09:00' })
    check('倒序时间应被拒绝', false)
  } catch (err) {
    check('倒序时间返回中文错误', /早于/.test(err.message), err.message)
  }

  const createdId = created.value.event.id

  console.log('\n5. 修改事件（保留未改字段）')
  const updated = await run('update_iCloud_event', { id: createdId, title: '项目评审（改期）', start: '2026-12-01T14:00', end: '2026-12-01T15:30' })
  check('标题已更新', updated.value.event.title === '项目评审（改期）', updated.text)
  check('新时间已生效', updated.value.event.start === '2026-12-01T14:00:00+08:00', updated.value.event.start)
  check('提醒在未传入时被保留', updated.value.event.alarm?.minutesBefore === 30, JSON.stringify(updated.value.event.alarm))
  check('地点在未传入时被保留', updated.value.event.location === '线上')

  console.log('\n6. 修改不存在的 id')
  try {
    await run('update_iCloud_event', { id: `http://127.0.0.1:${port}/123/calendars/work/missing.ics`, title: 'x' })
    check('应当失败', false)
  } catch (err) {
    check('返回 404 中文错误', /不存在/.test(err.message), err.message)
  }

  console.log('\n7. 删除单次发生（EXDATE）')
  const weekly = (await run('find_iCloud_events', { range: 'this_week' })).value.events.find(e => e.title === '产品周会')
  if (weekly) {
    const occ = await run('delete_iCloud_event', { id: weekly.id, occurrenceStart: weekly.start })
    check('scope=occurrence', occ.value.scope === 'occurrence', occ.text)
    const after = await run('find_iCloud_events', { range: 'this_week' })
    check('该次发生已消失', !after.value.events.some(e => e.title === '产品周会' && e.start === weekly.start), after.text)
  } else {
    check('本周应有产品周会', false)
  }

  console.log('\n8. 删除创建的事件')
  const removed = await run('delete_iCloud_event', { id: createdId })
  check('scope=series', removed.value.scope === 'series')
  const gone = await run('find_iCloud_events', { after: '2026-12-01', before: '2026-12-02' })
  check('已删除的事件不再出现', !gone.value.events.some(e => e.title?.includes('项目评审')))

  console.log('\n9. 通讯录')
  const contacts = await run('lookup_iCloud_contacts', { search: '张伟' })
  check('按中文姓名找到张伟', contacts.value.contacts.length === 1, contacts.text)
  check('返回公司/职位/邮箱/电话', contacts.value.contacts[0]?.organization?.includes('贵州云智') && contacts.value.contacts[0]?.emails?.[0]?.address === 'zhang.wei@example.cn')
  const byPinyin = await run('lookup_iCloud_contacts', { search: 'zhangwei' })
  check('按拼音 zhangwei 找到张伟', byPinyin.value.contacts.length === 1, byPinyin.text)
  const byEmail = await run('lookup_iCloud_contacts', { search: 'lina@example.com' })
  check('按邮箱找到 Li Na', byEmail.value.contacts[0]?.name === 'Li Na', byEmail.text)
  const byInitials = await run('lookup_iCloud_contacts', { search: 'zw' })
  check('按姓名首字母 zw 找到张伟', byInitials.value.contacts.some(c => c.name === '张伟'), byInitials.text)
  const byPhone = await run('lookup_iCloud_contacts', { search: '138' })
  check('按电话前缀找到张伟', byPhone.value.contacts.some(c => c.name === '张伟'), byPhone.text)

  console.log('\n10. 全天事件')
  const allDay = await run('find_iCloud_events', { range: 'next_7_days' })
  const party = allDay.value.events.find(e => e.title === '全员大会')
  check('全天事件标记为 allDay', party?.allDay === true, JSON.stringify(party))
} finally {
  child.kill()
}

console.log(`\n${passes} passed, ${failures.length} failed`)
if (failures.length > 0) {
  console.log('失败项：\n- ' + failures.join('\n- '))
  process.exit(1)
}
