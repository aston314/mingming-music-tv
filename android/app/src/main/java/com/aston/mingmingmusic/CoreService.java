package com.aston.mingmingmusic;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.UUID;

public final class CoreService extends Service {
    private static volatile CoreEndpoint endpoint;
    private static volatile CoreService instance;
    private final Handler main = new Handler(Looper.getMainLooper());
    private NativeMusicPlayer music;
    private volatile Process process;
    static CoreEndpoint endpoint() { return endpoint; }
    static String playbackState() { CoreService current = instance; return current == null || current.music == null ? "{}" : current.music.read(); }
    static void playerCommand(final String operation, final String value) {
        final CoreService current = instance;
        if (current != null) current.main.post(new Runnable() { @Override public void run() { if (current.music != null) current.music.command(operation, value); } });
    }
    static void backgroundPlayback() { final CoreService current = instance; if (current != null) current.main.post(new Runnable() { @Override public void run() { if (current.music != null) current.music.background(); } }); }
    static void exitPlayback() { final CoreService current = instance; if (current != null) current.main.post(new Runnable() { @Override public void run() { if (current.music != null) current.music.exit(); else current.stopSelf(); } }); }
    @Override public void onCreate() { super.onCreate(); music = new NativeMusicPlayer(this); instance = this; if (Build.VERSION.SDK_INT >= 26) music.startForegroundIdle(); }
    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        startCore();
        if (intent != null && intent.getAction() != null) {
            if ("stop".equals(intent.getAction())) music.exit();
            else music.command(intent.getAction(), "");
        }
        // OS process recreation restores metadata through Go; it must never autoplay.
        return START_NOT_STICKY;
    }
    private synchronized void startCore() {
        if (process != null) { try { process.exitValue(); } catch (IllegalThreadStateException running) { return; } }
        final String instance = UUID.randomUUID().toString();
        try {
            File binary = new File(getApplicationInfo().nativeLibraryDir, "libmingmingmusic.so");
            ProcessBuilder builder = new ProcessBuilder(binary.getAbsolutePath(), "-port", "0", "-instance-id", instance, "-parent-pid", String.valueOf(android.os.Process.myPid()));
            builder.environment().put("MINGMING_DATA_DIR", new File(getFilesDir(), "mingming-music").getAbsolutePath());
            process = builder.redirectErrorStream(true).start();
            new Thread(new Runnable() { public void run() { try { BufferedReader in = new BufferedReader(new InputStreamReader(process.getInputStream())); String line; while ((line = in.readLine()) != null) { CoreEndpoint ready = CoreEndpoint.parse(line, instance); if (ready != null) endpoint = ready; else Log.i("MingmingMusic", line); } } catch (Exception ignored) {} finally { endpoint = null; } } }, "mingming-core-log").start();
        } catch (Exception e) { Log.e("MingmingMusic", "core start failed", e); }
    }
    @Override public void onTaskRemoved(Intent rootIntent) { if (music == null || !music.active()) exitPlayback(); super.onTaskRemoved(rootIntent); }
    @Override public void onDestroy() { instance = null; main.removeCallbacksAndMessages(null); if (music != null) { music.release(); music = null; } endpoint = null; if (process != null) { process.destroy(); process = null; } super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
