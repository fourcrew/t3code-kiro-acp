import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  applyKiroAcpModelSelection,
  buildKiroAcpSpawnInput,
  KIRO_INTERACTIVE_ACP_CLIENT_CAPABILITIES,
  resolveKiroAcpBaseModelId,
} from "./KiroAcpSupport.ts";

describe("resolveKiroAcpBaseModelId", () => {
  it("defaults blank values to Kiro's auto model", () => {
    expect(resolveKiroAcpBaseModelId(undefined)).toBe("auto");
    expect(resolveKiroAcpBaseModelId("   ")).toBe("auto");
    expect(resolveKiroAcpBaseModelId("  kiro-mock-alt  ")).toBe("kiro-mock-alt");
  });
});

describe("KIRO_INTERACTIVE_ACP_CLIENT_CAPABILITIES", () => {
  it("advertises the filesystem and terminal callbacks backed by the interactive adapter", () => {
    expect(KIRO_INTERACTIVE_ACP_CLIENT_CAPABILITIES).toEqual({
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    });
  });
});

describe("buildKiroAcpSpawnInput", () => {
  it("starts kiro-cli acp without an agent override by default", () => {
    expect(buildKiroAcpSpawnInput({ binaryPath: "kiro-cli", agent: "" }, "/tmp/project")).toEqual({
      command: "kiro-cli",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });

  it("passes a trimmed agent name after the acp subcommand", () => {
    expect(
      buildKiroAcpSpawnInput(
        { binaryPath: "/opt/kiro-cli", agent: "  security-review  " },
        "/tmp/project",
        { HOME: "/tmp/home" },
      ),
    ).toEqual({
      command: "/opt/kiro-cli",
      args: ["acp", "--agent", "security-review"],
      cwd: "/tmp/project",
      env: { HOME: "/tmp/home" },
    });
  });
});

describe("applyKiroAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyKiroAcpModelSelection({
        runtime,
        currentModelId: "auto",
        requestedModelId: "kiro-mock-alt",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["kiro-mock-alt"]);
      expect(result).toBe("kiro-mock-alt");
    }),
  );

  it.effect("skips session/set_model when the requested model is current or absent", () =>
    Effect.gen(function* () {
      const first = makeRecordingRuntime();
      const same = yield* applyKiroAcpModelSelection({
        runtime: first.runtime,
        currentModelId: "auto",
        requestedModelId: "auto",
        mapError: (cause) => cause.message,
      });
      expect(first.modelCalls).toEqual([]);
      expect(same).toBe("auto");

      const second = makeRecordingRuntime();
      const absent = yield* applyKiroAcpModelSelection({
        runtime: second.runtime,
        currentModelId: "auto",
        requestedModelId: undefined,
        mapError: (cause) => cause.message,
      });
      expect(second.modelCalls).toEqual([]);
      expect(absent).toBe("auto");
    }),
  );

  it.effect("maps session/set_model failures", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("model unavailable");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyKiroAcpModelSelection({
          runtime,
          currentModelId: "auto",
          requestedModelId: "kiro-mock-alt",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe("model unavailable");
    }),
  );
});
