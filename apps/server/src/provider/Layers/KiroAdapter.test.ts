// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createModelSelection } from "@t3tools/shared/model";

import {
  KiroSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type { KiroAdapterShape } from "../Services/KiroAdapter.ts";
import { makeKiroAdapter } from "./KiroAdapter.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

class KiroAdapter extends Context.Service<KiroAdapter, KiroAdapterShape>()(
  "t3/provider/Layers/KiroAdapter.test/KiroAdapter",
) {}

async function makeMockKiroWrapper(extraEnv: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-mock-"));
  const wrapperPath = NodePath.join(directory, "kiro-cli");
  const environment = Object.entries(extraEnv)
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  await NodeFSP.writeFile(
    wrapperPath,
    [
      "#!/bin/sh",
      environment,
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

const makeResolveKiroSettings = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;
  return serverSettings.getSettings.pipe(
    Effect.map((snapshot) => snapshot.providers.kiro),
    Effect.orDie,
  );
});

const kiroAdapterTestLayer = it.layer(
  Layer.effect(
    KiroAdapter,
    Effect.gen(function* () {
      return yield* makeKiroAdapter(decodeKiroSettings({}), {
        resolveSettings: yield* makeResolveKiroSettings,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "t3code-kiro-adapter-test-",
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  ),
);

kiroAdapterTestLayer("KiroAdapterLive", (it) => {
  it.effect("fulfills advertised ACP filesystem and terminal capabilities", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const settings = yield* ServerSettingsService;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-client-tools-")),
      );
      const filePath = NodePath.join(directory, "bridge.txt");
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      yield* Effect.promise(() => NodeFSP.writeFile(filePath, "bridge input\n", "utf8"));
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_KIRO_MODELS: "1",
          T3_ACP_EMIT_KIRO_CLIENT_TOOLS: "1",
          T3_ACP_KIRO_TOOL_FILE_PATH: filePath,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { kiro: { binaryPath } } });

      const threadId = ThreadId.make("kiro-client-tools");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: directory,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run git pull", attachments: [] });
      yield* adapter.stopSession(threadId);

      assert.equal(
        yield* Effect.promise(() => NodeFSP.readFile(filePath, "utf8")),
        "bridge output\n",
      );
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepStrictEqual(
        requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
        {
          fs: { readTextFile: true, writeTextFile: true },
          terminal: true,
        },
      );
    }),
  );

  it.effect("retains the interactive model and emits raw JSON only as a chat content delta", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const settings = yield* ServerSettingsService;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-model-switch-")),
      );
      const requestLogPath = NodePath.join(directory, "requests.ndjson");
      const rawAssistantJson = '{"entities":[],"relations":[]}';
      yield* Effect.promise(() => NodeFSP.writeFile(requestLogPath, "", "utf8"));
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_KIRO_MODELS: "1",
          T3_ACP_PROMPT_RESPONSE_TEXT: rawAssistantJson,
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      yield* settings.updateSettings({ providers: { kiro: { binaryPath } } });

      const threadId = ThreadId.make("kiro-model-switch");
      const rawContentSeen = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event: ProviderRuntimeEvent) =>
        event.type === "content.delta" && event.payload.delta === rawAssistantJson
          ? Deferred.succeed(rawContentSeen, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkScoped);

      const alternate = createModelSelection(ProviderInstanceId.make("kiro"), "kiro-mock-alt");
      const initial = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: directory,
        runtimeMode: "full-access",
        modelSelection: alternate,
      });
      yield* adapter.sendTurn({
        threadId,
        input: "first message",
        attachments: [],
        modelSelection: alternate,
      });
      const switched = yield* adapter.sendTurn({
        threadId,
        input: "switch to auto",
        attachments: [],
        modelSelection: createModelSelection(ProviderInstanceId.make("kiro"), "auto"),
      });
      yield* Deferred.await(rawContentSeen);
      const thread = yield* adapter.readThread(threadId);
      yield* adapter.stopSession(threadId);

      assert.deepStrictEqual(initial.resumeCursor, switched.resumeCursor);
      assert.equal(thread.turns.length, 2);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const setModels = requests
        .filter((request) => request.method === "session/set_model")
        .map((request) => request.params?.modelId);
      assert.deepStrictEqual(setModels, ["kiro-mock-alt", "auto"]);
    }),
  );

  it.effect("automatically settles Kiro permission requests in full-access mode", () =>
    Effect.gen(function* () {
      const adapter = yield* KiroAdapter;
      const settings = yield* ServerSettingsService;
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "kiro-acp-full-access-")),
      );
      const binaryPath = yield* Effect.promise(() =>
        makeMockKiroWrapper({
          T3_ACP_KIRO_MODELS: "1",
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      yield* settings.updateSettings({ providers: { kiro: { binaryPath } } });

      const threadId = ThreadId.make("kiro-full-access");
      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("kiro"),
        cwd: directory,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "inspect the project", attachments: [] });
      yield* adapter.stopSession(threadId);
    }),
  );
});
