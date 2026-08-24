# flowsnap-mcp

Gives Claude Code the browser flow you just recorded — the clicks, the console
errors, the failed requests and their bodies, and a screenshot of every step —
so it can fix the bug in your project instead of being told about it.

Pairs with the [FlowSnap Chrome extension](https://github.com/ansh-n-chovatiya/Flow-Recorder).

## Install

```sh
claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp
```

`--scope user` registers it once for every project you open, in both the Claude
Code CLI and the VS Code extension. Nothing to clone, nothing to build.

Then record a flow in the extension and press **Send**. It lands in
`~/.flowsnap/flows` and Claude can read it immediately.

## Tools

| Tool | Use it for |
| --- | --- |
| `list_flows` | What has been recorded, newest first, with a count of failing steps |
| `get_flow_errors` | Only the steps that broke — the first call when debugging |
| `get_flow` | The whole recording: walkthrough, step data, screenshot paths |
| `get_flow_screenshots` | Images inline, when reading files from disk isn't possible |
| `get_latest_flow` | The recording you just made |

Screenshots are written to disk and referenced by absolute path. Claude Code
reads them with its own file tools, one at a time, so a 500-step recording costs
nothing until a specific image is opened.

## Where flows live

`~/.flowsnap/flows`, one directory per flow:

```
~/.flowsnap/flows/flow-1755000000000/
  flow.json          steps, network calls, console output
  flow.md            readable walkthrough
  meta.json          index entry
  screenshots/       step-01.jpg, step-02.jpg, …
```

Set `FLOWSNAP_DIR` to put them somewhere else.

Not inside the npm package: under `npx` that directory is a cache which gets
cleared without warning, and it would take every recording with it.

### How much is kept

The newest 200 flows, up to 2 GB. Past either ceiling the oldest recordings are
deleted as new ones arrive, oldest first, and each one is named on stderr and in
the POST response rather than disappearing quietly.

| Variable | Default | |
| --- | --- | --- |
| `FLOWSNAP_MAX_FLOWS` | `200` | Recordings kept |
| `FLOWSNAP_MAX_BYTES` | `2147483648` | Bytes kept, screenshots included |

Two ceilings because they fail differently: a handful of enormous flows blows the
disk budget while the count still looks fine, and a great many tiny ones blow the
count while the bytes look fine. Both are runaway guards rather than a retention
policy — losing a recording someone still wanted is the worse failure — so they
sit well above any plausible working set.

A recording is ordered by when it was *made*, not when it was last sent, so
re-sending an old flow does not make it look new. It is never evicted by its own
save: the flow you just sent is always there when you go to read it.

## Running more than one Claude session

The extension POSTs recordings to `127.0.0.1:7734`, and at user scope every
session starts its own copy of this server. Only the first can hold the port;
the rest log a line and serve from the same directory. Flows arrive once and
every session sees them.

If no session is open, nothing is listening and the send fails — the recording
is still in the extension's library, so pressing Send again later works.

## Privacy

Everything stays on your machine. The server binds to loopback and writes to
your home directory.

Captured **request and response bodies are not redacted** — only headers are. A
recorded flow can therefore contain whatever your app sent, including tokens in
payloads. URLs are not redacted either, so an OAuth callback recorded mid-flow
keeps its `?code=` intact. That's why auto-send is off by default in the
extension, and why hosting this server somewhere shared is a decision to make
carefully.

Deleting a flow in the extension deletes it here too. Only the extension may
write or delete: a request carrying a web page's `Origin` is refused, because a
loopback port is reachable from any page you happen to have open.

## Remote mode

```sh
MCP_MODE=remote PORT=8080 npx flowsnap-mcp
```

Serves MCP over SSE at `/mcp` and accepts flows at `/flows`, for use as a custom
connector. There is no authentication — anything that can reach it can read
every flow — so treat it as single-tenant and put it behind something.

## Licence

MIT
