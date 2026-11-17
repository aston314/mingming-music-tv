package com.aston.mingmingmusic;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.ValueCallback;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.JavascriptInterface;
import android.widget.FrameLayout;
import java.net.HttpURLConnection;
import java.net.URL;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web;
    private boolean ready, destroyed;
    private boolean explicitExit;
    private int startupGeneration;
    private Thread startupWorker;
    private FrameLayout root;
    private StartupView startup;
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        immersive();
        root = new FrameLayout(this);
        startup = new StartupView(this, new Runnable() { @Override public void run() { restartStartup(); } });
        root.addView(startup, new FrameLayout.LayoutParams(-1, -1));
        setContentView(root);
        startService(new Intent(this, CoreService.class));
        waitForCore();
    }
    private void immersive() { getWindow().getDecorView().setSystemUiVisibility(5894); }
    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        immersive();
        if (web != null && !destroyed) {
            web.requestFocus();
            web.evaluateJavascript("window.MingmingTVForeground&&window.MingmingTVForeground()", null);
        } else if (!destroyed && !ready) {
            startService(new Intent(this, CoreService.class));
            waitForCore();
        }
    }
    private void restartStartup() {
        ready = false;
        if (web != null) { root.removeView(web); web.destroy(); web = null; }
        startup.setVisibility(View.VISIBLE); startup.setStatus("正在准备音乐服务", true);
        startService(new Intent(this, CoreService.class));
        waitForCore();
    }
    private void waitForCore() {
        final int generation = ++startupGeneration;
        if (startupWorker != null) startupWorker.interrupt();
        startupWorker = new Thread(new Runnable() { @Override public void run() {
            long until = System.currentTimeMillis() + 30000;
            while (System.currentTimeMillis() < until && !Thread.currentThread().isInterrupted()) {
                final CoreEndpoint endpoint = CoreService.endpoint();
                if (endpoint != null && check(endpoint)) {
                    handler.post(new Runnable() { @Override public void run() {
                        if (!destroyed && generation == startupGeneration) load(endpoint);
                    } });
                    return;
                }
                try { Thread.sleep(200); } catch (InterruptedException ignored) { return; }
            }
            handler.post(new Runnable() { @Override public void run() {
                if (!destroyed && generation == startupGeneration) startup.setStatus("音乐服务启动失败，请重试", false);
            } });
        } }, "mingming-wait");
        startupWorker.start();
    }
    private boolean check(CoreEndpoint endpoint) { HttpURLConnection c = null; try { c = (HttpURLConnection) new URL(endpoint.url + "health").openConnection(); c.setConnectTimeout(1000); c.setReadTimeout(1000); return c.getResponseCode() == 200; } catch (Exception e) { return false; } finally { if (c != null) c.disconnect(); } }
    @SuppressLint("SetJavaScriptEnabled") private void load(final CoreEndpoint endpoint) {
        startup.setStatus("正在加载音乐界面", true);
        web = new WebView(this);
        final WebView page = web;
        final int generation = startupGeneration;
        web.setBackgroundColor(Color.rgb(16, 23, 19)); web.setFocusable(true); web.setFocusableInTouchMode(true);
        web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new MusicBridge(), "MingmingNativePlayer");
        web.addJavascriptInterface(new AppBridge(), "MingmingTVApp");
        web.setWebViewClient(new WebViewClient() {
            private boolean failed;
            @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !url.startsWith(endpoint.url); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame() && page == web && !destroyed) { failed = true; startup.setStatus("音乐界面加载失败，请重试", false); }
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (failed || destroyed || page != web || generation != startupGeneration) return;
                ready = true; startup.pauseAnimation(); startup.setVisibility(View.GONE); view.requestFocus(); immersive();
            }
        });
        root.addView(web, 0, new FrameLayout.LayoutParams(-1, -1));
        web.loadUrl(endpoint.url);
        handler.postDelayed(new Runnable() { @Override public void run() {
            if (!destroyed && generation == startupGeneration && !ready && page == web) startup.setStatus("音乐界面加载超时，请重试", false);
        } }, 30000);
    }
    @Override public boolean dispatchKeyEvent(KeyEvent event) { if (ready && web != null && event.getAction() == KeyEvent.ACTION_DOWN) { int code = event.getKeyCode(); if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) { web.evaluateJavascript("window.MingmingTVKey&&window.MingmingTVKey(" + code + ");", null); return true; } } return super.dispatchKeyEvent(event); }
    private static final class MusicBridge {
        @JavascriptInterface public String read() { return CoreService.playbackState(); }
        @JavascriptInterface public void command(String operation, String payload) { CoreService.playerCommand(operation, payload); }
    }
    private final class AppBridge {
        @JavascriptInterface public void exit() {
            runOnUiThread(new Runnable() { @Override public void run() {
                if (destroyed) return;
                explicitExit = true;
                // The service pauses, checkpoints and stops its own foreground
                // notification before the Activity is torn down.
                CoreService.exitPlayback();
                finish();
            } });
        }
    }
    @Override protected void onResume() { super.onResume(); immersive(); if (startup != null) startup.resumeAnimation(); if (web != null) { web.onResume(); web.evaluateJavascript("window.MingmingTVForeground&&window.MingmingTVForeground()", null); } }
    @Override public void onBackPressed() {
        if (!ready || web == null) { explicitExit = true; CoreService.exitPlayback(); super.onBackPressed(); return; }
        web.evaluateJavascript("window.MingmingTVBack?window.MingmingTVBack():false", new ValueCallback<String>() {
            @Override public void onReceiveValue(String handled) { if (!"true".equals(handled)) { explicitExit = true; CoreService.exitPlayback(); MainActivity.super.onBackPressed(); } }
        });
    }
    private void cancelPhoneInput() {
        final CoreEndpoint endpoint = CoreService.endpoint();
        if (endpoint == null) return;
        new Thread(new Runnable() { public void run() {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(endpoint.url + "api/scan/cancel").openConnection();
                connection.setRequestMethod("POST"); connection.setConnectTimeout(1500); connection.setReadTimeout(1500);
                connection.setDoOutput(true); connection.getOutputStream().close(); connection.getResponseCode();
            } catch (Exception ignored) {} finally { if (connection != null) connection.disconnect(); }
        } }, "mingming-phone-cancel").start();
    }
    @Override protected void onPause() { cancelPhoneInput(); CoreService.backgroundPlayback(); if (startup != null) startup.pauseAnimation(); if (web != null) { web.evaluateJavascript("window.MingmingTVBackground&&window.MingmingTVBackground()", null); web.onPause(); } super.onPause(); }
    @Override protected void onDestroy() { destroyed = true; startupGeneration++; if (startupWorker != null) startupWorker.interrupt(); handler.removeCallbacksAndMessages(null); if (startup != null) startup.pauseAnimation(); if (web != null) { web.destroy(); web = null; } if (explicitExit) CoreService.exitPlayback(); super.onDestroy(); }
}
