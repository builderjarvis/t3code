// @effect-diagnostics-next-line nodeBuiltinImport:off -- APNs requires ES256 signing with IEEE P1363 encoding.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

export interface ApnsConfiguration {
  readonly teamId: string;
  readonly keyId: string;
  readonly bundleId: string;
  readonly privateKey: NodeCrypto.KeyObject;
}

export function createApnsSender(config: ApnsConfiguration) {
  let cachedJwt = "";
  let issuedAt = 0;
  return async (token: string, environment: "sandbox" | "production", payload: unknown) => {
    // @effect-diagnostics-next-line globalDate:off -- This native HTTP2 adapter owns its JWT cache.
    const now = Math.floor(Date.now() / 1000);
    if (!cachedJwt || now - issuedAt >= 3000 || now < issuedAt) {
      const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: config.keyId })).toString(
        "base64url",
      );
      const claims = Buffer.from(JSON.stringify({ iss: config.teamId, iat: now })).toString(
        "base64url",
      );
      const input = `${header}.${claims}`;
      const signature = NodeCrypto.sign("sha256", Buffer.from(input), {
        key: config.privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url");
      cachedJwt = `${input}.${signature}`;
      issuedAt = now;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body) > 4096) throw new Error("APNs payload exceeds 4096 bytes");
    return new Promise<{ status: number; reason: string }>((resolve, reject) => {
      const client = NodeHttp2.connect(
        environment === "production"
          ? "https://api.push.apple.com"
          : "https://api.sandbox.push.apple.com",
      );
      // @effect-diagnostics-next-line globalTimers:off -- Bound native HTTP2 connection and response lifetime.
      const timer = setTimeout(() => finish(new Error("APNs request timed out")), 10_000);
      let done = false;
      const finish = (error?: Error, result?: { status: number; reason: string }) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        client.destroy();
        if (error) reject(error);
        else resolve(result!);
      };
      client.on("error", (error) => finish(error));
      const request = client.request({
        ":method": "POST",
        ":path": `/3/device/${token}`,
        authorization: `bearer ${cachedJwt}`,
        "apns-topic": config.bundleId,
        "apns-push-type": "alert",
        "apns-priority": "10",
        "apns-expiration": String(now + 300),
        "content-type": "application/json",
      });
      let status = 0;
      let response = "";
      request.setEncoding("utf8");
      request.on("response", (headers) => {
        status = Number(headers[":status"]);
      });
      request.on("data", (chunk: string) => {
        response = (response + chunk).slice(0, 4096);
      });
      request.on("error", (error) => finish(error));
      request.on("end", () => {
        let reason = "";
        try {
          const value: unknown = JSON.parse(response);
          if (
            value &&
            typeof value === "object" &&
            "reason" in value &&
            typeof value.reason === "string"
          )
            reason = value.reason;
        } catch {
          /* APNs success has an empty body. */
        }
        finish(undefined, { status, reason });
      });
      request.end(body);
    });
  };
}
