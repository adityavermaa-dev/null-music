package com.aura.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.audiofx.Equalizer;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import com.getcapacitor.JSObject;
import com.google.android.exoplayer2.ExoPlayer;
import com.google.android.exoplayer2.MediaItem;
import com.google.android.exoplayer2.PlaybackException;
import com.google.android.exoplayer2.Player;
import com.google.android.exoplayer2.source.DefaultMediaSourceFactory;
import com.google.android.exoplayer2.upstream.DefaultHttpDataSource;
import com.google.android.exoplayer2.util.MimeTypes;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

public class MusicService extends Service {

    public static final String ACTION_PLAY = "com.aura.music.ACTION_PLAY";
    public static final String ACTION_PAUSE = "com.aura.music.ACTION_PAUSE";
    public static final String ACTION_RESUME = "com.aura.music.ACTION_RESUME";
    public static final String ACTION_NEXT = "com.aura.music.ACTION_NEXT";
    public static final String ACTION_PREV = "com.aura.music.ACTION_PREV";
    public static final String ACTION_SEEK = "com.aura.music.ACTION_SEEK";
    public static final String ACTION_SET_QUEUE = "com.aura.music.ACTION_SET_QUEUE";

    public static final String ACTION_PLAYBACK_ERROR = "com.aura.music.PLAYBACK_ERROR";
    
    private static final String CHANNEL_ID = "MusicPlaybackChannel";
    private static final int NOTIFICATION_ID = 1;
    private static final String WIDGET_EMPTY_TITLE = "Aura Music";
    private static final String WIDGET_EMPTY_ARTIST = "Play something you like";

    private static final String HTTP_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";
    private static MusicService instance;
    private static boolean desiredEqualizerEnabled = false;
    private static int desiredEqualizerPreset = 0;

    private ExoPlayer player;
    private MediaSessionCompat mediaSession;
    private String currentTitle = "Aura Music";
    private String currentArtist = "Unknown Artist";
    private String currentArtwork = "";

    /* ── Native track queue for background autoplay ── */
    private final ArrayList<QueueItem> trackQueue = new ArrayList<>();
    private int currentQueueIndex = -1;
    private int queueOffset = 0;
    private Equalizer equalizer;

    /* ── Audio focus ── */
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean playOnFocusGain = false;

    private final AudioManager.OnAudioFocusChangeListener focusChangeListener = focusChange -> {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS:
                // Permanent loss — another app took focus
                if (player != null) player.pause();
                playOnFocusGain = false;
                updateNotification();
                updatePlaybackState();
                sendExplicitBroadcast("com.aura.music.STATUS_UPDATE_PAUSED");
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
                // Temporary loss — phone call, notification sound, etc.
                if (player != null && player.isPlaying()) {
                    player.pause();
                    playOnFocusGain = true;
                    updateNotification();
                    updatePlaybackState();
                }
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                // Can duck — lower volume briefly
                if (player != null) player.setVolume(0.3f);
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                // Regained focus
                if (player != null) {
                    player.setVolume(1.0f);
                    if (playOnFocusGain) {
                        player.play();
                        playOnFocusGain = false;
                        updateNotification();
                        updatePlaybackState();
                    }
                }
                break;
        }
    };

    private final Handler handler = new Handler();
    private final Runnable statusRunnable = new Runnable() {
        @Override
        public void run() {
            if (player != null && player.isPlaying()) {
                Intent intent = new Intent("com.aura.music.STATUS_UPDATE");
                intent.putExtra("position", (double) player.getCurrentPosition() / 1000.0);
                long duration = player.getDuration();
                intent.putExtra("duration", duration > 0 ? (double) duration / 1000.0 : 0.0);
                sendExplicitBroadcast(intent);
            }
            handler.postDelayed(this, 1000);
        }
    };

    private void sendExplicitBroadcast(Intent intent) {
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
    }

    private void sendExplicitBroadcast(String action) {
        Intent intent = new Intent(action);
        intent.setPackage(getPackageName());
        sendBroadcast(intent);
    }

    @Override
    public void onCreate() {
        super.onCreate();
        instance = this;
        createNotificationChannel();

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        DefaultHttpDataSource.Factory httpFactory = new DefaultHttpDataSource.Factory()
            .setUserAgent(HTTP_UA)
            .setAllowCrossProtocolRedirects(true);

        // Set audio attributes for media playback
        com.google.android.exoplayer2.audio.AudioAttributes exoAudioAttributes =
            new com.google.android.exoplayer2.audio.AudioAttributes.Builder()
                .setUsage(com.google.android.exoplayer2.C.USAGE_MEDIA)
                .setContentType(com.google.android.exoplayer2.C.AUDIO_CONTENT_TYPE_MUSIC)
                .build();

        player = new ExoPlayer.Builder(this)
            .setMediaSourceFactory(new DefaultMediaSourceFactory(this).setDataSourceFactory(httpFactory))
            .build();
        player.setAudioAttributes(exoAudioAttributes, false); // false = we manage audio focus ourselves
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (isPlaying) {
                    ensureEqualizerReady();
                }
                updateNotification();
                updatePlaybackState();
            }

            @Override
            public void onAudioSessionIdChanged(int audioSessionId) {
                configureEqualizer(audioSessionId);
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    // Try to play next track from native queue first (background autoplay)
                    if (!playNextFromQueue()) {
                        // No more tracks in queue — notify JS
                        sendExplicitBroadcast("com.aura.music.TRACK_ENDED");
                    }
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                android.util.Log.e("MusicService", "Playback error", error);
                if (playNextFromQueue()) {
                    updateNotification();
                    updatePlaybackState();
                    return;
                }
                Intent intent = new Intent(ACTION_PLAYBACK_ERROR);
                intent.putExtra("message", error != null ? error.getMessage() : "Playback failed");
                sendExplicitBroadcast(intent);
                updateNotification();
                updatePlaybackState();
            }
        });

        mediaSession = new MediaSessionCompat(this, "AuraMusicSession");
        mediaSession.setFlags(
            MediaSessionCompat.FLAG_HANDLES_MEDIA_BUTTONS |
            MediaSessionCompat.FLAG_HANDLES_TRANSPORT_CONTROLS
        );
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                requestAudioFocusAndPlay();
            }
            @Override
            public void onPause() {
                player.pause();
                updateNotification();
                updatePlaybackState();
            }
            @Override
            public void onSkipToNext() { handleSkipNext(); }
            @Override
            public void onSkipToPrevious() { handleSkipPrev(); }
            @Override
            public void onSeekTo(long pos) { player.seekTo(pos); }
        });
        mediaSession.setActive(true);
        handler.post(statusRunnable);
    }

    public static JSObject getEqualizerStateSnapshot() {
        MusicService service = instance;
        if (service != null) {
            service.ensureEqualizerReady();
            return service.buildEqualizerState();
        }

        JSObject ret = new JSObject();
        ret.put("available", false);
        ret.put("enabled", desiredEqualizerEnabled);
        ret.put("currentPreset", desiredEqualizerPreset);
        ret.put("presets", new JSONArray());
        ret.put("message", "Start playback on Android to use the equalizer.");
        return ret;
    }

    public static void setEqualizerEnabledStatic(boolean enabled) {
        desiredEqualizerEnabled = enabled;
        MusicService service = instance;
        if (service != null) {
            service.ensureEqualizerReady();
            service.applyEqualizerState();
        }
    }

    public static void setEqualizerPresetStatic(int preset) {
        desiredEqualizerPreset = Math.max(0, preset);
        MusicService service = instance;
        if (service != null) {
            service.ensureEqualizerReady();
            service.applyEqualizerState();
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && intent.getAction() != null) {
            String action = intent.getAction();
            android.util.Log.d("MusicService", "Action received: " + action);
            switch (action) {
                case ACTION_PLAY:
                    currentTitle = intent.getStringExtra("title");
                    currentArtist = intent.getStringExtra("artist");
                    currentArtwork = intent.getStringExtra("artwork") != null ? intent.getStringExtra("artwork") : "";
                    playTrack(intent.getStringExtra("url"));
                    break;
                case ACTION_PAUSE:
                    player.pause();
                    updateNotification();
                    updatePlaybackState();
                    break;
                case ACTION_RESUME:
                    requestAudioFocusAndPlay();
                    break;
                case ACTION_NEXT:
                    android.util.Log.d("MusicService", "ACTION_NEXT triggered");
                    handleSkipNext();
                    break;
                case ACTION_PREV:
                    android.util.Log.d("MusicService", "ACTION_PREV triggered");
                    handleSkipPrev();
                    break;
                case ACTION_SEEK:
                    player.seekTo(intent.getLongExtra("position", 0));
                    break;
                case ACTION_SET_QUEUE:
                    handleSetQueue(intent);
                    break;
            }
        }
        startForeground(NOTIFICATION_ID, createNotification());
        return START_STICKY;
    }

    /* ── Audio focus ── */
    private void requestAudioFocusAndPlay() {
        if (audioManager == null) {
            player.play();
            updateNotification();
            updatePlaybackState();
            return;
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (audioFocusRequest == null) {
                AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attrs)
                    .setOnAudioFocusChangeListener(focusChangeListener)
                    .setWillPauseWhenDucked(false)
                    .build();
            }
            int result = audioManager.requestAudioFocus(audioFocusRequest);
            if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                player.play();
                updateNotification();
                updatePlaybackState();
            }
        } else {
            @SuppressWarnings("deprecation")
            int result = audioManager.requestAudioFocus(focusChangeListener,
                AudioManager.STREAM_MUSIC, AudioManager.AUDIOFOCUS_GAIN);
            if (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED) {
                player.play();
                updateNotification();
                updatePlaybackState();
            }
        }
    }

    /* ── Native queue management ── */
    private void handleSetQueue(Intent intent) {
        String json = intent.getStringExtra("queue");
        int index = intent.getIntExtra("currentIndex", -1);
        int offset = intent.getIntExtra("offset", 0);
        if (json == null) return;

        try {
            JSONArray arr = new JSONArray(json);
            trackQueue.clear();
            for (int i = 0; i < arr.length(); i++) {
                JSONObject obj = arr.getJSONObject(i);
                trackQueue.add(new QueueItem(
                    obj.optString("id", ""),
                    obj.optInt("index", offset + i),
                    obj.optString("url", ""),
                    obj.optString("title", "Unknown"),
                    obj.optString("artist", "Unknown"),
                    obj.optString("artwork", "")
                ));
            }
            currentQueueIndex = Math.max(-1, Math.min(index, trackQueue.size() - 1));
            queueOffset = Math.max(0, offset);
            if (currentQueueIndex >= 0 && currentQueueIndex < trackQueue.size()) {
                QueueItem currentItem = trackQueue.get(currentQueueIndex);
                currentTitle = currentItem.title;
                currentArtist = currentItem.artist;
                currentArtwork = currentItem.artwork;
            }
            android.util.Log.d("MusicService", "Queue set: " + trackQueue.size() + " tracks, index=" + index);
            updateNotification();
            updatePlaybackState();
        } catch (Exception e) {
            android.util.Log.e("MusicService", "Failed to parse queue JSON", e);
        }
    }

    private void handleSkipNext() {
        if (playNextFromQueue()) return;
        // Fallback: notify JS to handle (when WebView is active)
        sendExplicitBroadcast("com.aura.music.SKIP_NEXT");
    }

    private void handleSkipPrev() {
        if (playPrevFromQueue()) return;
        // Fallback: notify JS
        sendExplicitBroadcast("com.aura.music.SKIP_PREV");
    }

    private void configureEqualizer(int audioSessionId) {
        releaseEqualizer();

        if (audioSessionId <= 0) {
            return;
        }

        try {
            equalizer = new Equalizer(0, audioSessionId);
            applyEqualizerState();
        } catch (Exception e) {
            android.util.Log.w("MusicService", "Equalizer unavailable", e);
            releaseEqualizer();
        }
    }

    private void ensureEqualizerReady() {
        if (equalizer != null || player == null) {
            return;
        }

        try {
            int audioSessionId = player.getAudioSessionId();
            if (audioSessionId > 0) {
                configureEqualizer(audioSessionId);
            }
        } catch (Exception e) {
            android.util.Log.w("MusicService", "Unable to prepare equalizer", e);
        }
    }

    private void applyEqualizerState() {
        if (equalizer == null) return;

        try {
            short presetCount = equalizer.getNumberOfPresets();
            if (presetCount > 0) {
                short safePreset = (short) Math.max(0, Math.min(desiredEqualizerPreset, presetCount - 1));
                desiredEqualizerPreset = safePreset;
                equalizer.usePreset(safePreset);
            }
            equalizer.setEnabled(desiredEqualizerEnabled);
        } catch (Exception e) {
            android.util.Log.w("MusicService", "Failed to apply equalizer state", e);
        }
    }

    private void releaseEqualizer() {
        if (equalizer != null) {
            try {
                equalizer.release();
            } catch (Exception ignored) {
                // ignore
            }
            equalizer = null;
        }
    }

    private JSObject buildEqualizerState() {
        ensureEqualizerReady();
        JSObject ret = new JSObject();
        JSONArray presets = new JSONArray();
        boolean available = equalizer != null;

        if (equalizer != null) {
            try {
                short presetCount = equalizer.getNumberOfPresets();
                for (short i = 0; i < presetCount; i++) {
                    presets.put(equalizer.getPresetName(i));
                }
            } catch (Exception e) {
                android.util.Log.w("MusicService", "Failed to read equalizer presets", e);
            }
        }

        ret.put("available", available);
        ret.put("enabled", desiredEqualizerEnabled);
        ret.put("currentPreset", desiredEqualizerPreset);
        ret.put("presets", presets);
        if (!available) {
            ret.put("message", player != null && player.isPlaying()
                ? "Equalizer is initializing for the active playback session."
                : "Start playback on Android to use the equalizer.");
        }
        return ret;
    }

    private void broadcastQueueIndexChanged(QueueItem item) {
        Intent syncIntent = new Intent("com.aura.music.QUEUE_INDEX_CHANGED");
        int absoluteIndex = item != null ? item.absoluteIndex : -1;
        if (absoluteIndex < 0) {
            absoluteIndex = queueOffset + currentQueueIndex;
        }
        syncIntent.putExtra("index", absoluteIndex);
        syncIntent.putExtra("trackId", item != null ? item.trackId : "");
        syncIntent.putExtra("title", item != null ? item.title : currentTitle);
        syncIntent.putExtra("artist", item != null ? item.artist : currentArtist);
        syncIntent.putExtra("artwork", item != null ? item.artwork : currentArtwork);
        sendExplicitBroadcast(syncIntent);
    }

    private boolean playFromQueueDirection(int step) {
        int nextIdx = currentQueueIndex;

        while (true) {
            nextIdx += step;
            if (nextIdx < 0 || nextIdx >= trackQueue.size()) {
                return false;
            }

            QueueItem item = trackQueue.get(nextIdx);
            if (item == null || item.url == null || item.url.isEmpty()) {
                continue;
            }

            currentQueueIndex = nextIdx;
            currentTitle = item.title;
            currentArtist = item.artist;
            currentArtwork = item.artwork;
            playTrack(item.url);
            broadcastQueueIndexChanged(item);
            return true;
        }
    }

    private boolean playNextFromQueue() {
        return playFromQueueDirection(1);
    }

    private boolean playPrevFromQueue() {
        return playFromQueueDirection(-1);
    }

    private void updatePlaybackState() {
        int state = PlaybackStateCompat.STATE_NONE;
        if (player != null) {
            if (player.isPlaying()) {
                state = PlaybackStateCompat.STATE_PLAYING;
            } else if (player.getPlaybackState() == Player.STATE_BUFFERING) {
                state = PlaybackStateCompat.STATE_BUFFERING;
            } else {
                state = PlaybackStateCompat.STATE_PAUSED;
            }
        }

        long position = player != null ? Math.max(player.getCurrentPosition(), 0L) : 0L;
        float speed = player != null && player.isPlaying() ? 1.0f : 0.0f;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setState(state, position, speed)
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE |
                        PlaybackStateCompat.ACTION_PLAY_PAUSE |
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
                        PlaybackStateCompat.ACTION_SEEK_TO)
                .build());
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, createNotification());
        AuraWidgetProvider.updateAll(this, currentTitle, currentArtist, player != null && player.isPlaying());
    }

    private Notification createNotification() {
        Intent notifyIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, notifyIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        boolean isPlaying = player != null && player.isPlaying();
        
        NotificationCompat.Action playPauseAction = isPlaying ?
                new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause", getServiceIntent(ACTION_PAUSE)) :
                new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play", getServiceIntent(ACTION_RESUME));

        long duration = player != null ? Math.max(player.getDuration(), 0L) : 0L;
        mediaSession.setSessionActivity(pi);
        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
                .putLong(MediaMetadataCompat.METADATA_KEY_DURATION, duration)
                .build());

        return new NotificationCompat.Builder(this, CHANNEL_ID)
                .setContentTitle(currentTitle)
                .setContentText(currentArtist)
                .setSmallIcon(android.R.drawable.ic_media_play)
                .setContentIntent(pi)
                .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_MAX)
                .addAction(android.R.drawable.ic_media_previous, "Prev", getServiceIntent(ACTION_PREV))
                .addAction(playPauseAction)
                .addAction(android.R.drawable.ic_media_next, "Next", getServiceIntent(ACTION_NEXT))
                .setStyle(new MediaStyle()
                        .setMediaSession(mediaSession.getSessionToken())
                        .setShowActionsInCompactView(0, 1, 2))
                .setOnlyAlertOnce(true)
                .setOngoing(isPlaying)
                .build();
    }

    private PendingIntent getServiceIntent(String action) {
        Intent intent = new Intent(this, MusicService.class).setAction(action);
        int requestCode;
        switch(action) {
            case ACTION_PREV: requestCode = 1; break;
            case ACTION_RESUME:
            case ACTION_PAUSE: requestCode = 2; break;
            case ACTION_NEXT: requestCode = 3; break;
            case ACTION_SEEK: requestCode = 4; break;
            default: requestCode = 0; break;
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(this, requestCode, intent, flags);
        }
        return PendingIntent.getService(this, requestCode, intent, flags);
    }

    public void playTrack(String url) {
        android.util.Log.d("MusicService", "playTrack url=" + url);

        MediaItem.Builder builder = new MediaItem.Builder().setUri(url);
        if (url != null) {
            if (url.contains("/api/yt/pipe/")) {
                builder.setMimeType(MimeTypes.AUDIO_WEBM);
            } else if (url.contains("mime=audio%2Fwebm") || url.contains("mime=audio/webm")) {
                builder.setMimeType(MimeTypes.AUDIO_WEBM);
            } else if (url.contains("mime=audio%2Fmp4") || url.contains("mime=audio/mp4")) {
                builder.setMimeType(MimeTypes.AUDIO_MP4);
            }
        }

        MediaItem item = builder.build();
        player.setMediaItem(item);
        player.prepare();
        requestAudioFocusAndPlay();
        AuraWidgetProvider.updateAll(this, currentTitle, currentArtist, true);
    }

    @Override
    public void onDestroy() {
        if (player != null) player.release();
        releaseEqualizer();
        if (mediaSession != null) mediaSession.release();
        handler.removeCallbacks(statusRunnable);
        if (audioManager != null && audioFocusRequest != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            audioManager.abandonAudioFocusRequest(audioFocusRequest);
        }
        AuraWidgetProvider.updateAll(this, WIDGET_EMPTY_TITLE, WIDGET_EMPTY_ARTIST, false);
        if (instance == this) {
            instance = null;
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel serviceChannel = new NotificationChannel(
                    CHANNEL_ID, "Music Playback", NotificationManager.IMPORTANCE_LOW);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(serviceChannel);
        }
    }

    /* ── Queue item data class ── */
    private static class QueueItem {
        final String trackId;
        final int absoluteIndex;
        final String url;
        final String title;
        final String artist;
        final String artwork;

        QueueItem(String trackId, int absoluteIndex, String url, String title, String artist, String artwork) {
            this.trackId = trackId;
            this.absoluteIndex = absoluteIndex;
            this.url = url;
            this.title = title;
            this.artist = artist;
            this.artwork = artwork;
        }
    }
}
