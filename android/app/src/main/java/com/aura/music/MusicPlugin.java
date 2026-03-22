package com.aura.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MusicPlayer")
public class MusicPlugin extends Plugin {

    private BroadcastReceiver receiver;

    @Override
    public void load() {
        super.load();
        receiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                String action = intent.getAction();
                if (action == null) return;
                
                android.util.Log.d("MusicPlugin", "Broadcast received: " + action);

                JSObject ret = new JSObject();
                if (action.equals("com.aura.music.SKIP_NEXT") || action.equals("com.aura.music.TRACK_ENDED")) {
                    android.util.Log.d("MusicPlugin", "Notifying nextTrack");
                    notifyListeners("nextTrack", ret);
                } else if (action.equals("com.aura.music.SKIP_PREV")) {
                    android.util.Log.d("MusicPlugin", "Notifying prevTrack");
                    notifyListeners("prevTrack", ret);
                } else if (action.equals(MusicService.ACTION_PLAYBACK_ERROR)) {
                    ret.put("message", intent.getStringExtra("message"));
                    notifyListeners("playbackError", ret);
                } else if (action.equals("com.aura.music.STATUS_UPDATE")) {
                    ret.put("position", intent.getDoubleExtra("position", 0));
                    ret.put("duration", intent.getDoubleExtra("duration", 0));
                    notifyListeners("statusUpdate", ret);
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction("com.aura.music.SKIP_NEXT");
        filter.addAction("com.aura.music.SKIP_PREV");
        filter.addAction("com.aura.music.TRACK_ENDED");
        filter.addAction(MusicService.ACTION_PLAYBACK_ERROR);
        filter.addAction("com.aura.music.STATUS_UPDATE");
        
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(receiver, filter);
        }
    }

    @PluginMethod
    public void play(PluginCall call) {
        String url = call.getString("url");
        String title = call.getString("title", "Aura Music");
        String artist = call.getString("artist", "Unknown Artist");
        String artwork = call.getString("artwork", "");

        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_PLAY);
        intent.putExtra("url", url);
        intent.putExtra("title", title);
        intent.putExtra("artist", artist);
        intent.putExtra("artwork", artwork);

        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_PAUSE);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_RESUME);
        getContext().startService(intent);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double position = call.getDouble("position");
        if (position != null) {
            Intent intent = new Intent(getContext(), MusicService.class);
            intent.setAction(MusicService.ACTION_SEEK);
            intent.putExtra("position", position.longValue() * 1000);
            getContext().startService(intent);
        }
        call.resolve();
    }
}
