import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { KiroSettings } from "@t3tools/contracts";

import { buildInitialKiroProviderSnapshot, checkKiroProviderStatus } from "./KiroProvider.ts";

const decodeKiroSettings = Schema.decodeSync(KiroSettings);

describe("buildInitialKiroProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ enabled: false }),
      );
      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns auto as the default model while the CLI is pending", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialKiroProviderSnapshot(
        decodeKiroSettings({ customModels: ["team-model"] }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto", "team-model"]);
      expect(snapshot.requiresNewThreadForModelChange).toBe(false);
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

it.layer(NodeServices.layer)("checkKiroProviderStatus", (it) => {
  it.effect("reports the binary as missing when the path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkKiroProviderStatus(
        decodeKiroSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/kiro-cli",
        }),
      );
      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toMatch(/not installed|not on PATH|Failed to execute/);
    }),
  );

  it.effect("reports an installed CLI as unhealthy when --version exits non-zero", () =>
    Effect.gen(function* () {
      const secretStderr = "broken kiro install: secret-token-value";
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-version-" });
          const kiroPath = path.join(dir, "kiro-cli");
          yield* fs.writeFileString(
            kiroPath,
            ["#!/bin/sh", `printf "%s\\n" "${secretStderr}" >&2`, "exit 2", ""].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toBe("Kiro CLI is installed but failed to run.");
      expect(snapshot.message).not.toContain(secretStderr);
    }),
  );

  it.effect("keeps the auto fallback when ACP model discovery is unavailable", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-kiro-success-" });
          const kiroPath = path.join(dir, "kiro-cli");
          yield* fs.writeFileString(
            kiroPath,
            ["#!/bin/sh", 'printf "kiro-cli 0.0.99\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(kiroPath, 0o755);

          return yield* checkKiroProviderStatus(
            decodeKiroSettings({ enabled: true, binaryPath: kiroPath }),
          );
        }),
      );

      expect(snapshot.status).toBe("error");
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("0.0.99");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["auto"]);
      expect(snapshot.message).toContain("ACP startup failed");
    }),
  );
});
