# iCloud 日历（中国区）· DeepSeek Harness 插件

[DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的 Host 插件，为国区 Apple ID 的 iCloud 日历与通讯录提供 Agent 工具，功能对标 ChatGPT 的 iCloud Calendar 插件：

> List iCloud calendars, find events, create or change events, and look up iCloud contacts.

插件直接通过 **CalDAV / CardDAV** 协议访问 `caldav.icloud.com.cn`、`contacts.icloud.com.cn`（自动回退 `*.icloud.com`），因此中国区账号（数据存于云上贵州）与全球区账号均可用。不依赖本机 `Calendar.app`，也不读取本机日历数据库。

## 安装

在 DeepSeek Harness 中安装本插件（任选其一）：

**方式一：告诉助手安装**

```
从 GitHub 安装插件：https://github.com/srt180/icloud-calendar-plugin
```

助手会调用 `plugin_manager` 的 `install_bundle`，安装 spec 为：

```
github:srt180/icloud-calendar-plugin
```

**方式二：插件管理器界面**

设置 → 插件 → 添加插件，填入上面的 GitHub 地址。

**方式三：克隆后安装本地目录**

```sh
git clone https://github.com/srt180/icloud-calendar-plugin.git
# 然后在 DSH 中把该目录作为本地插件安装
```

安装后重新打开一个会话即可使用（Host 插件注册的工具在新会话中生效）。

## 工具

| 工具 | 作用 |
|---|---|
| `list_iCloud_calendars` | 列出日历、颜色、读写权限与默认目标日历 |
| `find_iCloud_events` | 按时间段 / 常用范围 / 关键字查找事件，重复事件按每一次发生展开 |
| `create_iCloud_event` | 新建事件：标题、开始/结束、全天、地点、备注、重复规则、提前提醒、参与者 |
| `update_iCloud_event` | 只修改传入字段，其余属性（含原有提醒）保持不变 |
| `delete_iCloud_event` | 删除整个事件，或只取消重复事件中的某一次 |
| `lookup_iCloud_contacts` | 按中文姓名、拼音、全拼首字母（`zw` → 张伟）、邮箱、公司、电话查找联系人 |

时间默认按 `Asia/Shanghai` 解释与展示，输出带 `+08:00` 偏移。

## 配置账号

插件**不会**把 Apple ID 密码写入配置文件。凭据保存在 DSH 凭据存储的 `icloud-calendar/default` 记录中（`~/.dsh/.credentials.yaml`，权限 0600），每次工具调用都会重新读取。

1. 生成 App 专用密码：<https://appleid.apple.com> → **登录与安全** → **App 专用密码** → 生成，得到形如 `xxxx-xxxx-xxxx-xxxx` 的密码。**不要使用 Apple ID 登录密码。**
2. 保存凭据，任选一种：

   - **让助手代存**（最简单）：在会话中提供 Apple ID 与 App 专用密码，助手会写入凭据记录并立即验证。

   - **直接写入文件**：

     ```yaml
     # ~/.dsh/.credentials.yaml
     records:
       icloud-calendar/default:
         kind: grant
         payload:
           username: your-name@icloud.com
           password: xxxx-xxxx-xxxx-xxxx
     ```

   - **程序化写入**：调用插件导出的 `installCredentials(ctx, { username, password })`。

   > 插件目前没有内置可视化设置页，因此前两种方式最实用。

3. 验证：让助手「列一下我的 iCloud 日历」，应返回形如：

   ```
   iCloud 账号 your-name@icloud.com 共有 3 个日历（时区 Asia/Shanghai）：
   省略 calendar 参数时默认写入：个人（可通过 calendar 指定其他日历）
   - 个人（可写 · 颜色 #1badf8）
   ```

修改凭据后无需重启：下一次调用会重建连接并丢弃缓存的发现结果。

## 配置项

在插件行的 `config` 中设置（均非敏感）：

| 字段 | 默认 | 说明 |
|---|---|---|
| `timeZone` | `Asia/Shanghai` | 事件查询与展示时区（IANA 名称） |
| `timeoutMs` | `30000` | 单次请求超时（毫秒） |
| `account` | `default` | 凭据记录名，多账号时区分 |
| `proxy` | — | 需要经 HTTP 代理访问 iCloud 时填写，如 `http://127.0.0.1:7890`（Node 的 https 不读取系统代理设置） |
| `calendarHost` | — | 高级：覆盖 CalDAV 主机（自建代理或测试服务器） |
| `contactsHost` | — | 高级：覆盖 CardDAV 主机 |

## 工作原理

- 发现服务：先请求 `caldav.icloud.com.cn`，失败再回退 `caldav.icloud.com`；通过 `current-user-principal` → `calendar-home-set` / `addressbook-home-set` 定位资源。
- 读：`calendar-query` REPORT（按时间窗口过滤），重复事件按 `RRULE`（`DAILY/WEEKLY/MONTHLY/YEARLY` + `INTERVAL/COUNT/UNTIL/BYDAY`）与 `EXDATE` 在窗口内展开。
- 写：`PUT` 携带 `If-Match` ETag；若期间其他设备已修改，服务器返回 412，插件拒绝覆盖并提示重新读取。
- 删单次发生：向事件写入 `EXDATE`，保留其余重复。
- 通讯录：`addressbook-query` REPORT + 客户端拼音/首字母回退匹配。

## 已知限制

- 需要已开启双重认证的 iCloud 账号；被停用或不支持 App 专用密码的账号无法使用。
- 重复事件的复杂规则（`BYSETPOS`、`BYMONTHDAY` 等）只返回主事件，不做近似展开。
- 通讯录为只读查询，不支持新建或修改联系人。
- 只处理日历事件（`VEVENT`），不含提醒事项（`VTODO`）。
- `attendees` 只接受邮箱地址；只有姓名时先让助手用 `lookup_iCloud_contacts` 解析。写入参与者后是否自动发出邀请取决于 iCloud 服务端。
- 删除不可撤销。删除整个重复事件前，助手会先确认标题与时间。
- 同一账号的请求串行发送，并带瞬断重试，避免触发 iCloud 频控。

## 开发与测试

插件为纯 ESM，无构建步骤、无运行时依赖。

```sh
node test/e2e.mjs
```

测试使用内置的 mock CalDAV/CardDAV 服务器，覆盖 33 项端到端检查：发现、日历列表、按窗口与关键字查询、重复事件展开、创建（含提醒）、只改传入字段、412/404 路径、单次发生删除（EXDATE）、整个事件删除、联系人中文/拼音/首字母/邮箱/电话匹配、全天事件。

## 目录结构

```
index.js            Host 插件入口（apply/Config/凭据读写）
src/http.js         DAV 传输层（代理隧道、重试、Multi-Status 解析）
src/icloud.js       CalDAV/CardDAV 账号层（发现、查询、写入、通讯录）
src/ical.js         iCalendar 解析、时区换算、重复事件展开
src/vcard.js        vCard 解析与联系人匹配
src/tools.js        6 个 Agent 工具的定义与输出渲染
locale/*.json       插件管理器展示用的中英文名称与说明
icon.svg            插件图标
cordis.patch.yml    DSH bundle 挂载行
test/               mock 服务器与端到端测试
```

## 隐私

- 凭据只存在本机 DSH 凭据存储中，不进入配置文件、不写入本仓库。
- 网络请求仅发往 `*.icloud.com.cn` / `*.icloud.com` 的 CalDAV/CardDAV 端点。
- 插件不采集遥测。

## License

MIT
