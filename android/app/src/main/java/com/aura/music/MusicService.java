package com.aura.music;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.support.v4.media.MediaMetadataCompat;
import android.support.v4.media.session.MediaSessionCompat;
import android.support.v4.media.session.PlaybackStateCompat;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.media.app.NotificationCompat.MediaStyle;

import com.google.android.exoplayer2.ExoPlayer;
import com.google.android.exoplayer2.MediaItem;
import com.google.android.exoplayer2.PlaybackException;
import com.google.android.exoplayer2.Player;

public class MusicService extends Service {

    public static final String ACTION_PLAY = "com.aura.music.ACTION_PLAY";
    public static final String ACTION_PAUSE = "com.aura.music.ACTION_PAUSE";
    public static final String ACTION_RESUME = "com.aura.music.ACTION_RESUME";
    public static final String ACTION_NEXT = "com.aura.music.ACTION_NEXT";
    public static final String ACTION_PREV = "com.aura.music.ACTION_PREV";
    public static final String ACTION_SEEK = "com.aura.music.ACTION_SEEK";

    public static final String ACTION_PLAYBACK_ERROR = "com.aura.music.PLAYBACK_ERROR";
    
    private static final String CHANNEL_ID = "MusicPlaybackChannel";
    private static final int NOTIFICATION_ID = 1;

    private ExoPlayer player;
    private MediaSessionCompat mediaSession;
    private String currentTitle = "Aura Music";
    private String currentArtist = "Unknown Artist";
    private String currentArtwork = "";
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
        createNotificationChannel();

        player = new ExoPlayer.Builder(this).build();
        player.addListener(new Player.Listener() {
            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                updateNotification();
                updatePlaybackState();
            }
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_ENDED) {
                    sendExplicitBroadcast("com.aura.music.TRACK_ENDED");
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                android.util.Log.e("MusicService", "Playback error", error);
                Intent intent = new Intent(ACTION_PLAYBACK_ERROR);
                intent.putExtra("message", error != null ? error.getMessage() : "Playback failed");
                sendExplicitBroadcast(intent);
                updateNotification();
                updatePlaybackState();
            }
        });

        mediaSession = new MediaSessionCompat(this, "AuraMusicSession");
        mediaSession.setCallback(new MediaSessionCompat.Callback() {
            @Override
            public void onPlay() {
                player.play();
                updateNotification();
                updatePlaybackState();
            }
            @Override
            public void onPause() {
                player.pause();
                updateNotification();
                updatePlaybackState();
            }
            @Override
            public void onSkipToNext() { sendExplicitBroadcast("com.aura.music.SKIP_NEXT"); }
            @Override
            public void onSkipToPrevious() { sendExplicitBroadcast("com.aura.music.SKIP_PREV"); }
            @Override
            public void onSeekTo(long pos) { player.seekTo(pos); }
        });
        mediaSession.setActive(true);
        handler.post(statusRunnable);
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
                    break;
                case ACTION_RESUME:
                    player.play();
                    break;
                case ACTION_NEXT:
                    android.util.Log.d("MusicService", "ACTION_NEXT triggered");
                    sendExplicitBroadcast("com.aura.music.SKIP_NEXT");
                    break;
                case ACTION_PREV:
                    android.util.Log.d("MusicService", "ACTION_PREV triggered");
                    sendExplicitBroadcast("com.aura.music.SKIP_PREV");
                    break;
                case ACTION_SEEK:
                    player.seekTo(intent.getLongExtra("position", 0));
                    break;
            }
        }
        startForeground(NOTIFICATION_ID, createNotification());
        return START_STICKY;
    }

    private void updatePlaybackState() {
        int state = player.getPlayWhenReady() ? PlaybackStateCompat.STATE_PLAYING : PlaybackStateCompat.STATE_PAUSED;
        mediaSession.setPlaybackState(new PlaybackStateCompat.Builder()
                .setState(state, player.getCurrentPosition(), 1.0f)
                .setActions(PlaybackStateCompat.ACTION_PLAY | PlaybackStateCompat.ACTION_PAUSE |
                        PlaybackStateCompat.ACTION_SKIP_TO_NEXT | PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS |
                        PlaybackStateCompat.ACTION_SEEK_TO)
                .build());
    }

    private void updateNotification() {
        NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (nm != null) nm.notify(NOTIFICATION_ID, createNotification());
    }

    private Notification createNotification() {
        Intent notifyIntent = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, notifyIntent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);

        boolean isPlaying = player.getPlayWhenReady();
        
        NotificationCompat.Action playPauseAction = isPlaying ?
                new NotificationCompat.Action(android.R.drawable.ic_media_pause, "Pause", getServiceIntent(ACTION_PAUSE)) :
                new NotificationCompat.Action(android.R.drawable.ic_media_play, "Play", getServiceIntent(ACTION_RESUME));

        mediaSession.setMetadata(new MediaMetadataCompat.Builder()
                .putString(MediaMetadataCompat.METADATA_KEY_TITLE, currentTitle)
                .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, currentArtist)
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
        return PendingIntent.getService(this, requestCode, intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    public void playTrack(String url) {
        MediaItem item = MediaItem.fromUri(url);
        player.setMediaItem(item);
        player.prepare();
        player.play();
        updateNotification();
    }

    @Override
    public void onDestroy() {
        if (player != null) player.release();
        if (mediaSession != null) mediaSession.release();
        handler.removeCallbacks(statusRunnable);
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
}
