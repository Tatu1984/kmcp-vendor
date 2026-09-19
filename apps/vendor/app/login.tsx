import * as React from "react";
import { KeyboardAvoidingView, Platform, StyleSheet, Text, View } from "react-native";
import { Redirect } from "expo-router";
import { ApiError } from "@kmcp/api";

import { Banner, Button, Field, Screen } from "../components/ui";
import { useSession } from "../lib/session";
import { getDeviceId } from "../lib/api";
import { theme } from "../lib/theme";

/**
 * Sign-in for an attendant.
 *
 * By mobile number, not email: an attendant has a phone and often no work email
 * at all. The account is bound to this handset, so the first sign-in on a new
 * device is refused until an administrator releases the binding — which is what
 * stops one login being passed around a depot.
 *
 * Two steps on one screen when the account has an authenticator enrolled. The
 * password form gives way to a single six-digit field rather than a second
 * screen, because the number and password are still the context for the code
 * and a stack push would lose them on the way back.
 */
export default function Login() {
  const { user, signIn, verifyTwoFactor } = useSession();
  const [phone, setPhone] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  /** Set once the password was accepted and the server wants a code too. */
  const [challengeId, setChallengeId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  if (user) return <Redirect href="/(tabs)" />;

  const canSubmit = phone.length === 10 && password.length >= 6 && !busy;
  const canVerify = /^\d{6}$/.test(code) && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await signIn(phone.trim(), password);
      if (result.status === "two_factor_required") {
        setChallengeId(result.challengeId);
        setCode("");
        setBusy(false);
      }
      // On "ok" the provider sets `user` and the redirect above takes over;
      // leaving `busy` set stops the button flashing enabled in between.
    } catch (cause) {
      setError(describe(cause, "password"));
      setBusy(false);
    }
  }

  async function verify() {
    if (!challengeId) return;
    setBusy(true);
    setError(null);
    try {
      await verifyTwoFactor(challengeId, code);
    } catch (cause) {
      setError(describe(cause, "code"));
      setBusy(false);
    }
  }

  function startOver() {
    setChallengeId(null);
    setCode("");
    setPassword("");
    setError(null);
  }

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <Screen>
        <View style={styles.header}>
          <Text style={styles.brand}>KMCP</Text>
          <Text style={styles.title}>Attendant sign-in</Text>
          <Text style={styles.subtitle}>
            Kolkata Municipal Corporation Parking
          </Text>
        </View>

        {error ? <Banner tone="danger" title={error} /> : null}

        {challengeId === null ? (
          <>
            <Field
              label="Mobile number"
              value={phone}
              /**
               * Whatever shape it arrives in, it leaves as ten digits.
               *
               * The pad offers a `+`, so people type `+919433361718` — and the
               * old field simply stopped accepting characters at ten, turning
               * that into `+91943336` with no indication anything had been
               * dropped. Now punctuation and country codes are taken off
               * instead of the end of the number: anything longer than ten
               * digits keeps its last ten, which is the local number in every
               * form this gets typed or pasted in.
               */
              onChangeText={(next) => {
                let local = next.replace(/\D/g, "");
                /**
                 * Peel off whatever stands in front of the ten-digit number —
                 * a `91` country code, the `0` people still prefix out of STD
                 * habit, or both from a `0091…`. Only ever while the string is
                 * too long to be local, because an Indian mobile can itself
                 * begin `91` (9123456789) and must not lose its own first two
                 * digits.
                 */
                while (local.length > 10 && (local.startsWith("91") || local.startsWith("0"))) {
                  local = local.startsWith("91") ? local.slice(2) : local.slice(1);
                }
                setPhone(local.slice(0, 10));
              }}
              keyboardType="phone-pad"
              autoComplete="tel"
              textContentType="telephoneNumber"
              placeholder="98XXXXXXXX"
              // Room to type or paste a +91 before it is stripped above; the
              // value itself never exceeds ten digits.
              maxLength={16}
              hint="Ten digits — +91 is added for you."
              editable={!busy}
            />

            <Field
              label="Password"
              value={password}
              onChangeText={setPassword}
              secureTextEntry
              autoComplete="current-password"
              textContentType="password"
              placeholder="••••••••"
              editable={!busy}
              onSubmitEditing={() => canSubmit && void submit()}
              returnKeyType="go"
            />

            <Button label="Sign in" onPress={() => void submit()} disabled={!canSubmit} busy={busy} />
          </>
        ) : (
          <>
            <Field
              label="Authenticator code"
              value={code}
              onChangeText={(next) => setCode(next.replace(/\D/g, "").slice(0, 6))}
              keyboardType="number-pad"
              autoComplete="one-time-code"
              textContentType="oneTimeCode"
              placeholder="000000"
              maxLength={6}
              editable={!busy}
              autoFocus
              style={styles.codeInput}
              onSubmitEditing={() => canVerify && void verify()}
              returnKeyType="go"
              hint={`Password accepted for ${phone.trim()}. Enter the six digits from your authenticator app.`}
            />

            <Button
              label="Verify and sign in"
              onPress={() => void verify()}
              disabled={!canVerify}
              busy={busy}
            />

            <Button
              label="Different number"
              variant="secondary"
              size="medium"
              onPress={startOver}
              disabled={busy}
            />
          </>
        )}

        <View style={styles.footer}>
          <Text style={styles.footnote}>
            This handset is registered as {getDeviceId().slice(0, 18) || "unknown"}…
          </Text>
          <Text style={styles.footnote}>
            Your account is bound to this device. If you have changed phones, ask your supervisor to
            release the old one.
          </Text>
        </View>
      </Screen>
    </KeyboardAvoidingView>
  );
}

/**
 * The one line to show for a failed attempt.
 *
 * Branches on `code`, never on `message`, because the server may reword a
 * message at any time. `DEVICE_NOT_BOUND` gets its own words: the password was
 * right and the account is fine, it is this phone that is not the one on
 * record, and the only fix is a supervisor — none of which "those details are
 * not correct" would tell anybody.
 */
function describe(cause: unknown, step: "password" | "code"): string {
  if (!(cause instanceof ApiError)) {
    return cause instanceof Error && cause.message
      ? cause.message
      : "Could not reach the server. Check your connection and try again.";
  }
  if (cause.code === "DEVICE_NOT_BOUND") {
    return "This account is bound to another phone. Ask your supervisor to release it before signing in here.";
  }
  if (cause.isAuthError) {
    return step === "password"
      ? "That mobile number and password did not match."
      : "That code did not match. Check your authenticator app and try again.";
  }
  return cause.message;
}

const styles = StyleSheet.create({
  flex: { flex: 1, backgroundColor: theme.colour.bg },
  header: { gap: theme.space(0.5), paddingVertical: theme.space(4) },
  brand: {
    ...theme.text.label,
    color: theme.colour.primary,
    fontSize: 15,
    letterSpacing: 2,
  },
  title: { ...theme.text.display, color: theme.colour.text },
  subtitle: { ...theme.text.body, color: theme.colour.textMuted },
  codeInput: { fontSize: 30, fontWeight: "700", letterSpacing: 10, textAlign: "center" },
  footer: { marginTop: "auto", gap: theme.space(1), paddingTop: theme.space(3) },
  footnote: { ...theme.text.small, color: theme.colour.textMuted },
});
