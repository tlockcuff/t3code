import type { RelayDeviceRegistrationRequest } from "@t3tools/contracts/relay";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { ApnsEnvironment } from "./ApnsConfig.ts";

// Raw SQLite row: boolean columns come back as 0/1 integers (repo convention —
// see ProjectionThreadMessages). Mapped to a boolean-typed PushDevice below.
const PushDeviceRawRow = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  pushToken: Schema.String,
  bundleId: Schema.NullOr(Schema.String),
  apsEnvironment: ApnsEnvironment,
  appVersion: Schema.NullOr(Schema.String),
  iosMajorVersion: Schema.Number,
  notificationsEnabled: Schema.Number,
  notifyOnApproval: Schema.Number,
  notifyOnInput: Schema.Number,
  notifyOnCompletion: Schema.Number,
  notifyOnFailure: Schema.Number,
  updatedAt: Schema.String,
});

// A registered device eligible to receive alert pushes, with booleans decoded.
export interface PushDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly pushToken: string;
  readonly bundleId: string | null;
  readonly apsEnvironment: ApnsEnvironment;
  readonly appVersion: string | null;
  readonly iosMajorVersion: number;
  readonly notificationsEnabled: boolean;
  readonly notifyOnApproval: boolean;
  readonly notifyOnInput: boolean;
  readonly notifyOnCompletion: boolean;
  readonly notifyOnFailure: boolean;
  readonly updatedAt: string;
}

function toPushDevice(row: typeof PushDeviceRawRow.Type): PushDevice {
  return {
    deviceId: row.deviceId,
    label: row.label,
    pushToken: row.pushToken,
    bundleId: row.bundleId,
    apsEnvironment: row.apsEnvironment,
    appVersion: row.appVersion,
    iosMajorVersion: row.iosMajorVersion,
    notificationsEnabled: row.notificationsEnabled === 1,
    notifyOnApproval: row.notifyOnApproval === 1,
    notifyOnInput: row.notifyOnInput === 1,
    notifyOnCompletion: row.notifyOnCompletion === 1,
    notifyOnFailure: row.notifyOnFailure === 1,
    updatedAt: row.updatedAt,
  };
}

const UpsertPushDeviceInput = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  pushToken: Schema.String,
  bundleId: Schema.NullOr(Schema.String),
  apsEnvironment: ApnsEnvironment,
  appVersion: Schema.NullOr(Schema.String),
  iosMajorVersion: Schema.Number,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
  updatedAt: Schema.String,
});
type UpsertPushDeviceInput = typeof UpsertPushDeviceInput.Type;

const DeviceIdInput = Schema.Struct({ deviceId: Schema.String });

const b = (value: boolean) => (value ? 1 : 0);

export class DeviceTokenStore extends Context.Service<
  DeviceTokenStore,
  {
    readonly upsert: (input: UpsertPushDeviceInput) => Effect.Effect<void, unknown>;
    readonly remove: (deviceId: string) => Effect.Effect<void, unknown>;
    readonly list: () => Effect.Effect<ReadonlyArray<PushDevice>, unknown>;
  }
>()("t3/push/DeviceTokenStore") {}

// Builds an upsert payload from the mobile registration request. Notification
// preferences flow straight through; a device without a push token is not
// persisted (the caller filters that before invoking upsert).
export function toUpsertInput(input: {
  readonly request: RelayDeviceRegistrationRequest;
  readonly pushToken: string;
  readonly updatedAt: string;
}): UpsertPushDeviceInput {
  return {
    deviceId: input.request.deviceId,
    label: input.request.label,
    pushToken: input.pushToken,
    bundleId: input.request.bundleId ?? null,
    apsEnvironment: input.request.apsEnvironment ?? "production",
    appVersion: input.request.appVersion ?? null,
    iosMajorVersion: input.request.iosMajorVersion,
    notificationsEnabled: input.request.preferences.notificationsEnabled,
    notifyOnApproval: input.request.preferences.notifyOnApproval,
    notifyOnInput: input.request.preferences.notifyOnInput,
    notifyOnCompletion: input.request.preferences.notifyOnCompletion,
    notifyOnFailure: input.request.preferences.notifyOnFailure,
    updatedAt: input.updatedAt,
  };
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertPushDeviceInput,
    execute: (input) =>
      sql`
        INSERT INTO push_devices (
          device_id,
          label,
          push_token,
          bundle_id,
          aps_environment,
          app_version,
          ios_major_version,
          notifications_enabled,
          notify_on_approval,
          notify_on_input,
          notify_on_completion,
          notify_on_failure,
          updated_at
        )
        VALUES (
          ${input.deviceId},
          ${input.label},
          ${input.pushToken},
          ${input.bundleId},
          ${input.apsEnvironment},
          ${input.appVersion},
          ${input.iosMajorVersion},
          ${b(input.notificationsEnabled)},
          ${b(input.notifyOnApproval)},
          ${b(input.notifyOnInput)},
          ${b(input.notifyOnCompletion)},
          ${b(input.notifyOnFailure)},
          ${input.updatedAt}
        )
        ON CONFLICT(device_id) DO UPDATE SET
          label = excluded.label,
          push_token = excluded.push_token,
          bundle_id = excluded.bundle_id,
          aps_environment = excluded.aps_environment,
          app_version = excluded.app_version,
          ios_major_version = excluded.ios_major_version,
          notifications_enabled = excluded.notifications_enabled,
          notify_on_approval = excluded.notify_on_approval,
          notify_on_input = excluded.notify_on_input,
          notify_on_completion = excluded.notify_on_completion,
          notify_on_failure = excluded.notify_on_failure,
          updated_at = excluded.updated_at
      `,
  });

  const deleteRow = SqlSchema.void({
    Request: DeviceIdInput,
    execute: ({ deviceId }) => sql`DELETE FROM push_devices WHERE device_id = ${deviceId}`,
  });

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PushDeviceRawRow,
    execute: () =>
      sql`
        SELECT
          device_id AS "deviceId",
          label AS "label",
          push_token AS "pushToken",
          bundle_id AS "bundleId",
          aps_environment AS "apsEnvironment",
          app_version AS "appVersion",
          ios_major_version AS "iosMajorVersion",
          notifications_enabled AS "notificationsEnabled",
          notify_on_approval AS "notifyOnApproval",
          notify_on_input AS "notifyOnInput",
          notify_on_completion AS "notifyOnCompletion",
          notify_on_failure AS "notifyOnFailure",
          updated_at AS "updatedAt"
        FROM push_devices
      `,
  });

  return DeviceTokenStore.of({
    upsert: (input) => upsertRow(input),
    remove: (deviceId) => deleteRow({ deviceId }),
    list: () => listRows(undefined).pipe(Effect.map((rows) => rows.map(toPushDevice))),
  });
});

export const layer = Layer.effect(DeviceTokenStore, make);
