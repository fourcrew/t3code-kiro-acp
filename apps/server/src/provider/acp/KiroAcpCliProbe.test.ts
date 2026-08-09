import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeKiroAcpRuntime } from "./KiroAcpSupport.ts";

const makeProbeRuntime = Effect.gen(function* () {
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* makeKiroAcpRuntime({
    kiroSettings: {
      binaryPath: process.env.T3_KIRO_BINARY_PATH ?? "kiro-cli",
      agent: process.env.T3_KIRO_AGENT ?? "",
    },
    environment: process.env,
    childProcessSpawner,
    cwd: process.cwd(),
    clientInfo: { name: "t3-kiro-probe", version: "0.0.0" },
  });
});

describe.runIf(process.env.T3_KIRO_ACP_PROBE === "1")("Kiro ACP CLI probe", () => {
  it.effect("initializes and creates a session without an authenticate request", () =>
    Effect.gen(function* () {
      const runtime = yield* makeProbeRuntime;
      const started = yield* runtime.start();
      expect(started.initializeResult).toBeDefined();
      expect(started.initializeResult.authMethods).toEqual([]);
      expect(typeof started.sessionId).toBe("string");
      expect(started.sessionSetupResult.models).toBeDefined();
      expect(started.sessionSetupResult.models?.currentModelId).toBe("auto");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
