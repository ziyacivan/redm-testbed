# redm-testbed

Develop FiveM resources on macOS (or Linux), test them in the game on a Windows PC on your local network.

```
dev host (macOS)                         test host (Windows, RDR2 + RedM)
redm-testbed deploy ──── ssh ────►  relay ─► daemon (interactive session)
                                               ├─ FXServer (child process)
                                               └─ FiveM (fivem://connect)
```

- SSH is the only channel. The package opens no network port.
- The daemon runs in the desktop session of the logged-in user, so it can start FiveM, take screenshots and send input.
- Secrets (license key, RCON password) stay on the test host.

> Status: early development. Use it on development servers only. RCON gives full control of the server.

## Requirements

- Dev host: Node.js 22.18 or later, `ssh`, `scp`, `tar`.
- Test host: Windows 10/11, Node.js 22.18 or later, RDR2 (Steam) and RedM, the OpenSSH server with key authentication.

## Set up the test host (once, as administrator)

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
Start-Service sshd
Set-Service sshd -StartupType Automatic
Set-NetFirewallRule -Name OpenSSH-Server-In-TCP -Enabled True -Profile Any -RemoteAddress LocalSubnet
```

Add the public key of the dev host. For an administrator account, use `C:\ProgramData\ssh\administrators_authorized_keys` and give access to Administrators and SYSTEM only:

```powershell
icacls C:\ProgramData\ssh\administrators_authorized_keys /inheritance:r /grant "*S-1-5-32-544:F" /grant "SYSTEM:F"
```

When a key login works, set `PasswordAuthentication no` in `C:\ProgramData\ssh\sshd_config` and restart `sshd`.

## Use it in a project

```sh
npx redm-testbed init            # writes redm-testbed.config.json and redm-testbed/server.cfg
# edit "host" (an SSH alias), "build" and "resources"
npx redm-testbed host install    # installs the same version on the test host, FXServer and the daemon
```

On the test host, set `LICENSE_KEY=` in `C:\redm-testbed\secrets.env` to a key from <https://portal.cfx.re>.

```sh
npx redm-testbed doctor
npx redm-testbed deploy
npx redm-testbed server start
npx redm-testbed client launch
npx redm-testbed logs --follow
```

## Extra secrets

A project can need more secrets, for example a database connection string. Put them in `secrets.env` on the test host:

```
CFG_my_database_url=postgres://user:password@127.0.0.1:5432/db
```

Before each start, the daemon writes `set my_database_url "..."` into `secrets.cfg` (never `setr`). The name must be a valid convar name; the value must not contain `"` or a line break.
List the required secrets in `redm-testbed.config.json`, so `doctor` and `server start` report a missing one:

```json
{ "secrets": ["my_database_url"] }
```

## Commands

| Command | Action |
| ------- | ------ |
| `init` | Write a starter configuration. |
| `host install [--local]` | Install this version on the test host and run `host setup`. `--local` installs from a local `npm pack`. |
| `deploy [resource...]` | Run the build command, upload the resources, `refresh` and `ensure`. |
| `server <start\|stop\|restart\|status>` | Control FXServer. |
| `client <launch [--no-wait]\|quit\|status>` | Control FiveM. `launch` waits until the client joins (`joined`, with its server ID) or fails (`failed`, with the reason from the client log), and exits with code 1 on failure. |
| `logs [--follow] [--lines <n>]` | Show the server console. |
| `rcon <command...>` | Run a server console command. |
| `screenshot [--out <file>] [--max <px>]` | Save a PNG of the game window. |
| `key <name>` | Press a key in the game window. |
| `type <text...>` | Type text into the game window. |
| `doctor` | Check the configuration, the daemon and the test host. |
| `mcp` | Start the MCP server (stdio) for an AI agent. |

## Client state

The daemon follows the FiveM client log while FiveM runs. Each line goes to the client console with the prefix `[client-log]`, so `read_console` and `wait_for_console` see connection errors before the game console exists.
`client status` shows `state`: `idle`, `starting`, `connecting`, `joined`, `failed` (with `reason`) or `stopped`.

## AI agents (MCP)

Add the server to the project, for example in `.mcp.json`:

```json
{ "mcpServers": { "redm-testbed": { "command": "npx", "args": ["redm-testbed", "mcp"] } } }
```

The MCP server runs on the dev host. One `deploy` call builds, uploads and restarts.

| Tool | Action |
| ---- | ------ |
| `doctor` | Check the environment. Call first. |
| `deploy` | Build, upload and restart resources. |
| `server_control`, `client_control` | Start, stop, restart, launch, quit, status. |
| `server_command` | Server console command (RCON). |
| `client_command` | Client F8 console command (devcon). |
| `read_console`, `wait_for_console` | Read or wait for server or client console lines. |
| `bridge` | Operations inside the game through `testbed-bridge`. |
| `screenshot` | PNG of the game window, scaled down (default longest side 640 px), optional crop. |
| `window_status` | Game window found, focused, title, size. |
| `press_key`, `type_text`, `mouse` | Keyboard (scan codes) and mouse input to the game window. |
| `steps` | Up to 30 actions in one call (`key`, `keys`, `text`, `mouse`, `wait`, `command`, `console`, up to 3 `screenshot`). Stops at the first failure. Use it for any flow of inputs: each tool call is a whole model turn, and a screenshot stays in the context. |

The window tools need an unlocked desktop on the test host. The daemon runs them through a PowerShell helper in the desktop session; no native module is installed.

The prompt `test_resource` runs a full test of one resource and reports PASS or FAIL with evidence.

## testbed-bridge

The daemon installs the resource `testbed-bridge` and adds `ensure testbed-bridge` to `server.cfg`.

| Side | Operations |
| ---- | ---------- |
| Server | `ping`, `players`, `call_export {resource, method, args}`, `trigger_event {event, args, player?}` |
| Client | `ping`, `position`, `teleport {x, y, z, heading?}`, `freeze {on}`, `call_native {name, args}`, `nui_callback {resource, endpoint, payload}` |

`nui_callback` calls the NUI callback of another resource through the NUI page of the bridge, as a browser click would.
It does not work for a resource that sets `nui_callback_strict_mode` in its manifest.

Allowlists in `redm-testbed.config.json`:

```json
{ "bridge": { "events": ["my:event"], "exports": ["myres:*"], "natives": [] } }
```

An empty `natives` list allows all natives. Empty `events` and `exports` lists allow none.

## License

MIT
