package com.aston.mingmingmusic;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Intent;
import android.media.MediaMetadata;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import androidx.media3.common.AudioAttributes;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.exoplayer.ExoPlayer;

import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Random;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Service owns audio, audio focus, queue continuation and checkpoints. The page only renders. */
@android.annotation.SuppressLint("UnsafeOptInUsageError")
final class NativeMusicPlayer {
    private static final String TAG = "MingmingMusic";
    private static final String CHANNEL = "music-playback";
    private static final int NOTIFICATION = 7;
    private final CoreService service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService resolver = Executors.newSingleThreadExecutor();
    private final ExecutorService writer = Executors.newSingleThreadExecutor();
    private final ExoPlayer player;
    private final MediaSession session;
    private final PendingIntent appIntent;
    private final String clientId = "native-" + UUID.randomUUID();
    private final Random random = new Random();
    private JSONObject track;
    private JSONArray list = new JSONArray();
    private String mode = "list", listSource = "", status = "idle";
    private String errorKind = "";
    private int errorCode;
    private double position, duration;
    private long generation, sequence, lastSave, selectionTag, positionAt;
    private int sourceRetryCount, autoSkipCount;
    private boolean ready, resolving, wantPlay, replacing, released, foreground, exiting;
    private volatile String published = "{}";

    NativeMusicPlayer(CoreService service) {
        this.service = service;
        player = new ExoPlayer.Builder(service).build();
        player.setAudioAttributes(new AudioAttributes.Builder().setUsage(C.USAGE_MEDIA)
                .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC).build(), true);
        player.setHandleAudioBecomingNoisy(true);
        player.setWakeMode(C.WAKE_MODE_NETWORK);
        session = new MediaSession(service, "明明音乐");
        appIntent = openApp();
        session.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { play(); }
            @Override public void onPause() { pause(); }
            @Override public void onStop() { exit(); }
            @Override public void onSeekTo(long value) { seek(value / 1000d); }
            @Override public void onSkipToNext() { next(1, false); }
            @Override public void onSkipToPrevious() { next(-1, false); }
        }, main);
        session.setSessionActivity(appIntent);
        session.setActive(true);
        player.addListener(new Player.Listener() {
            @Override public void onEvents(Player value, Player.Events events) {
                if (replacing || released) return;
                if (value.getPlaybackState() == Player.STATE_READY) {
                    ready = true;
                    errorKind = "";
                    errorCode = 0;
                }
                if (value.getPlaybackState() == Player.STATE_ENDED && wantPlay) {
                    autoSkipCount = 0;
                    position = duration; publish("ended"); next(1, true, true); return;
                }
                if (!resolving && value.getMediaItemCount() > 0) wantPlay = value.getPlayWhenReady();
                refresh();
            }
            @Override public void onPlayerError(PlaybackException error) {
                if (released) return;
                boolean retry = wantPlay && PlaybackDiagnostics.isRetryable(error.errorCode)
                        && sourceRetryCount < PlaybackDiagnostics.MAX_SOURCE_RETRIES;
                capture(); ready = false; resolving = false;
                errorCode = error.errorCode;
                errorKind = PlaybackDiagnostics.kind(error.errorCode);
                replacing = true; player.stop(); player.clearMediaItems(); replacing = false;
                if (retry) {
                    sourceRetryCount++;
                    publish("preparing");
                    main.postDelayed(new Runnable() { @Override public void run() {
                        if (!released && !exiting && track != null && wantPlay) play();
                    } }, 500L + (sourceRetryCount * 350L));
                    return;
                }
                // An AudioTrack/decoder resource failure is local to the
                // device. Skipping through the queue cannot repair it and
                // creates the appearance of continuous automatic song changes.
                if (PlaybackDiagnostics.isDeviceAudioFailure(error.errorCode)) {
                    wantPlay = false;
                    publish("failed"); checkpoint(null);
                    return;
                }
                if (continueAfterFailure()) return;
                wantPlay = false;
                publish("failed"); checkpoint(null);
            }
        });
        main.post(tick);
    }

    String read() { return published; }
    boolean active() { return wantPlay; }
    private final Runnable tick = new Runnable() {
        @Override public void run() {
            if (released || exiting) return;
            refresh();
            if (track != null && wantPlay && System.currentTimeMillis() - lastSave >= 5000) checkpoint(null);
            main.postDelayed(this, 500);
        }
    };

    void command(String operation, String payload) {
        if (released || exiting) return;
        try {
            if ("select".equals(operation)) select(new JSONObject(payload), true);
            else if ("configure".equals(operation)) configure(new JSONObject(payload));
            else if ("play".equals(operation)) play();
            else if ("pause".equals(operation)) pause();
            else if ("seek".equals(operation)) seek(Double.parseDouble(payload));
            else if ("next".equals(operation)) next(1, false);
            else if ("previous".equals(operation)) next(-1, false);
            else if ("save".equals(operation)) checkpoint(null);
        } catch (Exception ignored) { /* malformed bridge commands never replace valid state */ }
    }
    private void select(JSONObject value, boolean resetAutoSkip) throws Exception {
        JSONObject selected = value.getJSONObject("track");
        if (selected.optString("id").isEmpty()) return;
        generation++; replacing = true; wantPlay = false; resolving = false; ready = false;
        player.stop(); player.clearMediaItems(); replacing = false;
        track = new JSONObject(selected.toString());
        errorKind = "";
        errorCode = 0;
        sourceRetryCount = 0;
        if (resetAutoSkip) autoSkipCount = 0;
        selectionTag = value.optLong("selectionTag", 0);
        list = value.optJSONArray("list") == null ? new JSONArray() : value.getJSONArray("list");
        mode = value.optString("mode", "list"); listSource = value.optString("listSource", "");
        position = Math.max(0, value.optDouble("position", 0));
        positionAt = System.currentTimeMillis();
        duration = Math.max(0, value.optDouble("duration", track.optDouble("dt", 0) / 1000));
        publish("paused"); checkpoint(null);
    }
    private void configure(JSONObject value) {
        // A queued visibility callback from the old track cannot overwrite service continuation.
        if (track == null || !track.optString("id").equals(value.optJSONObject("track") == null ? "" : value.optJSONObject("track").optString("id"))) return;
        if (value.optJSONArray("list") != null) list = value.optJSONArray("list");
        mode = value.optString("mode", mode); listSource = value.optString("listSource", listSource);
        refresh(); checkpoint(null);
    }
    private void play() {
        if (track == null || released || exiting) return;
        // A user-triggered retry gets its own single bounded source retry.
        if ("failed".equals(status)) sourceRetryCount = 0;
        // Start mediaPlayback foreground service before requesting focus (also required on API35).
        wantPlay = true;
        try { publish("preparing"); }
        catch (RuntimeException denied) { wantPlay = false; publish("failed"); return; }
        if (ready || player.getMediaItemCount() > 0) { player.play(); refresh(); return; }
        if (resolving) return;
        resolving = true;
        final long request = generation;
        final JSONObject selected = track;
        final CoreEndpoint endpoint = CoreService.endpoint();
        resolver.execute(new Runnable() { @Override public void run() {
            String source = null;
            boolean resolverTransportFailure = false;
            try {
                if (endpoint == null) throw new IllegalStateException("core unavailable");
                String form = "id=" + URLEncoder.encode(selected.optString("id"), "UTF-8") + "&type="
                        + URLEncoder.encode(selected.optString("type", selected.optString("provider", "wy")), "UTF-8");
                for (int attempt = 0; attempt <= PlaybackDiagnostics.MAX_SOURCE_RETRIES; attempt++) {
                    try {
                        JSONObject response = new JSONObject(request(endpoint.url + "api/music/url", "POST", form, "application/x-www-form-urlencoded"));
                        String candidate = response.optString("data").trim();
                        if (!(candidate.startsWith("http://") || candidate.startsWith("https://"))) throw new IllegalStateException("resolver returned no playable URL");
                        source = candidate;
                        break;
                    } catch (Exception failure) {
                        resolverTransportFailure = resolverTransportFailure || failure instanceof java.io.IOException;
                        Log.w(TAG, "source resolve failed for track " + selected.optString("id") + " (attempt " + (attempt + 1) + ")", failure);
                        if (attempt < PlaybackDiagnostics.MAX_SOURCE_RETRIES) {
                            try { Thread.sleep(500L + (attempt * 350L)); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); break; }
                        }
                    }
                }
            } catch (Exception failure) { resolverTransportFailure = failure instanceof java.io.IOException; }
            final String resolved = source;
            final boolean resolverNetworkFailure = resolverTransportFailure;
            main.post(new Runnable() { @Override public void run() {
                if (released || exiting || request != generation) return;
                resolving = false;
                if (resolved == null || resolved.isEmpty()) {
                    errorKind = resolverNetworkFailure ? "network" : "resolver";
                    errorCode = 0;
                    wantPlay = false;
                    publish("failed");
                    checkpoint(null);
                    return;
                }
                try {
                    String media = endpoint.url + "media?url=" + URLEncoder.encode(resolved, "UTF-8");
                    replacing = true;
                    player.setMediaItem(MediaItem.fromUri(media), (long) (position * 1000));
                    player.setPlayWhenReady(wantPlay); player.prepare(); replacing = false;
                    refresh();
                } catch (Exception ignored) {
                    replacing = false;
                    errorKind = "player";
                    errorCode = 0;
                    wantPlay = false;
                    publish("failed");
                }
            } });
        } });
    }
    private void pause() {
        autoSkipCount = 0; wantPlay = false; player.pause(); capture(); publish("paused"); checkpoint(null);
    }
    private void seek(double seconds) {
        if (Double.isNaN(seconds) || Double.isInfinite(seconds)) return;
        position = Math.max(0, duration > 0 ? Math.min(seconds, duration) : seconds);
        positionAt = System.currentTimeMillis();
        if (player.getMediaItemCount() > 0) player.seekTo((long) (position * 1000));
        refresh(); checkpoint(null);
    }
    private void next(int direction, boolean ended) { next(direction, ended, false); }
    private void next(int direction, boolean ended, boolean automatic) {
        if (!automatic) autoSkipCount = 0;
        ArrayList<String> ids = new ArrayList<>();
        for (int i = 0; i < list.length(); i++) ids.add(list.optJSONObject(i) == null ? "" : list.optJSONObject(i).optString("id"));
        int index = PlaybackQueue.next(ids, track == null ? "" : track.optString("id"), mode, direction, ended, random);
        if (index < 0) { pause(); return; }
        try {
            JSONObject selected = list.getJSONObject(index);
            JSONObject value = snapshot(); value.put("track", selected).put("position", 0)
                    .put("duration", selected.optDouble("dt", 0) / 1000);
            select(value, !automatic); play();
        } catch (Exception ignored) { pause(); }
    }
    private boolean continueAfterFailure() {
        if (!wantPlay || "one".equals(mode) || list.length() < 2 || autoSkipCount >= list.length()) return false;
        autoSkipCount++;
        next(1, true, true);
        return true;
    }
    private void capture() {
        if (ready) {
            position = Math.max(0, player.getCurrentPosition() / 1000d);
            positionAt = System.currentTimeMillis();
            long total = player.getDuration();
            if (total != C.TIME_UNSET && total > 0) duration = total / 1000d;
        }
    }
    private void refresh() {
        capture();
        if ("failed".equals(status) && !wantPlay) { publish(status); return; }
        String value = !wantPlay ? (track == null ? "idle" : "paused") : resolving || !ready ? "preparing"
                : player.isPlaying() ? "playing" : player.getPlaybackSuppressionReason() != Player.PLAYBACK_SUPPRESSION_REASON_NONE ? "paused" : "buffering";
        publish(value);
    }
    private JSONObject snapshot() throws Exception {
        return new JSONObject().put("schema", 1).put("track", track).put("position", position)
                .put("duration", duration).put("mode", mode).put("list", list).put("listSource", listSource);
    }
    private void publish(String value) {
        boolean changed = !value.equals(status);
        status = value;
        try {
            published = new JSONObject().put("snapshot", track == null ? JSONObject.NULL : snapshot())
                    .put("state", status).put("ready", ready).put("wantPlay", wantPlay)
                    .put("generation", generation).put("positionAt", positionAt).put("selectionTag", selectionTag)
                    .put("errorKind", errorKind.isEmpty() ? JSONObject.NULL : errorKind)
                    .put("errorCode", errorCode == 0 ? JSONObject.NULL : errorCode)
                    .put("sourceRetryCount", sourceRetryCount).toString();
        } catch (Exception ignored) {}
        int nativeState = "playing".equals(status) ? PlaybackState.STATE_PLAYING : "failed".equals(status) ? PlaybackState.STATE_ERROR
                : wantPlay ? PlaybackState.STATE_BUFFERING : PlaybackState.STATE_PAUSED;
        session.setPlaybackState(new PlaybackState.Builder().setActions(PlaybackState.ACTION_PLAY | PlaybackState.ACTION_PAUSE
                | PlaybackState.ACTION_PLAY_PAUSE | PlaybackState.ACTION_SKIP_TO_NEXT | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                | PlaybackState.ACTION_SEEK_TO | PlaybackState.ACTION_STOP).setState(nativeState, (long) (position * 1000), "playing".equals(status) ? 1f : 0f).build());
        if (track != null && (changed || !foreground && wantPlay)) updateNotification();
    }
    private PendingIntent openApp() {
        Intent intent = Intent.makeMainActivity(new ComponentName(service, MainActivity.class));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED);
        return PendingIntent.getActivity(service, 0, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    private PendingIntent action(String name, int code) {
        return PendingIntent.getService(service, code, new Intent(service, CoreService.class).setAction(name), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    void startForegroundIdle() { if (!foreground) updateNotification(true); }
    private void updateNotification() { updateNotification(false); }
    private void updateNotification(boolean forceForeground) {
        String title = track == null ? "明明音乐" : track.optString("name", track.optString("title", "明明音乐")), artist = track == null ? "准备播放" : track.optString("artist", "");
        JSONArray artists = track == null ? null : track.optJSONArray("ar");
        if (artists == null && track != null) artists = track.optJSONArray("artists");
        if (artist.isEmpty() && artists != null && artists.length() > 0) artist = artists.optJSONObject(0) == null ? artists.optString(0) : artists.optJSONObject(0).optString("name");
        session.setMetadata(new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE, title)
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist).putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration * 1000)).build());
        NotificationManager manager = (NotificationManager) service.getSystemService(android.content.Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= 26) manager.createNotificationChannel(new NotificationChannel(CHANNEL, "音乐播放", NotificationManager.IMPORTANCE_LOW));
        Notification.Builder builder = Build.VERSION.SDK_INT >= 26 ? new Notification.Builder(service, CHANNEL) : new Notification.Builder(service);
        Notification note = builder.setSmallIcon(R.drawable.ic_launcher).setContentTitle(title).setContentText(artist)
                .setContentIntent(appIntent).setVisibility(Notification.VISIBILITY_PUBLIC).setShowWhen(false)
                .setOngoing(wantPlay).setCategory(Notification.CATEGORY_TRANSPORT)
                .addAction(android.R.drawable.ic_media_previous, "上一首", action("previous", 1))
                .addAction(wantPlay ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play, wantPlay ? "暂停" : "播放", action(wantPlay ? "pause" : "play", 2))
                .addAction(android.R.drawable.ic_media_next, "下一首", action("next", 3))
                .setDeleteIntent(action("stop", 4))
                .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0, 1, 2)).build();
        if ((wantPlay || forceForeground) && !foreground) { service.startForeground(NOTIFICATION, note); foreground = true; }
        else {
            if (!wantPlay && foreground) { service.stopForeground(false); foreground = false; }
            manager.notify(NOTIFICATION, note);
        }
    }
    private void checkpoint(final Runnable complete) {
        if (released) return;
        capture(); final CoreEndpoint endpoint = CoreService.endpoint();
        if (track == null || endpoint == null) { if (complete != null) complete.run(); return; }
        final String body;
        try { body = new JSONObject().put("clientId", clientId).put("sequence", ++sequence).put("snapshot", snapshot()).toString(); }
        catch (Exception ignored) { if (complete != null) complete.run(); return; }
        lastSave = System.currentTimeMillis();
        writer.execute(new Runnable() { @Override public void run() {
            try { request(endpoint.url + "api/playback", "PUT", body, "application/json"); } catch (Exception ignored) {}
            if (complete != null) main.post(complete);
        } });
    }
    void background() { checkpoint(null); }
    void exit() {
        if (exiting || released) return;
        pause(); exiting = true; generation++; main.removeCallbacks(tick);
        checkpoint(new Runnable() { @Override public void run() { service.stopSelf(); } });
    }
    void release() {
        released = true; generation++; main.removeCallbacksAndMessages(null);
        resolver.shutdownNow(); writer.shutdown(); player.release(); session.release();
        if (foreground) service.stopForeground(true);
        ((NotificationManager) service.getSystemService(android.content.Context.NOTIFICATION_SERVICE)).cancel(NOTIFICATION);
    }
    private static String request(String address, String method, String body, String contentType) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(address).openConnection();
        try {
            // The core may spend up to 45 seconds resolving a slow upstream
            // source. Keep the native bridge above that budget so Android does
            // not report a resolver failure while the Go request is still in flight.
            connection.setConnectTimeout(5000); connection.setReadTimeout(50000); connection.setRequestMethod(method);
            connection.setRequestProperty("Content-Type", contentType); connection.setDoOutput(true);
            byte[] encoded = body.getBytes(StandardCharsets.UTF_8); connection.setFixedLengthStreamingMode(encoded.length);
            try (java.io.OutputStream out = connection.getOutputStream()) { out.write(encoded); }
            if (connection.getResponseCode() != 200) throw new IllegalStateException("core request failed");
            try (InputStream in = connection.getInputStream(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[8192]; int count;
                while ((count = in.read(buffer)) != -1) { out.write(buffer, 0, count); if (out.size() > 2 * 1024 * 1024) throw new IllegalStateException("response too large"); }
                return out.toString("UTF-8");
            }
        } finally { connection.disconnect(); }
    }
}
