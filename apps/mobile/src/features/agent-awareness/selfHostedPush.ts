import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { AppState, Platform } from "react-native";
import { EnvironmentId, type SelfHostedPushRegistration } from "@t3tools/contracts";
import { executeAuthenticatedEnvironmentHttpRequest } from "@t3tools/client-runtime/state/session";
import { createRuntimeCommand, runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { RemoteEnvironmentAuthorization } from "@t3tools/client-runtime/authorization";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentSession } from "../../state/session";
import { runtime } from "../../lib/runtime";
import * as MobilePreferences from "../../persistence/mobile-preferences";
import { supportsAgentAwarenessPush } from "./capabilities";
import { resolveApsEnvironment } from "./registrationPayload";

const request = createRuntimeCommand(connectionAtomRuntime, {
  label: "mobile:self-hosted-push",
  execute: Effect.fn("mobile.selfHostedPush.request")(function* (input: {
    environmentId: EnvironmentId;
    action: "status" | "register" | "unregister";
    registration?: typeof SelfHostedPushRegistration.Type;
  }) {
    const prepared = appAtomRegistry.get(
      environmentSession.preparedConnectionValueAtom(input.environmentId),
    );
    if (Option.isNone(prepared))
      return yield* Effect.fail(new Error("Connect to this environment first."));
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const base = {
      prepared: prepared.value,
      signer,
      remoteAuthorization,
      group: "push" as const,
      timeoutMs: 15_000,
    };
    if (input.action === "status")
      return yield* executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "GET",
        url: (urls) => urls.status(),
        request: ({ client, headers }) => client.status({ headers }),
      });
    if (input.action === "register" && input.registration) {
      const payload = input.registration;
      yield* executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "POST",
        url: (urls) => urls.register(),
        request: ({ client, headers }) => client.register({ headers, payload }),
      });
    } else {
      yield* executeAuthenticatedEnvironmentHttpRequest({
        ...base,
        method: "DELETE",
        url: (urls) => urls.unregister(),
        request: ({ client, headers }) => client.unregister({ headers }),
      });
    }
    return { configured: true, registered: input.action === "register" };
  }),
});

async function execute(input: Parameters<typeof request.run>[1]) {
  const result = await runAtomCommand(appAtomRegistry, request, input, { reportFailure: false });
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  if (result._tag !== "Success") throw new Error("Push registration was interrupted.");
  return result.value;
}

export const selfHostedPushStatus = (environmentId: EnvironmentId) =>
  execute({ environmentId, action: "status" });

const pendingChanges = new Map<EnvironmentId, Promise<void>>();

export function setSelfHostedPush(
  environmentId: EnvironmentId,
  enabled: boolean,
  requestPermission = true,
) {
  const operation = (pendingChanges.get(environmentId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => updateSelfHostedPush(environmentId, enabled, requestPermission));
  pendingChanges.set(environmentId, operation);
  void operation
    .finally(() => {
      if (pendingChanges.get(environmentId) === operation) pendingChanges.delete(environmentId);
    })
    .catch(() => {});
  return operation;
}

async function updateSelfHostedPush(
  environmentId: EnvironmentId,
  enabled: boolean,
  requestPermission = true,
) {
  if (!requestPermission) {
    const preferences = await runtime.runPromise(
      Effect.flatMap(MobilePreferences.MobilePreferencesStore, (store) => store.load),
    );
    if (!preferences.selfHostedPushEnvironments?.includes(environmentId)) return;
  }
  if (Platform.OS !== "ios" || !supportsAgentAwarenessPush())
    throw new Error("A push-enabled iOS build is required.");
  if (enabled) {
    const permission = requestPermission
      ? await Notifications.requestPermissionsAsync()
      : await Notifications.getPermissionsAsync();
    if (!permission.granted) throw new Error("Enable notifications in iOS Settings first.");
    const bundleId = Constants.expoConfig?.ios?.bundleIdentifier;
    if (!bundleId) throw new Error("This build has no iOS bundle identifier.");
    const token = await Notifications.getDevicePushTokenAsync();
    if (token.type !== "ios" || typeof token.data !== "string")
      throw new Error("APNs did not return a device token.");
    await execute({
      environmentId,
      action: "register",
      registration: {
        token: token.data,
        bundleId,
        environment: resolveApsEnvironment(Constants.expoConfig?.extra?.appVariant),
      },
    });
  } else {
    await execute({ environmentId, action: "unregister" });
  }
  await runtime.runPromise(
    Effect.flatMap(MobilePreferences.MobilePreferencesStore, (store) =>
      store.update((current) => ({
        selfHostedPushEnvironments: enabled
          ? [...new Set([...(current.selfHostedPushEnvironments ?? []), environmentId])]
          : (current.selfHostedPushEnvironments ?? []).filter((id) => id !== environmentId),
      })),
    ),
  );
}

export function installSelfHostedPushRefresh() {
  let running = false;
  let disposed = false;
  const subscriptions = new Map<string, () => void>();
  const refresh = async () => {
    if (running || disposed || Platform.OS !== "ios") return;
    running = true;
    try {
      const preferences = await runtime.runPromise(
        Effect.flatMap(MobilePreferences.MobilePreferencesStore, (store) => store.load),
      );
      for (const id of preferences.selfHostedPushEnvironments ?? []) {
        if (disposed) break;
        if (!subscriptions.has(id)) {
          subscriptions.set(
            id,
            appAtomRegistry.subscribe(
              environmentSession.preparedConnectionValueAtom(EnvironmentId.make(id)),
              (prepared) => {
                if (Option.isSome(prepared))
                  void setSelfHostedPush(EnvironmentId.make(id), true, false).catch(() => {});
              },
            ),
          );
        }
        try {
          await setSelfHostedPush(EnvironmentId.make(id), true, false);
        } catch {
          /* Retry on the next foreground or token change. */
        }
      }
    } catch {
      /* Protected storage may be unavailable until the phone is unlocked. */
    } finally {
      running = false;
    }
  };
  const appState = AppState.addEventListener("change", (state) => {
    if (state === "active") void refresh();
  });
  const tokens = Notifications.addPushTokenListener(() => {
    void refresh();
  });
  void refresh();
  return () => {
    disposed = true;
    appState.remove();
    tokens.remove();
    for (const stop of subscriptions.values()) stop();
  };
}
