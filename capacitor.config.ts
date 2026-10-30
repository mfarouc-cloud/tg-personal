import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "com.farouk.tgpersonal",
  appName: "تيليجرام",
  webDir: "dist",
  ios: {
    contentInset: "never",
    backgroundColor: "#0e1621",
    scheme: "tgpersonal",
    limitsNavigationsToAppBoundDomains: false,
  },
};

export default config;
