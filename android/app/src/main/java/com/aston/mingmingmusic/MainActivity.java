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
import android.widget.FrameLayout;
import android.widget.TextView;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private WebView web; private boolean ready;
    @Override public void onCreate(Bundle state) { super.onCreate(state); getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON); immersive(); startService(new Intent(this, CoreService.class)); showLoading("正在启动明明音乐…"); waitForCore(); }
    private void immersive() { getWindow().getDecorView().setSystemUiVisibility(5894); }
    private void showLoading(String text) { TextView view = new TextView(this); view.setText(text); view.setTextColor(Color.WHITE); view.setTextSize(22); view.setGravity(17); view.setBackgroundColor(Color.rgb(16,23,19)); setContentView(view); }
    private void waitForCore() { new Thread(new Runnable() { public void run() { long until = System.currentTimeMillis() + 30000; while (System.currentTimeMillis() < until) { CoreEndpoint endpoint = CoreService.endpoint(); if (endpoint != null && check(endpoint)) { handler.post(new Runnable() { public void run() { load(endpoint); } }); return; } try { Thread.sleep(200); } catch (InterruptedException ignored) { return; } } handler.post(new Runnable() { public void run() { showLoading("本机服务启动失败，请重启应用"); } }); } }, "mingming-wait").start(); }
    private boolean check(CoreEndpoint endpoint) { HttpURLConnection c = null; try { c = (HttpURLConnection) new URL(endpoint.url + "health").openConnection(); c.setConnectTimeout(1000); c.setReadTimeout(1000); return c.getResponseCode() == 200; } catch (Exception e) { return false; } finally { if (c != null) c.disconnect(); } }
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"}) private void load(final CoreEndpoint endpoint) { web = new WebView(this); web.setBackgroundColor(Color.TRANSPARENT); web.setFocusable(true); web.setFocusableInTouchMode(true); web.getSettings().setJavaScriptEnabled(true); web.getSettings().setDomStorageEnabled(true); web.getSettings().setAllowFileAccess(false); web.getSettings().setAllowContentAccess(false); web.getSettings().setMediaPlaybackRequiresUserGesture(false); web.setWebViewClient(new WebViewClient() { @Override public boolean shouldOverrideUrlLoading(WebView view, String url) { return !url.startsWith(endpoint.url); } @Override public void onPageFinished(WebView view, String url) { ready = true; view.requestFocus(); immersive(); } }); setContentView(new FrameLayout(this) {{ addView(web, new FrameLayout.LayoutParams(-1,-1)); }}); web.loadUrl(endpoint.url); }
    @Override public boolean dispatchKeyEvent(KeyEvent event) { if (ready && web != null && event.getAction() == KeyEvent.ACTION_DOWN) { int code = event.getKeyCode(); if (code == KeyEvent.KEYCODE_DPAD_UP || code == KeyEvent.KEYCODE_DPAD_DOWN || code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER) { web.evaluateJavascript("window.MingmingTVKey&&window.MingmingTVKey(" + code + ");", null); return true; } } return super.dispatchKeyEvent(event); }
    @Override protected void onResume() { super.onResume(); immersive(); if (web != null) { web.onResume(); web.evaluateJavascript("window.MingmingTVForeground&&window.MingmingTVForeground()", null); } }
    @Override public void onBackPressed() {
        if (!ready || web == null) { super.onBackPressed(); return; }
        web.evaluateJavascript("window.MingmingTVBack?window.MingmingTVBack():false", new ValueCallback<String>() {
            @Override public void onReceiveValue(String handled) { if (!"true".equals(handled)) MainActivity.super.onBackPressed(); }
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
    @Override protected void onPause() { cancelPhoneInput(); if (web != null) { web.evaluateJavascript("window.MingmingTVBackground&&window.MingmingTVBackground()", null); web.onPause(); } super.onPause(); }
    @Override protected void onDestroy() { if (web != null) { web.destroy(); web = null; } if (isFinishing()) stopService(new Intent(this, CoreService.class)); super.onDestroy(); }
}
