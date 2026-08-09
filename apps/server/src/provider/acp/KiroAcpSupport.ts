import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { KiroSettings, ProviderDriverKind } from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const KIRO_DRIVER_KIND = ProviderDriverKind.make("kiro");

type KiroAcpRuntimeKiroSettings = Pick<KiroSettings, "agent" | "binaryPath">;

export interface KiroAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "clientCapabilities" | "spawn"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined;
  readonly environment?: NodeJS.ProcessEnv;
}

export function buildKiroAcpSpawnInput(
  kiroSettings: KiroAcpRuntimeKiroSettings | null | undefined,
  cwd: string,
  environment?: NodeJS.ProcessEnv,
): AcpSessionRuntime.AcpSpawnInput {
  const agent = kiroSettings?.agent?.trim();
  return {
    command: kiroSettings?.binaryPath || "kiro-cli",
    args: ["acp", ...(agent ? ["--agent", agent] : [])],
    cwd,
    ...(environment ? { env: environment } : {}),
  };
}

export const makeKiroAcpRuntime = (
  input: KiroAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const acpContext = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...input,
        spawn: buildKiroAcpSpawnInput(input.kiroSettings, input.cwd, input.environment),
      }).pipe(
        Layer.provide(
          Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, input.childProcessSpawner),
        ),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(acpContext),
    );
  });

export function resolveKiroAcpBaseModelId(model: string | null | undefined): string {
  return normalizeModelSlug(model, KIRO_DRIVER_KIND) ?? "auto";
}

export function currentKiroModelIdFromSessionSetup(
  sessionSetupResult:
    | EffectAcpSchema.LoadSessionResponse
    | EffectAcpSchema.NewSessionResponse
    | EffectAcpSchema.ResumeSessionResponse,
): string | undefined {
  return sessionSetupResult.models?.currentModelId?.trim() || undefined;
}

export function applyKiroAcpModelSelection<E>(input: {
  readonly runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setSessionModel">;
  readonly currentModelId: string | undefined;
  readonly requestedModelId: string | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<string | undefined, E> {
  const shouldSwitchModel =
    input.requestedModelId !== undefined && input.requestedModelId !== input.currentModelId;
  if (!shouldSwitchModel) {
    return Effect.succeed(input.currentModelId);
  }
  return input.runtime
    .setSessionModel(input.requestedModelId)
    .pipe(Effect.mapError(input.mapError), Effect.as(input.requestedModelId));
}
