import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import type * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const DEFAULT_OUTPUT_BYTE_LIMIT = 1_000_000;

interface KiroAcpTerminal {
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly output: Ref.Ref<{ readonly text: string; readonly truncated: boolean }>;
  readonly exit: Ref.Ref<{ readonly exitCode?: number; readonly signal?: string }>;
}

export interface InstallKiroAcpClientToolsInput {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    | "handleCreateTerminal"
    | "handleReadTextFile"
    | "handleTerminalKill"
    | "handleTerminalOutput"
    | "handleTerminalRelease"
    | "handleTerminalWaitForExit"
    | "handleWriteTextFile"
  >;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly cwd: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly sessionScope: Scope.Closeable;
}

function retainOutput(
  current: { readonly text: string; readonly truncated: boolean },
  chunk: string,
  byteLimit: number,
): { readonly text: string; readonly truncated: boolean } {
  let text = current.text + chunk;
  let truncated = current.truncated;
  while (Buffer.byteLength(text) > byteLimit) {
    text = text.slice(1);
    truncated = true;
  }
  return { text, truncated };
}

function readRequestedLines(input: {
  readonly content: string;
  readonly line: number | null | undefined;
  readonly limit: number | null | undefined;
}): string {
  const start = Math.max(0, (input.line ?? 1) - 1);
  const lines = input.content.split("\n");
  return lines
    .slice(
      start,
      input.limit === undefined || input.limit === null ? undefined : start + input.limit,
    )
    .join("\n");
}

export const installKiroAcpClientTools = Effect.fn("installKiroAcpClientTools")(function* (
  input: InstallKiroAcpClientToolsInput,
) {
  const terminals = new Map<string, KiroAcpTerminal>();
  let nextTerminalId = 0;

  const mapCallbackError = <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: `Failed to service Kiro ACP ${method}.`,
            cause,
          }),
      ),
    );

  const isWithinWorkspace = (workspaceRoot: string, targetPath: string) => {
    const relativePath = input.path.relative(workspaceRoot, targetPath);
    return (
      relativePath.length > 0 &&
      relativePath !== ".." &&
      !relativePath.startsWith(`..${input.path.sep}`) &&
      !input.path.isAbsolute(relativePath)
    );
  };

  const readWorkspacePath = (requestedPath: string) =>
    Effect.gen(function* () {
      if (!input.path.isAbsolute(requestedPath)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must use absolute paths.",
        );
      }
      const workspaceRoot = yield* input.fileSystem.realPath(input.cwd);
      const targetPath = yield* input.fileSystem.realPath(input.path.resolve(requestedPath));
      if (!isWithinWorkspace(workspaceRoot, targetPath)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must target a file within the active workspace.",
        );
      }
      return targetPath;
    });

  const writeWorkspacePath = (requestedPath: string) =>
    Effect.gen(function* () {
      if (!input.path.isAbsolute(requestedPath)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must use absolute paths.",
        );
      }
      const workspaceRoot = yield* input.fileSystem.realPath(input.cwd);
      const targetPath = input.path.resolve(requestedPath);
      if (!isWithinWorkspace(workspaceRoot, targetPath)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must target a file within the active workspace.",
        );
      }
      yield* input.fileSystem.makeDirectory(input.path.dirname(targetPath), { recursive: true });
      const targetParent = yield* input.fileSystem.realPath(input.path.dirname(targetPath));
      if (!isWithinWorkspace(workspaceRoot, targetParent) && targetParent !== workspaceRoot) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must target a file within the active workspace.",
        );
      }
      const existingTarget = yield* input.fileSystem
        .realPath(targetPath)
        .pipe(Effect.orElseSucceed(() => targetPath));
      if (!isWithinWorkspace(workspaceRoot, existingTarget)) {
        return yield* EffectAcpErrors.AcpRequestError.invalidParams(
          "Kiro ACP file requests must target a file within the active workspace.",
        );
      }
      return targetPath;
    });

  const getTerminal = (terminalId: string) => {
    const terminal = terminals.get(terminalId);
    return terminal
      ? Effect.succeed(terminal)
      : Effect.fail(
          EffectAcpErrors.AcpRequestError.invalidParams(`Unknown terminal: ${terminalId}`),
        );
  };

  const exitStatus = (terminal: KiroAcpTerminal) =>
    Ref.get(terminal.exit).pipe(
      Effect.map((exit) =>
        exit.exitCode === undefined && exit.signal === undefined
          ? undefined
          : {
              ...(exit.exitCode === undefined ? {} : { exitCode: exit.exitCode }),
              ...(exit.signal === undefined ? {} : { signal: exit.signal }),
            },
      ),
    );

  yield* input.runtime.handleReadTextFile((request) =>
    mapCallbackError(
      "fs/read_text_file",
      Effect.gen(function* () {
        const targetPath = yield* readWorkspacePath(request.path);
        const content = yield* input.fileSystem.readFileString(targetPath);
        return {
          content: readRequestedLines({
            content,
            line: request.line,
            limit: request.limit,
          }),
        } satisfies EffectAcpSchema.ReadTextFileResponse;
      }),
    ),
  );

  yield* input.runtime.handleWriteTextFile((request) =>
    mapCallbackError(
      "fs/write_text_file",
      Effect.gen(function* () {
        const targetPath = yield* writeWorkspacePath(request.path);
        yield* input.fileSystem.writeFileString(targetPath, request.content);
        return {} satisfies EffectAcpSchema.WriteTextFileResponse;
      }),
    ),
  );

  yield* input.runtime.handleCreateTerminal((request) =>
    mapCallbackError(
      "terminal/create",
      Effect.gen(function* () {
        const terminalId = `kiro-acp-${++nextTerminalId}`;
        const byteLimit = Math.min(
          request.outputByteLimit ?? DEFAULT_OUTPUT_BYTE_LIMIT,
          DEFAULT_OUTPUT_BYTE_LIMIT,
        );
        const child = yield* input.childProcessSpawner
          .spawn(
            ChildProcess.make(request.command, request.args ?? [], {
              cwd: request.cwd ?? input.cwd,
              ...(request.env
                ? {
                    env: Object.fromEntries(request.env.map(({ name, value }) => [name, value])),
                    extendEnv: true,
                  }
                : { extendEnv: true }),
            }),
          )
          .pipe(Effect.provideService(Scope.Scope, input.sessionScope));
        const terminal: KiroAcpTerminal = {
          child,
          output: yield* Ref.make({ text: "", truncated: false }),
          exit: yield* Ref.make({}),
        };
        terminals.set(terminalId, terminal);
        yield* child.all.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Ref.update(terminal.output, (current) => retainOutput(current, chunk, byteLimit)),
          ),
          Effect.ignore,
          Effect.forkIn(input.sessionScope),
        );
        yield* child.exitCode.pipe(
          Effect.map(Number),
          Effect.flatMap((exitCode) => Ref.set(terminal.exit, { exitCode })),
          Effect.ignore,
          Effect.forkIn(input.sessionScope),
        );
        return { terminalId } satisfies EffectAcpSchema.CreateTerminalResponse;
      }),
    ),
  );

  yield* input.runtime.handleTerminalOutput((request) =>
    mapCallbackError(
      "terminal/output",
      Effect.gen(function* () {
        const terminal = yield* getTerminal(request.terminalId);
        const output = yield* Ref.get(terminal.output);
        const status = yield* exitStatus(terminal);
        return {
          output: output.text,
          truncated: output.truncated,
          ...(status ? { exitStatus: status } : {}),
        } satisfies EffectAcpSchema.TerminalOutputResponse;
      }),
    ),
  );

  yield* input.runtime.handleTerminalWaitForExit((request) =>
    mapCallbackError(
      "terminal/wait_for_exit",
      Effect.gen(function* () {
        const terminal = yield* getTerminal(request.terminalId);
        const exitCode = yield* terminal.child.exitCode.pipe(Effect.map(Number));
        const exit = yield* Ref.get(terminal.exit);
        const status = exit.signal ? { signal: exit.signal } : { exitCode };
        yield* Ref.set(terminal.exit, status);
        return status satisfies EffectAcpSchema.WaitForTerminalExitResponse;
      }),
    ),
  );

  yield* input.runtime.handleTerminalKill((request) =>
    mapCallbackError(
      "terminal/kill",
      Effect.gen(function* () {
        const terminal = yield* getTerminal(request.terminalId);
        yield* terminal.child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" });
        yield* Ref.set(terminal.exit, { signal: "SIGTERM" });
        return {} satisfies EffectAcpSchema.KillTerminalResponse;
      }),
    ),
  );

  yield* input.runtime.handleTerminalRelease((request) =>
    mapCallbackError(
      "terminal/release",
      Effect.gen(function* () {
        const terminal = yield* getTerminal(request.terminalId);
        terminals.delete(request.terminalId);
        if (yield* terminal.child.isRunning) {
          yield* terminal.child.kill({ killSignal: "SIGTERM", forceKillAfter: "1 second" });
        }
        return {} satisfies EffectAcpSchema.ReleaseTerminalResponse;
      }),
    ),
  );
});
