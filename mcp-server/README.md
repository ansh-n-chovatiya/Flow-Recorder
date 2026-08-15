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
payloads. That's why auto-send is off by default in the extension, and why
hosting this server somewhere shared is a decision to make carefully.

## Remote mode

```sh
MCP_MODE=remote PORT=8080 npx flowsnap-mcp
```

Serves MCP over SSE at `/mcp` and accepts flows at `/flows`, for use as a custom
connector. There is no authentication — anything that can reach it can read
every flow — so treat it as single-tenant and put it behind something.

## Licence

MIT
