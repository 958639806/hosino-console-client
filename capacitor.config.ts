import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.hosino.console',
  appName: 'Hosino Console',
  webDir: 'dist',
  android: { allowMixedContent: false, minWebViewVersion: 105 },
  server: { androidScheme: 'https', cleartext: false, errorPath: 'webview-error.html' },
  plugins: { CapacitorHttp: { enabled: false } },
};

export default config;
