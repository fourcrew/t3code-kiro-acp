import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { KiroSettings, ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";

import * as ServerConfig from "../config.ts";
import * as TextGeneration from "./TextGeneration.ts";
import { makeKiroTextGeneration } from "./KiroTextGeneration.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../scripts/acp-mock-agent.ts");

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const KiroTextGenerationTestLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-kiro-text-generation-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

function makeAcpKiroWrapper(dir: string, env: Record<string, string>): string {
  const binDir = NodePath.join(dir, "bin");
  const kiroPath = NodePath.join(binDir, "kiro-cli");
  NodeFS.mkdirSync(binDir, { recursive: true });
  NodeFS.writeFileSync(
    kiroPath,
    [
      "#!/bin/sh",
      ...Object.entries(env).map(([key, value]) => `export ${key}=${shellSingleQuote(value)}`),
      'if [ "$1" != "acp" ]; then',
      '  printf "%s\\n" "unexpected args: $*" >&2',
      "  exit 11",
      "fi",
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(mockAgentPath)}`,
      "",
    ].join("\n"),
    "utf8",
  );
  NodeFS.chmodSync(kiroPath, 0o755);
  return kiroPath;
}

function withFakeAcpKiro<A, E, R>(
  env: Record<string, string>,
  effectFn: (textGeneration: TextGeneration.TextGeneration["Service"]) => Effect.Effect<A, E, R>,
) {
  return Effect.gen(function* () {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-kiro-text-acp-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }),
    );
    const binaryPath = makeAcpKiroWrapper(tempDir, env);
    const config = decodeKiroSettings({ binaryPath });
    const textGeneration = yield* makeKiroTextGeneration(config);
    return yield* effectFn(textGeneration);
  }).pipe(Effect.scoped);
}

function readJsonRpcRequests(
  filePath: string,
): ReadonlyArray<{ readonly method?: string; readonly params?: Record<string, unknown> }> {
  return NodeFS.readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

it.layer(KiroTextGenerationTestLayer)("KiroTextGeneration", (it) => {
  it.effect("uses no-auth ACP startup and forwards the requested model id", () => {
    const requestLogDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-kiro-log-"));
    const requestLogPath = NodePath.join(requestLogDir, "requests.ndjson");

    return withFakeAcpKiro(
      {
        T3_ACP_KIRO_MODELS: "1",
        T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        T3_ACP_PROMPT_RESPONSE_TEXT: JSON.stringify({
          subject: "Add Kiro provider",
          body: "Use kiro-cli acp without an authentication round trip.",
        }),
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateCommitMessage({
            cwd: process.cwd(),
            branch: "feature/kiro",
            stagedSummary: "M apps/server/src/provider/Drivers/KiroDriver.ts",
            stagedPatch: "diff --git a/.../KiroDriver.ts b/.../KiroDriver.ts",
            modelSelection: createModelSelection(ProviderInstanceId.make("kiro"), "kiro-mock-alt"),
          });

          expect(generated.subject).toBe("Add Kiro provider");
          expect(generated.body).toBe("Use kiro-cli acp without an authentication round trip.");

          const requests = readJsonRpcRequests(requestLogPath);
          expect(requests.some((request) => request.method === "authenticate")).toBe(false);
          expect(
            requests.find((request) => request.method === "initialize")?.params?.clientCapabilities,
          ).toMatchObject({
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          });
          expect(
            requests.some(
              (request) =>
                request.method === "session/set_model" &&
                request.params?.modelId === "kiro-mock-alt",
            ),
          ).toBe(true);
        }),
    );
  });

  it.effect("extracts a JSON object wrapped in conversational text", () =>
    withFakeAcpKiro(
      {
        T3_ACP_KIRO_MODELS: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT:
          "Here is the title:\n\n" +
          JSON.stringify({ title: "Investigate Kiro ACP" }) +
          "\n\nDone.",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const generated = yield* textGeneration.generateThreadTitle({
            cwd: process.cwd(),
            message: "the Kiro ACP probe is next",
            modelSelection: createModelSelection(ProviderInstanceId.make("kiro"), "auto"),
          });
          expect(generated.title).toBe("Investigate Kiro ACP");
        }),
    ),
  );

  it.effect("surfaces empty ACP output as a TextGenerationError", () =>
    withFakeAcpKiro(
      {
        T3_ACP_KIRO_MODELS: "1",
        T3_ACP_PROMPT_RESPONSE_TEXT: "   \n  ",
      },
      (textGeneration) =>
        Effect.gen(function* () {
          const error = yield* Effect.flip(
            textGeneration.generateThreadTitle({
              cwd: process.cwd(),
              message: "anything",
              modelSelection: createModelSelection(ProviderInstanceId.make("kiro"), "auto"),
            }),
          );
          expect(error._tag).toBe("TextGenerationError");
          expect(error.detail).toMatch(/empty/i);
        }),
    ),
  );
});
