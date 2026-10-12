package com.aston.mingmingmusic;

import android.app.Service;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.util.UUID;

public final class CoreService extends Service {
    private static volatile CoreEndpoint endpoint;
    private volatile Process process;
    static CoreEndpoint endpoint() { return endpoint; }
    @Override public int onStartCommand(Intent intent, int flags, int startId) { startCore(); return START_STICKY; }
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
    @Override public void onDestroy() { endpoint = null; if (process != null) { process.destroy(); process = null; } super.onDestroy(); }
    @Override public IBinder onBind(Intent intent) { return null; }
}
