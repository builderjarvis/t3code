// @effect-diagnostics-next-line nodeBuiltinImport:off -- APNs signing requires an EC private KeyObject.
import * as NodeCrypto from "node:crypto";
import {
  SelfHostedPushRegistration,
  AuthOrchestrationReadScope,
  type AuthSessionId,
  type ThreadId,
} from "@t3tools/contracts";
import { projectThreadAwarenessV2 } from "@t3tools/shared/agentAwareness";
import * as Config from "effect/Config";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import {
  shouldPublishAgentAwarenessEvent,
  makeAgentAwarenessPublishWorker,
} from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import { createApnsSender } from "./apns.ts";

const Registrations = Schema.Record(Schema.String, SelfHostedPushRegistration);
const decodeRegistrations = Schema.decodeEffect(Schema.fromJsonString(Registrations));
const storageKey = "self-hosted-push-devices";
export class PushError extends Schema.TaggedError<PushError>()("PushError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Self-hosted push operation failed.";
  }
}
export class SelfHostedPush extends Context.Service<
  SelfHostedPush,
  {
    readonly status: (
      sessionId: AuthSessionId,
    ) => Effect.Effect<{ configured: boolean; registered: boolean }, PushError>;
    readonly register: (
      sessionId: AuthSessionId,
      registration: typeof SelfHostedPushRegistration.Type,
    ) => Effect.Effect<void, PushError>;
    readonly unregister: (sessionId: AuthSessionId) => Effect.Effect<void, PushError>;
    readonly start: Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/push/SelfHostedPush") {}

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = yield* SessionStore.SessionStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const fs = yield* FileSystem.FileSystem;
  const lock = yield* Semaphore.make(1);
  const configuration = yield* Config.all({
    teamId: Config.String("T3CODE_APNS_TEAM_ID").pipe(Config.withDefault("")),
    keyId: Config.String("T3CODE_APNS_KEY_ID").pipe(Config.withDefault("")),
    bundleId: Config.String("T3CODE_APNS_BUNDLE_ID").pipe(Config.withDefault("")),
    keyFile: Config.String("T3CODE_APNS_KEY_FILE").pipe(Config.withDefault("")),
  });
  const configured = Object.values(configuration).every((value) => value.length > 0);
  if (!configured && Object.values(configuration).some((value) => value.length > 0)) {
    return yield* new PushError({
      cause: "Set all four T3CODE_APNS configuration values or none.",
    });
  }
  const send = configured
    ? createApnsSender({
        ...configuration,
        privateKey: yield* fs.readFileString(configuration.keyFile).pipe(
          Effect.flatMap((pem) =>
            Effect.try({
              try: () => {
                const key = NodeCrypto.createPrivateKey(pem);
                if (
                  key.asymmetricKeyType !== "ec" ||
                  key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
                )
                  throw new Error("APNs requires a P-256 key");
                return key;
              },
              catch: (cause) => new PushError({ cause }),
            }),
          ),
        ),
      })
    : null;
  const read = Effect.fn("SelfHostedPush.read")(function* () {
    const bytes = yield* secrets.get(storageKey);
    return Option.isNone(bytes)
      ? {}
      : yield* decodeRegistrations(new TextDecoder().decode(bytes.value));
  });
  const write = (value: typeof Registrations.Type) =>
    secrets.set(storageKey, new TextEncoder().encode(JSON.stringify(value)));
  const unregister = Effect.fn("SelfHostedPush.unregister")(
    function* (sessionId: AuthSessionId) {
      const registrations = { ...(yield* read()) };
      delete registrations[sessionId];
      yield* write(registrations);
    },
    lock.withPermit,
    Effect.mapError((cause) => new PushError({ cause })),
  );
  const status = Effect.fn("SelfHostedPush.status")(
    function* (sessionId: AuthSessionId) {
      return { configured, registered: configured && (yield* read())[sessionId] !== undefined };
    },
    Effect.mapError((cause) => new PushError({ cause })),
  );
  const register = Effect.fn("SelfHostedPush.register")(
    function* (sessionId: AuthSessionId, registration: typeof SelfHostedPushRegistration.Type) {
      if (!configured || registration.bundleId !== configuration.bundleId)
        return yield* new PushError({ cause: "APNs is not configured for this bundle ID" });
      const registrations = { ...(yield* read()) };
      for (const [id, existing] of Object.entries(registrations)) {
        if (existing.token === registration.token) delete registrations[id];
      }
      registrations[sessionId] = registration;
      yield* write(registrations);
    },
    lock.withPermit,
    Effect.mapError((cause) => new PushError({ cause })),
  );
  const attempted = new Map<string, string>();
  const removeInvalidRegistration = Effect.fn("SelfHostedPush.removeInvalidRegistration")(
    function* (id: string, token: string) {
      const registrations = { ...(yield* read()) };
      if (registrations[id]?.token !== token) return;
      delete registrations[id];
      yield* write(registrations);
    },
    lock.withPermit,
  );
  const startedAt = yield* Clock.currentTimeMillis;
  const publish = Effect.fn("SelfHostedPush.publish")(
    function* (threadId: ThreadId) {
      if (!send) return;
      const thread = yield* threads.getThreadShell(threadId);
      if (!thread || thread.archivedAt !== null) return;
      const project = yield* projects.getById(thread.projectId);
      if (Option.isNone(project)) return;
      const state = projectThreadAwarenessV2({
        environmentId: yield* environment.getEnvironmentId,
        thread,
        project: project.value,
      });
      if (
        !state ||
        !["completed", "failed", "waiting_for_input", "waiting_for_approval"].includes(state.phase)
      )
        return;
      if (Date.parse(state.updatedAt) < startedAt) return;
      if (
        (state.phase === "completed" || state.phase === "failed") &&
        (!thread.latestRunCompletedAt ||
          DateTime.toEpochMillis(thread.latestRunCompletedAt) < startedAt)
      )
        return;
      const identity = `${thread.latestRunId}:${state.phase}:${thread.pendingRuntimeRequest?.id ?? ""}`;
      const active = new Set(
        (yield* sessions.listActive())
          .filter((session) => session.scopes.includes(AuthOrchestrationReadScope))
          .map((session) => String(session.sessionId)),
      );
      const registrations = { ...(yield* read()) };
      for (const [id, registration] of Object.entries(registrations)) {
        if (!active.has(id)) {
          yield* removeInvalidRegistration(id, registration.token);
          continue;
        }
        const deliveryKey = `${id}:${threadId}`;
        if (attempted.get(deliveryKey) === identity) continue;
        // A later shell event must not reset the retry budget for the same alert.
        attempted.set(deliveryKey, identity);
        const payload = {
          aps: {
            alert: { title: state.threadTitle.slice(0, 120), body: state.headline.slice(0, 200) },
            sound: "default",
            "thread-id": `${state.environmentId}/${threadId}`,
          },
          body: { environmentId: state.environmentId, threadId, deepLink: state.deepLink },
        };
        for (let attempt = 0; attempt < 3; attempt++) {
          const current = (yield* read())[id];
          if (current?.token !== registration.token) break;
          if (
            !(yield* sessions.listActive()).some(
              (session) =>
                String(session.sessionId) === id &&
                session.scopes.includes(AuthOrchestrationReadScope),
            )
          ) {
            yield* removeInvalidRegistration(id, registration.token);
            break;
          }
          const result = yield* Effect.tryPromise({
            try: () => send(registration.token, registration.environment, payload),
            catch: (cause) => new PushError({ cause }),
          }).pipe(Effect.result);
          if (result._tag === "Success") {
            if (result.success.status === 200) {
              attempted.set(deliveryKey, identity);
              break;
            }
            if (
              result.success.status === 410 ||
              ["BadDeviceToken", "DeviceTokenNotForTopic", "Unregistered"].includes(
                result.success.reason,
              )
            ) {
              yield* removeInvalidRegistration(id, registration.token);
              break;
            }
            if (result.success.status !== 429 && result.success.status < 500) {
              yield* Effect.logWarning("self-hosted APNs rejected notification", {
                status: result.success.status,
              });
              break;
            }
          }
          if (attempt < 2) yield* Effect.sleep(`${attempt + 1} seconds`);
          else yield* Effect.logWarning("self-hosted APNs delivery retry budget exhausted");
        }
      }
      while (attempted.size > 4096) attempted.delete(attempted.keys().next().value!);
    },
    Effect.catch(() => Effect.logWarning("self-hosted push publication failed")),
  );
  const start = send
    ? Effect.gen(function* () {
        const worker = yield* makeAgentAwarenessPublishWorker(publish);
        yield* forkParked(
          Stream.runForEach(threads.streamDomainEvents, (event) =>
            shouldPublishAgentAwarenessEvent(event) ? worker.enqueue(event.threadId) : Effect.void,
          ),
        );
      })
    : Effect.void;
  return SelfHostedPush.of({ status, register, unregister, start });
});
export const layer = Layer.effect(SelfHostedPush, make);
