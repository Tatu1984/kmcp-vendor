import * as React from "react";
import { Modal, Pressable, StyleSheet, Text, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";

import { Button, Screen } from "./ui";
import { theme } from "../lib/theme";

export interface Capture {
  uri: string;
}

/**
 * Photographing the number plate.
 *
 * This picture is the evidence behind the fare. Months later it is what answers
 * a citizen who says their car was never there, so it is taken at the kerb
 * beside the vehicle and uploaded straight to storage — never edited, never
 * chosen from the gallery.
 *
 * Phase 1 does not read the plate from it. The attendant types the number and
 * the photograph corroborates them; ANPR is a later phase, and pretending to
 * recognise a plate badly would be worse than not trying.
 */
export function PlateCamera({
  visible,
  onCapture,
  onCancel,
}: {
  visible: boolean;
  onCapture: (capture: Capture) => void;
  onCancel: () => void;
}) {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = React.useRef<CameraView>(null);
  const [busy, setBusy] = React.useState(false);

  async function shoot() {
    if (!cameraRef.current || busy) return;
    setBusy(true);
    try {
      // Compressed hard on purpose: this is uploaded from a kerb on mobile
      // data, and a number plate is legible long before a photograph is large.
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.5,
        skipProcessing: true,
      });
      if (photo?.uri) onCapture({ uri: photo.uri });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel}>
      {!permission ? (
        <View style={styles.fill} />
      ) : !permission.granted ? (
        <Screen>
          <Text style={styles.title}>Camera access needed</Text>
          <Text style={styles.body}>
            The photograph of the number plate is the evidence behind the fare. Without it a disputed
            session cannot be answered.
          </Text>
          <Button label="Allow camera" onPress={() => void requestPermission()} />
          <Button label="Not now" variant="secondary" onPress={onCancel} />
        </Screen>
      ) : (
        <View style={styles.fill}>
          {/* The reticle sits beside the camera, not inside it: `CameraView`
              renders no children (expo-camera 57 warns and may crash), so the
              overlay is a sibling laid over the same box. */}
          <View style={styles.preview}>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing="back" />
            <View style={styles.overlay} pointerEvents="none">
              <Text style={styles.hint}>Frame the number plate</Text>
              <View style={styles.reticle} />
            </View>
          </View>

          <View style={styles.controls}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Cancel"
              onPress={onCancel}
              style={styles.cancel}
            >
              <Text style={styles.cancelLabel}>Cancel</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take photograph"
              onPress={() => void shoot()}
              disabled={busy}
              style={({ pressed }) => [styles.shutter, pressed && styles.shutterPressed]}
            >
              <View style={styles.shutterInner} />
            </Pressable>

            <View style={styles.cancel} />
          </View>
        </View>
      )}
    </Modal>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, backgroundColor: "#000" },
  preview: { flex: 1, backgroundColor: "#000" },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(2),
  },
  hint: {
    ...theme.text.body,
    color: "#FFF",
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: theme.space(1.5),
    paddingVertical: theme.space(0.75),
    borderRadius: theme.radius.sm,
  },
  reticle: {
    width: "82%",
    aspectRatio: 4,
    borderWidth: 3,
    borderColor: "rgba(255,255,255,0.9)",
    borderRadius: theme.radius.md,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(3),
    backgroundColor: "#000",
  },
  cancel: { width: 90, minHeight: theme.minTouch, justifyContent: "center" },
  cancelLabel: { ...theme.text.body, color: "#FFF" },
  shutter: {
    width: 78,
    height: 78,
    borderRadius: 39,
    borderWidth: 4,
    borderColor: "#FFF",
    alignItems: "center",
    justifyContent: "center",
  },
  shutterPressed: { opacity: 0.7 },
  shutterInner: { width: 60, height: 60, borderRadius: 30, backgroundColor: "#FFF" },
  title: { ...theme.text.title, color: theme.colour.text },
  body: { ...theme.text.body, color: theme.colour.textMuted },
});
