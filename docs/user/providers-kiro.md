# Kiro

T3 Code can drive Kiro through Kiro CLI's standard Agent Client Protocol (ACP) transport.
The server starts the CLI as `kiro-cli acp` and keeps the ACP session on the machine running T3
Code.

## Install Kiro CLI

Install Kiro CLI using the [official Kiro CLI documentation](https://kiro.dev/docs/cli/), then
review Kiro's [ACP documentation](https://kiro.dev/docs/cli/acp/). Verify the CLI is available on
the same machine that runs the T3 Code server:

```bash
kiro-cli --version
```

If `kiro-cli` is not on the server's `PATH`, set **Binary path** in the Kiro provider settings to
its absolute path.

## Add Kiro in T3 Code

Open **Settings** → **Providers** and add or enable **Kiro**. The settings are:

- **Enabled** — whether T3 Code includes Kiro in provider discovery and the model picker.
- **Binary path** — defaults to `kiro-cli`.
- **Agent** — optional Kiro agent name. When set, T3 Code launches
  `kiro-cli acp --agent <name>`.

The provider uses the Kiro CLI environment and configuration available to the T3 Code server
process. Configure Kiro on that machine, not only on the device used to open the web or mobile
client.

## Authentication

Kiro's ACP implementation advertises no ACP authentication methods. T3 Code therefore does not
send an `authenticate` request before creating a session. It starts `session/new` directly and
uses the session returned by Kiro.

This does not bypass Kiro's own account or environment requirements. If the CLI cannot start or
cannot use the Kiro configuration available to the server process, the Kiro provider status in
T3 Code reports the CLI or ACP startup failure.

## Models and modes

- **Auto** is the default model.
- T3 Code discovers the models advertised by Kiro during ACP session setup.
- Model changes use ACP `session/set_model` and do not require a new thread.
- The interaction-mode control maps T3 Code's plan and implementation choices to Kiro's advertised
  ACP session modes. If a Kiro build uses different mode ids, T3 Code matches the available mode by
  its id, name, and description.

Kiro supports the standard T3 Code permission flow, prompt cancellation, attachments, session
resume, and streamed assistant/tool events exposed by ACP.

## Troubleshooting

### Kiro is missing or unhealthy

Run `kiro-cli --version` on the machine running T3 Code. If it succeeds there, set the provider's
**Binary path** explicitly and refresh provider status.

### ACP startup fails

Run `kiro-cli acp` directly in the same environment used by the server. Check the Kiro CLI output
and confirm that the installed CLI supports ACP session creation. The authoritative protocol
reference is the [Kiro ACP documentation](https://kiro.dev/docs/cli/acp/).

### The model list is empty

Refresh provider status after confirming ACP starts. T3 Code falls back to **Auto** and any custom
models configured for the provider when Kiro cannot advertise a model list during discovery.
