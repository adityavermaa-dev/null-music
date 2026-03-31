package com.aura.music;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.net.Uri;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "MusicPlayer")
public class MusicPlugin extends Plugin {
    private static final String DOWNLOAD_PREFS = "aura_downloads";
    private static final String DOWNLOADS_KEY = "items";
    private static final String DOWNLOAD_DIR = "downloads";
    private static final String HTTP_UA = "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

    private BroadcastReceiver receiver;
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();
    private final Set<String> canceledDownloads = new HashSet<>();

    private void startMusicService(Intent intent) {
        if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }
    }

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
                } else if (action.equals("com.aura.music.QUEUE_INDEX_CHANGED")) {
                    ret.put("index", intent.getIntExtra("index", -1));
                    notifyListeners("queueIndexChanged", ret);
                }
            }
        };

        IntentFilter filter = new IntentFilter();
        filter.addAction("com.aura.music.SKIP_NEXT");
        filter.addAction("com.aura.music.SKIP_PREV");
        filter.addAction("com.aura.music.TRACK_ENDED");
        filter.addAction(MusicService.ACTION_PLAYBACK_ERROR);
        filter.addAction("com.aura.music.STATUS_UPDATE");
        filter.addAction("com.aura.music.QUEUE_INDEX_CHANGED");
        
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

        startMusicService(intent);
        call.resolve();
    }

    @PluginMethod
    public void pause(PluginCall call) {
        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_PAUSE);
        startMusicService(intent);
        call.resolve();
    }

    @PluginMethod
    public void resume(PluginCall call) {
        Intent intent = new Intent(getContext(), MusicService.class);
        intent.setAction(MusicService.ACTION_RESUME);
        startMusicService(intent);
        call.resolve();
    }

    @PluginMethod
    public void seek(PluginCall call) {
        Double position = call.getDouble("position");
        if (position != null) {
            Intent intent = new Intent(getContext(), MusicService.class);
            intent.setAction(MusicService.ACTION_SEEK);
            intent.putExtra("position", position.longValue() * 1000);
            startMusicService(intent);
        }
        call.resolve();
    }

    @PluginMethod
    public void setQueue(PluginCall call) {
        try {
            JSObject data = call.getData();
            JSONArray tracks = data.getJSONArray("tracks");
            int currentIndex = data.optInt("currentIndex", -1);
            int offset = data.optInt("offset", 0);

            Intent intent = new Intent(getContext(), MusicService.class);
            intent.setAction(MusicService.ACTION_SET_QUEUE);
            intent.putExtra("queue", tracks.toString());
            intent.putExtra("currentIndex", currentIndex);
            intent.putExtra("offset", offset);
            startMusicService(intent);
            call.resolve();
        } catch (Exception e) {
            android.util.Log.e("MusicPlugin", "setQueue error", e);
            call.reject("Failed to set queue: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getEqualizerState(PluginCall call) {
        call.resolve(MusicService.getEqualizerStateSnapshot());
    }

    @PluginMethod
    public void setEqualizerEnabled(PluginCall call) {
        boolean enabled = call.getBoolean("enabled", false);
        MusicService.setEqualizerEnabledStatic(enabled);
        call.resolve(MusicService.getEqualizerStateSnapshot());
    }

    @PluginMethod
    public void setEqualizerPreset(PluginCall call) {
        Integer preset = call.getInt("preset");
        if (preset == null) {
            call.reject("Preset is required");
            return;
        }

        MusicService.setEqualizerPresetStatic(preset);
        call.resolve(MusicService.getEqualizerStateSnapshot());
    }

    @PluginMethod
    public void getDownloadedTracks(PluginCall call) {
        JSObject ret = new JSObject();
        JSONArray tracks = readDownloads();
        ret.put("tracks", tracks);
        ret.put("summary", buildDownloadSummary(tracks));
        call.resolve(ret);
    }

    @PluginMethod
    public void downloadTrack(PluginCall call) {
        final String url = call.getString("url");
        final String trackId = call.getString("id", UUID.randomUUID().toString());
        final String title = call.getString("title", "Unknown");
        final String artist = call.getString("artist", "Unknown");
        final String album = call.getString("album", "");
        final String artwork = call.getString("artwork", "");
        final Double duration = call.getDouble("duration");

        if (url == null || url.trim().isEmpty()) {
            call.reject("Track URL is required");
            return;
        }

        downloadExecutor.execute(() -> {
            try {
                notifyDownloadProgress(trackId, title, 0, "queued");
                JSONObject track = downloadAndStoreTrack(url, trackId, title, artist, album, artwork, duration);
                JSObject ret = new JSObject();
                ret.put("track", track);
                ret.put("summary", buildDownloadSummary(readDownloads()));
                JSObject complete = new JSObject();
                complete.put("track", track);
                complete.put("summary", buildDownloadSummary(readDownloads()));
                notifyListeners("downloadCompleted", complete);
                resolveOnMainThread(call, ret);
            } catch (Exception e) {
                android.util.Log.e("MusicPlugin", "downloadTrack failed", e);
                String message = e.getMessage() != null ? e.getMessage() : "Unknown download error";
                boolean canceled = message != null && message.toLowerCase().contains("cancel");
                JSObject errorRet = new JSObject();
                errorRet.put("id", trackId);
                errorRet.put("message", message);
                errorRet.put("status", canceled ? "canceled" : "failed");
                if (canceled) {
                    notifyDownloadProgress(trackId, title, 0, "canceled");
                }
                notifyListeners("downloadFailed", errorRet);
                rejectOnMainThread(call, "Download failed: " + message);
            }
        });
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        String trackId = call.getString("id");
        if (trackId == null || trackId.trim().isEmpty()) {
            call.reject("Track id is required");
            return;
        }

        synchronized (canceledDownloads) {
            canceledDownloads.add(trackId);
        }
        JSObject ret = new JSObject();
        ret.put("id", trackId);
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteDownloadedTrack(PluginCall call) {
        String trackId = call.getString("id");
        if (trackId == null || trackId.trim().isEmpty()) {
            call.reject("Track id is required");
            return;
        }

        JSONArray current = readDownloads();
        JSONArray next = new JSONArray();
        boolean deleted = false;

        for (int i = 0; i < current.length(); i++) {
            JSONObject item = current.optJSONObject(i);
            if (item == null) continue;

            String itemId = item.optString("id");
            String originalId = item.optString("originalId");
            if (trackId.equals(itemId) || trackId.equals(originalId)) {
                String localPath = item.optString("localPath", "");
                if (!localPath.isEmpty()) {
                    File file = new File(localPath);
                    if (file.exists()) file.delete();
                }
                deleted = true;
                continue;
            }

            next.put(item);
        }

        writeDownloads(next);

        JSObject ret = new JSObject();
        ret.put("deleted", deleted);
        ret.put("summary", buildDownloadSummary(next));
        call.resolve(ret);
    }

    private void resolveOnMainThread(PluginCall call, JSObject ret) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> call.resolve(ret));
        } else {
            call.resolve(ret);
        }
    }

    private void rejectOnMainThread(PluginCall call, String message) {
        if (getActivity() != null) {
            getActivity().runOnUiThread(() -> call.reject(message));
        } else {
            call.reject(message);
        }
    }

    private JSONObject downloadAndStoreTrack(
        String url,
        String trackId,
        String title,
        String artist,
        String album,
        String artwork,
        Double duration
    ) throws Exception {
        File dir = getDownloadsDir();
        String safeName = sanitizeFilename((artist + " - " + title).trim());
        String ext = inferExtension(url);
        File target = new File(dir, sanitizeFilename(trackId + "-" + safeName) + ext);

        if (!target.exists()) {
            downloadFile(url, target, trackId, title);
        }

        JSONObject track = new JSONObject();
        track.put("id", "download-" + trackId);
        track.put("originalId", trackId);
        track.put("title", title);
        track.put("artist", artist);
        track.put("album", album);
        track.put("coverArt", artwork);
        track.put("streamUrl", Uri.fromFile(target).toString());
        track.put("localPath", target.getAbsolutePath());
        track.put("source", "downloaded");
        track.put("duration", duration != null ? duration : 0);
        track.put("downloadedAt", System.currentTimeMillis());
        track.put("sizeBytes", target.length());

        writeDownload(track);
        return track;
    }

    private File getDownloadsDir() {
        File dir = new File(getContext().getFilesDir(), DOWNLOAD_DIR);
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return dir;
    }

    private void downloadFile(String urlString, File destination, String trackId, String title) throws Exception {
        HttpURLConnection connection = null;
        File temp = new File(destination.getAbsolutePath() + ".part");

        try {
            URL url = new URL(urlString);
            connection = (HttpURLConnection) url.openConnection();
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(60000);
            connection.setInstanceFollowRedirects(true);
            connection.setRequestProperty("User-Agent", HTTP_UA);
            connection.setRequestProperty("Accept-Language", "en-US,en;q=0.9");

            int status = connection.getResponseCode();
            if (status >= 400) {
                throw new IllegalStateException("Server returned " + status);
            }

            long contentLength = connection.getContentLengthLong();

            try (
                InputStream in = new BufferedInputStream(connection.getInputStream());
                OutputStream out = new FileOutputStream(temp)
            ) {
                byte[] buffer = new byte[16 * 1024];
                int read;
                long totalRead = 0;
                while ((read = in.read(buffer)) != -1) {
                    if (isCanceled(trackId)) {
                        throw new IllegalStateException("Download canceled");
                    }
                    out.write(buffer, 0, read);
                    totalRead += read;
                    if (contentLength > 0) {
                        int pct = (int) Math.round((totalRead * 100.0) / contentLength);
                        notifyDownloadProgress(trackId, title, pct, "downloading");
                    }
                }
            }

            if (destination.exists() && !destination.delete()) {
                throw new IllegalStateException("Unable to replace existing file");
            }
            if (!temp.renameTo(destination)) {
                throw new IllegalStateException("Unable to finalize downloaded file");
            }
            notifyDownloadProgress(trackId, title, 100, "completed");
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
            if (temp.exists() && !destination.exists()) {
                temp.delete();
            }
            synchronized (canceledDownloads) {
                canceledDownloads.remove(trackId);
            }
        }
    }

    private JSONArray readDownloads() {
        SharedPreferences prefs = getContext().getSharedPreferences(DOWNLOAD_PREFS, Context.MODE_PRIVATE);
        String raw = prefs.getString(DOWNLOADS_KEY, "[]");
        try {
            JSONArray parsed = new JSONArray(raw);
            JSONArray cleaned = new JSONArray();
            boolean changed = false;

            for (int i = 0; i < parsed.length(); i++) {
                JSONObject item = parsed.optJSONObject(i);
                if (item == null) {
                    changed = true;
                    continue;
                }

                String localPath = item.optString("localPath", "");
                if (!localPath.isEmpty()) {
                    File file = new File(localPath);
                    if (!file.exists()) {
                        changed = true;
                        continue;
                    }
                    item.put("sizeBytes", file.length());
                }

                cleaned.put(item);
            }

            if (changed) {
                writeDownloads(cleaned);
            }

            return cleaned;
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    private void writeDownloads(JSONArray downloads) {
        getContext()
            .getSharedPreferences(DOWNLOAD_PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(DOWNLOADS_KEY, downloads.toString())
            .apply();
    }

    private void writeDownload(JSONObject track) {
        JSONArray existing = readDownloads();
        JSONArray next = new JSONArray();
        String incomingOriginalId = track.optString("originalId", track.optString("id"));
        boolean replaced = false;

        for (int i = 0; i < existing.length(); i++) {
            JSONObject item = existing.optJSONObject(i);
            if (item == null) continue;

            String currentOriginalId = item.optString("originalId", item.optString("id"));
            if (!replaced && incomingOriginalId.equals(currentOriginalId)) {
                next.put(track);
                replaced = true;
            } else {
                next.put(item);
            }
        }

        if (!replaced) {
            next.put(track);
        }

        writeDownloads(next);
    }

    private JSObject buildDownloadSummary(JSONArray downloads) {
        JSObject summary = new JSObject();
        long totalBytes = 0;

        for (int i = 0; i < downloads.length(); i++) {
            JSONObject item = downloads.optJSONObject(i);
            if (item == null) continue;
            totalBytes += item.optLong("sizeBytes", 0);
        }

        summary.put("count", downloads.length());
        summary.put("totalBytes", totalBytes);
        return summary;
    }

    private boolean isCanceled(String trackId) {
        synchronized (canceledDownloads) {
            return canceledDownloads.contains(trackId);
        }
    }

    private void notifyDownloadProgress(String trackId, String title, int progress, String status) {
        JSObject ret = new JSObject();
        ret.put("id", trackId);
        ret.put("title", title);
        ret.put("progress", Math.max(0, Math.min(100, progress)));
        ret.put("status", status);
        notifyListeners("downloadProgress", ret);
    }

    private String inferExtension(String url) {
        String lower = String.valueOf(url).toLowerCase();
        if (lower.contains(".mp3")) return ".mp3";
        if (lower.contains(".webm")) return ".webm";
        if (lower.contains(".ogg")) return ".ogg";
        return ".m4a";
    }

    private String sanitizeFilename(String value) {
        String cleaned = String.valueOf(value)
            .replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", " ")
            .replaceAll("\\s+", " ")
            .trim();

        if (cleaned.isEmpty()) {
            cleaned = "track";
        }

        return cleaned.length() > 80 ? cleaned.substring(0, 80).trim() : cleaned;
    }
}
