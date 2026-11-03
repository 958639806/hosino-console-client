package com.hosino.console;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(SecureCredentialsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
