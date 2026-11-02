import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { requireEnvironmentScope, failEnvironmentInternal } from "../auth/http.ts";
import * as SelfHostedPush from "./SelfHostedPush.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "push",
  Effect.fnUntraced(function* (handlers) {
    const push = yield* SelfHostedPush.SelfHostedPush;
    return handlers
      .handle(
        "status",
        Effect.fn("push.http.status")(function* () {
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          return yield* push
            .status(session.sessionId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "register",
        Effect.fn("push.http.register")(function* ({ payload }) {
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* push
            .register(session.sessionId, payload)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      )
      .handle(
        "unregister",
        Effect.fn("push.http.unregister")(function* () {
          const session = yield* requireEnvironmentScope(AuthOrchestrationReadScope);
          yield* push
            .unregister(session.sessionId)
            .pipe(Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)));
        }),
      );
  }),
);
