package com.aura.music;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;

public class AuraWidgetProvider extends AppWidgetProvider {
    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        for (int appWidgetId : appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, buildViews(context, "Aura Music", "Play something you like", false));
        }
    }

    public static void updateAll(Context context, String title, String artist, boolean isPlaying) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        ComponentName componentName = new ComponentName(context, AuraWidgetProvider.class);
        int[] ids = manager.getAppWidgetIds(componentName);

        if (ids == null || ids.length == 0) return;

        for (int appWidgetId : ids) {
            manager.updateAppWidget(appWidgetId, buildViews(context, title, artist, isPlaying));
        }
    }

    private static RemoteViews buildViews(Context context, String title, String artist, boolean isPlaying) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_aura_music);

        views.setTextViewText(R.id.widget_title, title != null ? title : "Aura Music");
        views.setTextViewText(R.id.widget_artist, artist != null ? artist : "Play something you like");
        views.setImageViewResource(
            R.id.widget_play_pause,
            isPlaying ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play
        );

        Intent launchIntent = new Intent(context, MainActivity.class);
        PendingIntent openApp = PendingIntent.getActivity(
            context,
            100,
            launchIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        views.setOnClickPendingIntent(R.id.widget_root, openApp);
        views.setOnClickPendingIntent(R.id.widget_prev, getServiceIntent(context, MusicService.ACTION_PREV, 101));
        views.setOnClickPendingIntent(
            R.id.widget_play_pause,
            getServiceIntent(context, isPlaying ? MusicService.ACTION_PAUSE : MusicService.ACTION_RESUME, 102)
        );
        views.setOnClickPendingIntent(R.id.widget_next, getServiceIntent(context, MusicService.ACTION_NEXT, 103));
        return views;
    }

    private static PendingIntent getServiceIntent(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, MusicService.class).setAction(action);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return PendingIntent.getForegroundService(context, requestCode, intent, flags);
        }
        return PendingIntent.getService(context, requestCode, intent, flags);
    }
}
