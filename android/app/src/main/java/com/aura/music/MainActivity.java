package com.aura.music;

import android.os.Bundle;
import android.os.SystemClock;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        SplashScreen splashScreen = SplashScreen.installSplashScreen(this);
        final long startTime = SystemClock.elapsedRealtime();
        splashScreen.setKeepOnScreenCondition(() ->
            SystemClock.elapsedRealtime() - startTime < 1200
        );
        registerPlugin(MusicPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
