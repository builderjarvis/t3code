import { useEffect, useState } from "react";
import { Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Dialog from "../../components/ui/Dialog";
import { AppText as Text } from "../../components/ui/AppText";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { selfHostedPushStatus, setSelfHostedPush } from "../agent-awareness/selfHostedPush";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

function EnvironmentPushRow({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string;
}) {
  const [status, setStatus] = useState<{ configured: boolean; registered: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Read the environment's registration when this settings row mounts.
  useEffect(() => {
    let cancelled = false;
    void selfHostedPushStatus(environmentId).then(
      (value) => {
        if (!cancelled) setStatus(value);
      },
      () => {
        if (!cancelled) setError("Connect to an updated environment to configure push");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [environmentId]);
  const change = async (enabled: boolean) => {
    setBusy(true);
    try {
      await setSelfHostedPush(environmentId, enabled);
      setStatus({ configured: true, registered: enabled });
      setError(null);
    } catch (cause) {
      Dialog.alert(
        "Couldn't update notifications",
        cause instanceof Error ? cause.message : "Please try again.",
      );
    }
    setBusy(false);
  };
  return (
    <SettingsSwitchRow
      icon="bell.badge"
      label={label}
      value={status?.registered === true}
      disabled={busy || status?.configured !== true}
      subtitle={
        error ??
        (status === null
          ? "Checking…"
          : status.configured
            ? "Direct APNs · no T3 Connect"
            : "Configure APNs on this environment first")
      }
      onValueChange={(enabled) => {
        void change(enabled);
      }}
    />
  );
}

export function SelfHostedPushSettings() {
  const { savedConnectionsById } = useSavedRemoteConnections();
  if (Platform.OS !== "ios") return null;
  return (
    <SettingsSection title="Self-hosted notifications">
      <Text className="text-sm text-foreground-muted">
        Receive agent alerts through your environment’s APNs credentials. Requires your own signed
        iOS build. Live Activities still use T3 Connect.
      </Text>
      {Object.values(savedConnectionsById).map((connection) => (
        <EnvironmentPushRow
          key={connection.environmentId}
          environmentId={connection.environmentId}
          label={connection.environmentLabel}
        />
      ))}
    </SettingsSection>
  );
}
