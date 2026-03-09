package com.aura.music;

import android.content.Intent;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;

@CapacitorPlugin(name = "MusicPlayer")
public class MusicPlugin extends Plugin {

    @Override
    public void load() {
        super.load();
    }

    public void play(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Aura Music");
        String artist = call.getString("artist", "Unknown Artist");

        if (url == null) {
            call.reject("URL is required");
            return;
        }

        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        call.resolve();
    }

    public void pause(PluginCall call) {
        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_PAUSE);
        getContext().startService(intent);
        call.resolve();
    }
}
