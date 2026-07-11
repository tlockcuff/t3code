#!/usr/bin/env node
// Sends a single test APNs alert push, using the same .p8/env config the server
// reads. Two ways to pick the target device token:
//   1. Pass it explicitly:   node scripts/send-test-push.mjs <hexToken>
//   2. Omit it to auto-read the most-recently-registered token from the server
//      DB (T3CODE_DB or the default userdata/state.sqlite).
//
// Reads APNS_TEAM_ID, APNS_KEY_ID, APNS_BUNDLE_ID, APNS_ENVIRONMENT,
// APNS_PRIVATE_KEY_PATH from the environment (load .env.local first, e.g.
//   set -a; source .env.local; set +a; node scripts/send-test-push.mjs
// ). The bundle id must match the device's build; environment must match the
// token (sandbox for dev/Xcode builds).

import * as NodeCrypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { connect } from "node:http2";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var ${name}. Did you source .env.local?`);
    process.exit(1);
  }
  return value;
}

const teamId = required("APNS_TEAM_ID");
const keyId = required("APNS_KEY_ID");
const bundleId = required("APNS_BUNDLE_ID");
const environment = (process.env.APNS_ENVIRONMENT ?? "sandbox").trim();
const keyPath = required("APNS_PRIVATE_KEY_PATH");

function resolveToken() {
  const explicit = process.argv[2]?.trim();
  if (explicit) {
    return { token: explicit, bundleId, environment, source: "argv" };
  }
  // Fall back to the newest registered device in the server DB.
  const dbPath = process.env.T3CODE_DB?.trim() || `${process.env.HOME}/.t3/userdata/state.sqlite`;
  let row = "";
  try {
    row = execFileSync("sqlite3", [
      dbPath,
      "-separator",
      "\t",
      "SELECT push_token, bundle_id, aps_environment FROM push_devices ORDER BY updated_at DESC LIMIT 1;",
    ])
      .toString()
      .trim();
  } catch (err) {
    const message = String(err?.stderr ?? err?.message ?? err);
    if (message.includes("no such table")) {
      console.error(
        `No push_devices table in ${dbPath}. The running server predates the push code — rebuild/restart it, register a device from the app, then retry.`,
      );
    } else {
      console.error(`Could not read ${dbPath}: ${message}`);
    }
    process.exit(1);
  }
  if (!row) {
    console.error(
      `No registered devices in ${dbPath}. Register a device from the app first, or pass a token argument.`,
    );
    process.exit(1);
  }
  const [token, rowBundleId, rowEnv] = row.split("\t");
  return {
    token,
    bundleId: rowBundleId || bundleId,
    environment: rowEnv || environment,
    source: dbPath,
  };
}

function makeProviderJwt() {
  const pem = readFileSync(keyPath, "utf8");
  const iat = Math.floor(Date.now() / 1000);
  const b64url = (buf) => Buffer.from(buf).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const payload = b64url(JSON.stringify({ iss: teamId, iat }));
  const signingInput = `${header}.${payload}`;
  const sig = NodeCrypto.sign("SHA256", Buffer.from(signingInput, "utf8"), {
    key: NodeCrypto.createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${b64url(sig)}`;
}

async function main() {
  const target = resolveToken();
  const jwt = makeProviderJwt();
  const host =
    target.environment === "production"
      ? "https://api.push.apple.com"
      : "https://api.sandbox.push.apple.com";

  const body = JSON.stringify({
    aps: {
      alert: { title: "T3 Code test push", body: "If you see this, APNs works 🎉" },
      sound: "default",
    },
    environmentId: "test",
    threadId: "test",
    deepLink: "/",
  });

  console.log(`→ ${host}/3/device/${target.token.slice(0, 8)}…`);
  console.log(`  topic=${target.bundleId} env=${target.environment} tokenSource=${target.source}`);

  const client = connect(host);
  client.on("error", (err) => {
    console.error("connection error:", err);
    process.exit(1);
  });

  const req = client.request({
    ":method": "POST",
    ":path": `/3/device/${target.token}`,
    authorization: `bearer ${jwt}`,
    "apns-topic": target.bundleId,
    "apns-push-type": "alert",
    "apns-priority": "10",
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });

  let status = 0;
  let apnsId = null;
  let responseBody = "";
  req.on("response", (headers) => {
    status = headers[":status"];
    apnsId = headers["apns-id"] ?? null;
  });
  req.setEncoding("utf8");
  req.on("data", (chunk) => (responseBody += chunk));
  req.on("end", () => {
    client.close();
    if (status === 200) {
      console.log(`✅ delivered (apns-id=${apnsId})`);
    } else {
      console.error(`❌ status ${status} apns-id=${apnsId}`);
      console.error(`   body: ${responseBody || "(empty)"}`);
      if (responseBody.includes("BadDeviceToken")) {
        console.error(
          "   → token/environment mismatch: a sandbox token must hit the sandbox host with the dev bundle id (and vice versa).",
        );
      }
      process.exit(1);
    }
  });
  req.write(body);
  req.end();
}

main();
