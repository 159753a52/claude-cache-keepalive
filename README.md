# claude-cache-keepalive

Keep Claude Code's **1-hour prompt cache** warm while you are away, for sessions that run on a **claude.ai subscription** (Pro/Max). It is a single Node.js hook script with no daemon and no dependencies.

[中文说明](#中文说明)

## Why

On a claude.ai subscription, Claude Code writes its prompt cache with a 1-hour TTL. You can see this as `ephemeral_1h_input_tokens` in the session transcript. If you come back after more than an hour, your next message has to write the whole conversation into the cache again. With a large context that means hundreds of thousands of tokens billed as a cache write instead of a cheap cache read.

Anthropic's prompt cache refreshes an entry's lifetime every time the entry is read. This hook relies on that. While a session is idle, it sends a tiny ping about every 50 minutes, at most 3 times. That keeps the cache warm for roughly 3.5 hours after your last message.

## How it works

- When Claude finishes a turn, a `Stop` hook with `asyncRewake: true` starts. It waits in the background, so you can keep using the session.
- After `CCKA_INTERVAL` seconds (default 3000), the hook exits with code 2. That wakes Claude with a short message asking for a one-word reply. The reply's request reads the cached prompt, which resets the 1-hour clock.
- Real activity cancels a pending ping. That covers a new prompt, a newer turn, or new messages appearing in the transcript.
- Each session keeps its own counter in `~/.claude/cache-keepalive/<session_id>.json`, so parallel sessions don't interfere with each other.

The hook skips the ping in these cases:

- **The session isn't billed to a subscription.** This covers an API key or `ANTHROPIC_AUTH_TOKEN`, an `ANTHROPIC_BASE_URL` that points to a relay or gateway, Bedrock/Vertex/Foundry, and headless `claude -p` or SDK runs. The desktop app always signs in with the claude.ai account, so desktop sessions always qualify.
- **The transcript shows a 5-minute cache TTL.** A 50-minute ping would arrive too late.
- **The prompt is small.** Below `CCKA_MIN_CONTEXT` tokens (default 50,000), the cache is cheap to rebuild anyway.
- **Something else will wake the session.** Background tasks and scheduled wakeups do this anyway.

## Compared with yujiachen-y/claude-code-cache-keepalive

| | [upstream](https://github.com/yujiachen-y/claude-code-cache-keepalive) | this repo |
|---|---|---|
| Target | API billing, 5-minute TTL | claude.ai subscription, 1-hour TTL |
| While waiting | blocking Stop hook, press Esc before typing | `asyncRewake`, the session stays usable |
| Interval | 30–290 s, no hook timeout set (default 600 s) | 3000 s with a 3600 s timeout |
| Loop counter | one file shared by all sessions | one per session |
| Safety checks | loop cap | loop cap, subscription detection, TTL and context-size checks, activity detection |

## Requirements

- Claude Code with `asyncRewake` hook support. Tested with Claude Code 2.1.280 in the Claude desktop app on Windows.
- Node.js on `PATH`.

## Install

1. Copy the script:

   ```bash
   mkdir -p ~/.claude/hooks
   cp cache-keepalive.js ~/.claude/hooks/
   ```

2. Merge the `hooks` block from [`settings.example.json`](settings.example.json) into `~/.claude/settings.json`. If that file contains `"disableAllHooks": true`, change it to `false`. Running sessions pick up settings changes automatically.

3. After your next reply, check the log:

   ```bash
   tail -f ~/.claude/cache-keepalive/keepalive.log
   ```

   You should see `waiting 3000s before ping 1/3 (ttl=1h, context=...)`.

**Using CC Switch?** It rewrites `~/.claude/settings.json` every time you switch providers. Put the hooks and `"disableAllHooks": false` into CC Switch's common config for Claude Code instead. Then make sure the provider you use has the common config enabled. The built-in official provider may not have it enabled, and switching to it can wipe every other setting.

## Configuration

Set these environment variables, for example in the `env` block of `settings.json`:

| Variable | Default | Meaning |
|---|---|---|
| `CCKA_INTERVAL` | `3000` | Seconds to wait before each ping. Keep it below 3600. |
| `CCKA_MAX_LOOPS` | `3` | Pings per idle stretch. |
| `CCKA_MIN_CONTEXT` | `50000` | Skip sessions whose prompt is smaller than this many tokens. |
| `CCKA_MESSAGE` | English one-liner | The ping text Claude receives. |
| `CCKA_STATE_DIR` | `~/.claude/cache-keepalive` | Directory for state files and the log. |

If you raise `CCKA_INTERVAL`, keep the Stop hook's `timeout` above it.

## Pause and uninstall

- To pause, run `touch ~/.claude/cache-keepalive/DISABLED`. Delete the file to resume.
- To uninstall, remove the three hook entries and `~/.claude/hooks/cache-keepalive.js`.

## Caveats

- **Every ping is a real turn.** It reads the whole cached prompt and counts toward your usage. How subscription limits weigh cache reads isn't published, so watch your usage after you enable the hook.
- **Every open session pings on its own.** Ten idle sessions can produce up to thirty pings.
- **Pings show up in the transcript.** Each one appears as a short system reminder followed by an "ok" reply.
- **The script relies on details that aren't a documented contract.** These are the `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PID` environment variables and the `usage` fields in the transcript. If the entrypoint variable changes, the script stops pinging. If the transcript format changes, it still pings but skips the TTL and size checks.
- **API-key billing with a 5-minute TTL isn't covered.** For that, use the upstream project.

## Tests

```bash
bash test/cache-keepalive.test.sh
```

This runs 22 checks with 3-second intervals in a temporary directory.

## License

MIT. Inspired by [yujiachen-y/claude-code-cache-keepalive](https://github.com/yujiachen-y/claude-code-cache-keepalive).

---

## 中文说明

在 **claude.ai 订阅**（Pro/Max）下使用 Claude Code 时，让 **1 小时的提示缓存**在你离开期间保持有效。整个项目只有一个 Node.js hook 脚本，没有常驻进程，也没有依赖。

### 为什么需要

订阅会话写入的提示缓存有效期是 1 小时，会话记录里的 `ephemeral_1h_input_tokens` 就是证据。离开超过 1 小时再回来，下一条消息就得把整个对话重新写入缓存。上下文很大时，这意味着几十万 token 要按缓存写入价计费，而不是便宜的缓存读取价。

Anthropic 的提示缓存每被读取一次，有效期就会重新计算，这个 hook 正是利用了这一点。会话空闲时，它大约每 50 分钟发一次很小的保活请求，最多 3 次。这样缓存能在你最后一条消息之后保持约 3.5 小时。

### 工作原理

- Claude 每轮回复结束时，会启动一个带 `asyncRewake: true` 的 `Stop` hook。它在后台等待，不影响你继续使用会话。
- 等待 `CCKA_INTERVAL` 秒（默认 3000）后，hook 以退出码 2 结束，唤醒 Claude 回复一个词。这次请求会读取缓存，让 1 小时的计时从头开始。
- 期间出现任何真实活动，待发的保活都会取消。真实活动包括新的提问、新一轮回复，或者会话记录里出现了新消息。
- 每个会话在 `~/.claude/cache-keepalive/<session_id>.json` 里单独计数，多个会话同时开着也互不影响。

以下情况不会发送保活：

- **不是订阅计费的会话。** 包括设置了 API key 或 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 指向中转站或网关、使用 Bedrock/Vertex/Foundry，以及 `claude -p` 和 SDK 调用。桌面 App 始终用 claude.ai 账号登录，所以桌面会话一律算订阅会话。
- **会话记录显示缓存有效期是 5 分钟。** 50 分钟一次的保活赶不上。
- **上下文太小。** 低于 `CCKA_MIN_CONTEXT`（默认 5 万 token）的会话，重建缓存本来就便宜。
- **会话本来就会被唤醒。** 例如有后台任务或定时唤醒。

### 安装

1. 复制脚本：

   ```bash
   mkdir -p ~/.claude/hooks
   cp cache-keepalive.js ~/.claude/hooks/
   ```

2. 把 [`settings.example.json`](settings.example.json) 里的 `hooks` 合并进 `~/.claude/settings.json`。如果文件里有 `"disableAllHooks": true`，改成 `false`。正在运行的会话会自动加载新设置。

3. 下次回复结束后查看日志，应该能看到 `waiting 3000s before ping 1/3 (ttl=1h, context=...)`：

   ```bash
   tail -f ~/.claude/cache-keepalive/keepalive.log
   ```

**如果你用 CC Switch：** 它每次切换供应商都会重写 `~/.claude/settings.json`。请把 hooks 和 `"disableAllHooks": false` 写进 CC Switch 的 Claude Code 通用配置，并确认所用的供应商开启了通用配置。内置的官方供应商可能没有开启，切换过去会把其他设置全部清空。

### 配置

可以在 `settings.json` 的 `env` 里设置以下环境变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `CCKA_INTERVAL` | `3000` | 每次保活前等待的秒数，需小于 3600。 |
| `CCKA_MAX_LOOPS` | `3` | 每段空闲期最多保活几次。 |
| `CCKA_MIN_CONTEXT` | `50000` | 上下文小于这个 token 数的会话不保活。 |
| `CCKA_MESSAGE` | 一句英文 | Claude 收到的保活消息，可以改成中文。 |
| `CCKA_STATE_DIR` | `~/.claude/cache-keepalive` | 状态文件和日志所在的目录。 |

如果调大 `CCKA_INTERVAL`，Stop hook 的 `timeout` 要始终比它大。

### 暂停和卸载

- 暂停：执行 `touch ~/.claude/cache-keepalive/DISABLED`，删掉这个文件即可恢复。
- 卸载：删掉那三条 hook 配置，以及 `~/.claude/hooks/cache-keepalive.js`。

### 注意事项

- **每次保活都是一轮真实对话。** 它会读取整个缓存的提示，并计入你的用量。官方没有公开订阅额度如何计算缓存读取，启用后请留意用量变化。
- **每个开着的会话都会各自保活。** 10 个空闲会话最多会产生 30 次保活。
- **保活会出现在会话记录里。** 每次是一条简短的系统提醒，加上一句 “ok”。
- **脚本依赖一些没有正式文档保证的细节。** 包括 `CLAUDE_CODE_ENTRYPOINT` 和 `CLAUDE_PID` 环境变量，以及会话记录里的 `usage` 字段。如果 entrypoint 变量变了，脚本会停止保活；如果会话记录格式变了，脚本仍会保活，但会跳过缓存有效期和上下文大小的检查。
- **不适用于 API key 计费、5 分钟缓存的场景。** 这种情况请使用原版项目。

### 测试

```bash
bash test/cache-keepalive.test.sh
```

这会在临时目录里用 3 秒的间隔跑 22 项检查。

### 许可证

MIT。灵感来自 [yujiachen-y/claude-code-cache-keepalive](https://github.com/yujiachen-y/claude-code-cache-keepalive)。
