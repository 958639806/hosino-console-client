package com.hosino.console;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** App-private encrypted token storage. The wrapping key never leaves Android Keystore. */
@CapacitorPlugin(name = "SecureCredentials")
public class SecureCredentialsPlugin extends Plugin {
    private static final String ALIAS = "hosino.console.credentials.v1";
    private static final String PREFS = "hosino_secure_credentials";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private String key(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !key.matches("[a-zA-Z0-9._:-]{1,200}")) {
            call.reject("凭据存储键无效", "INVALID_KEY");
            return null;
        }
        return key;
    }

    private synchronized SecretKey secret() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        if (store.containsAlias(ALIAS)) return (SecretKey) store.getKey(ALIAS, null);
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build());
        return generator.generateKey();
    }

    @PluginMethod
    public void set(PluginCall call) {
        String key = key(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.length() > 32768) {
            call.reject("凭据数据无效", "INVALID_VALUE");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, secret());
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            byte[] encrypted = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            String stored = Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + "." + Base64.encodeToString(encrypted, Base64.NO_WRAP);
            if (!prefs().edit().putString(key, stored).commit()) throw new IllegalStateException();
            call.resolve();
        } catch (Exception error) {
            call.reject("Android 安全存储写入失败", "SECURE_STORAGE_FAILED");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String key = key(call);
        if (key == null) return;
        String stored = prefs().getString(key, null);
        JSObject result = new JSObject();
        if (stored == null) {
            result.put("value", JSObject.NULL);
            call.resolve(result);
            return;
        }
        try {
            String[] parts = stored.split("\\.", 2);
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, secret(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
            cipher.updateAAD(key.getBytes(StandardCharsets.UTF_8));
            result.put("value", new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8));
            call.resolve(result);
        } catch (Exception error) {
            call.reject("Android 安全凭据不可读取，请重新登录", "SECURE_STORAGE_UNAVAILABLE");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String key = key(call);
        if (key == null) return;
        if (!prefs().edit().remove(key).commit()) {
            call.reject("Android 安全凭据清理失败", "SECURE_STORAGE_FAILED");
            return;
        }
        call.resolve();
    }
}
