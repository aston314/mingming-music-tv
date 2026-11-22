package com.aston.mingmingmusic;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.Gravity;
import android.webkit.JavascriptInterface;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/** Native online update flow: fetch, verify, then hand the APK to Android. */
final class MingmingAppUpdater {
    interface Host { boolean trusted(); boolean foreground(); void restoreFocus(); }
    private static final long MAX_APK_BYTES = 100L * 1024L * 1024L;
    private static final long CHECK_INTERVAL = 24L * 60L * 60L * 1000L;
    private final Activity activity; private final Host host; private final SharedPreferences preferences;
    private final ExecutorService worker = Executors.newSingleThreadExecutor(); private final AtomicInteger generation = new AtomicInteger();
    private final File directory; private final File partial; private final File apk;
    private volatile HttpURLConnection connection; private volatile String snapshot = "{}";
    private boolean started, checking, downloading, destroyed; private String state = "idle", message = "";
    private Manifest latest; private AlertDialog dialog; private ProgressBar progress; private TextView progressText;

    MingmingAppUpdater(Activity value, Host valueHost) {
        activity = value; host = valueHost; preferences = activity.getSharedPreferences("MingmingMusicUpdates", Activity.MODE_PRIVATE);
        directory = new File(activity.getCacheDir(), "app-updates"); partial = new File(directory, "update.part"); apk = new File(directory, "update.apk");
        publish();
    }
    private static final class Manifest {
        final int code, minSdk; final long bytes; final String name, packageName, sha256, url, notes;
        Manifest(JSONObject json) throws Exception {
            if (json.optInt("schema", 0) != 1) throw new IOException("不支持的版本信息格式");
            code = json.getInt("version_code"); minSdk = json.getInt("min_sdk"); bytes = json.getLong("size");
            name = json.getString("version_name"); packageName = json.getString("package_name"); sha256 = json.getString("sha256").toLowerCase(Locale.ROOT);
            url = json.getString("download_url"); notes = json.optString("release_notes", "");
            if (!BuildConfig.APPLICATION_ID.equals(packageName) || code <= BuildConfig.VERSION_CODE || minSdk < 23 || minSdk > Build.VERSION.SDK_INT
                    || bytes <= 0 || bytes > MAX_APK_BYTES || !sha256.matches("[a-f0-9]{64}")
                    || !name.matches("[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?")) throw new IOException("版本信息不完整或不匹配");
            String expected = "https://github.com/aston314/mingming-music-tv/releases/download/v" + name + "/mingming-music-tv-" + name + ".apk";
            if (!expected.equals(url)) throw new IOException("安装包地址不是明明音乐正式发行文件");
        }
    }
    final class Bridge {
        @JavascriptInterface public String getStatus() { return host.trusted() ? snapshot : "{}"; }
        @JavascriptInterface public void check() { if (host.trusted()) activity.runOnUiThread(new Runnable() { @Override public void run() { checkNow(true); } }); }
    }
    void start() {
        if (started || destroyed) return; started = true; directory.mkdirs(); partial.delete();
        if (BuildConfig.DEBUG) { state = "unsupported"; message = "调试版不覆盖更新，请使用正式版"; publish(); return; }
        long now = System.currentTimeMillis(), last = preferences.getLong("last_auto_attempt", 0);
        if (last <= 0 || now < last || now - last >= CHECK_INTERVAL) { preferences.edit().putLong("last_auto_attempt", now).apply(); checkNow(false); }
    }
    private void checkNow(final boolean manual) {
        if (destroyed || checking || downloading || BuildConfig.DEBUG) return;
        checking = true; state = "checking"; message = "正在检查更新…"; publish(); final int epoch = generation.incrementAndGet();
        worker.execute(new Runnable() { @Override public void run() {
            Manifest found = null; String error = "暂时无法连接更新服务，请稍后重试";
            try { found = fetchManifest(epoch); } catch (Exception failure) { error = friendly(failure); }
            final Manifest result = found; final String failure = error;
            activity.runOnUiThread(new Runnable() { @Override public void run() {
                if (!valid(epoch)) return; checking = false;
                if (result == null) { state = "error"; message = "检查失败：" + failure; publish(); return; }
                latest = result; preferences.edit().putString("manifest", result.name).apply();
                state = "available"; message = "发现新版本 " + result.name; publish(); if (manual) showUpdatePrompt(result);
            } });
        } });
    }
    private Manifest fetchManifest(int epoch) throws Exception {
        String endpoint = BuildConfig.UPDATE_ENDPOINT; if (endpoint == null || endpoint.length() == 0) throw new IOException("未配置更新地址");
        HttpURLConnection request = open(endpoint + (endpoint.indexOf('?') >= 0 ? "&" : "?") + "check=" + System.currentTimeMillis(), epoch);
        try (InputStream stream = request.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096]; int count; while ((count = stream.read(buffer)) != -1) { ensureValid(epoch); if (output.size() + count > 65536) throw new IOException("版本信息过大"); output.write(buffer, 0, count); }
            return new Manifest(new JSONObject(output.toString("UTF-8")));
        } finally { request.disconnect(); if (connection == request) connection = null; }
    }
    private HttpURLConnection open(String address, int epoch) throws Exception {
        URL target = new URL(address); if (!"https".equals(target.getProtocol()) || !"github.com".equals(target.getHost())) throw new IOException("更新连接必须使用 GitHub HTTPS");
        HttpURLConnection request = (HttpURLConnection) target.openConnection(); connection = request; request.setConnectTimeout(8000); request.setReadTimeout(15000); request.setInstanceFollowRedirects(true); request.setUseCaches(false); request.setRequestProperty("Cache-Control", "no-cache"); request.setRequestProperty("User-Agent", "MingmingMusic/" + BuildConfig.VERSION_NAME); ensureValid(epoch); int code = request.getResponseCode(); String host = request.getURL().getHost(); if (code != 200 || !("github.com".equals(host) || "objects.githubusercontent.com".equals(host) || "release-assets.githubusercontent.com".equals(host))) throw new IOException("更新服务返回 HTTP " + code); return request;
    }
    private void showUpdatePrompt(final Manifest target) {
        if (dialog != null || destroyed || !host.foreground()) return;
        AlertDialog next = new AlertDialog.Builder(activity).setTitle("发现新版本 " + target.name).setMessage((target.notes.length() == 0 ? "明明音乐有新版本可以安装。" : target.notes) + "\n\n覆盖升级会保留账号和播放记录。")
                .setNegativeButton("稍后", null).setPositiveButton("立即更新", null).create();
        next.setOnShowListener(d -> { next.getButton(AlertDialog.BUTTON_NEGATIVE).requestFocus(); next.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> beginDownload(target)); }); show(next);
    }
    private void show(AlertDialog next) {
        dialog = next; next.setOnDismissListener(d -> { if (dialog == next) dialog = null; if (!destroyed) host.restoreFocus(); }); next.show();
    }
    private void beginDownload(final Manifest target) {
        if (downloading) return; if (dialog != null) { AlertDialog old = dialog; dialog = null; old.dismiss(); }
        downloading = true; state = "downloading"; message = "正在下载 " + target.name; publish(); final int epoch = generation.incrementAndGet();
        LinearLayout panel = new LinearLayout(activity); panel.setOrientation(LinearLayout.VERTICAL); int pad = Math.round(24 * activity.getResources().getDisplayMetrics().density); panel.setPadding(pad, pad, pad, pad);
        progressText = new TextView(activity); progressText.setText("正在连接下载服务…"); progressText.setTextSize(17); progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal); progress.setIndeterminate(true); progress.setMax(100); panel.addView(progressText); panel.addView(progress, new LinearLayout.LayoutParams(-1, -2));
        AlertDialog next = new AlertDialog.Builder(activity).setTitle("下载更新").setView(panel).setNegativeButton("取消", (d, which) -> cancelDownload()).create(); next.setOnCancelListener(d -> cancelDownload()); show(next);
        worker.execute(new Runnable() { @Override public void run() { download(target, epoch); } });
    }
    private void download(Manifest target, int epoch) {
        String error = "下载暂时不可用";
        try {
            directory.mkdirs(); partial.delete(); HttpURLConnection request = open(target.url, epoch);
            try (InputStream input = request.getInputStream(); FileOutputStream output = new FileOutputStream(partial)) {
                String lengthText = request.getHeaderField("Content-Length"); if (lengthText != null && Long.parseLong(lengthText) != target.bytes) throw new IOException("安装包大小不匹配");
                byte[] buffer = new byte[32768]; long total = 0; int count; long last = 0; while ((count = input.read(buffer)) != -1) { ensureValid(epoch); total += count; if (total > target.bytes) throw new IOException("安装包超过版本信息大小"); output.write(buffer, 0, count); long now = System.currentTimeMillis(); if (now - last > 250) { updateProgress(total, target.bytes, epoch); last = now; } }
            } finally { request.disconnect(); if (connection == request) connection = null; }
            ensureValid(epoch); if (partial.length() != target.bytes || !target.sha256.equals(hash(partial))) throw new IOException("安装包校验失败"); verifyArchive(target, partial); if (apk.exists()) apk.delete(); if (!partial.renameTo(apk)) throw new IOException("无法保存安装包");
            activity.runOnUiThread(new Runnable() { @Override public void run() { if (!valid(epoch)) return; downloading = false; state = "ready"; message = "安装包已验证，准备安装"; publish(); dismissDialog(); launchInstaller(target); } });
        } catch (Exception failure) { error = friendly(failure); partial.delete(); final String text = error; activity.runOnUiThread(new Runnable() { @Override public void run() { if (!valid(epoch)) return; downloading = false; state = "error"; message = "下载失败：" + text; publish(); dismissDialog(); showFailure(message); } }); }
    }
    private void updateProgress(final long bytes, final long total, final int epoch) { activity.runOnUiThread(new Runnable() { @Override public void run() { if (!valid(epoch) || progress == null) return; int percent = (int) (bytes * 100 / Math.max(1, total)); progress.setIndeterminate(false); progress.setProgress(percent); if (progressText != null) progressText.setText(String.format(Locale.ROOT, "已下载 %.1f / %.1f MB · %d%%", bytes / 1048576.0, total / 1048576.0, percent)); publish(); } }); }
    private void verifyArchive(Manifest target, File value) throws Exception { PackageManager manager = activity.getPackageManager(); PackageInfo archive = manager.getPackageArchiveInfo(value.getPath(), PackageManager.GET_SIGNATURES); PackageInfo installed = manager.getPackageInfo(activity.getPackageName(), PackageManager.GET_SIGNATURES); if (archive == null || !installed.packageName.equals(archive.packageName) || archive.versionCode != target.code || !target.name.equals(archive.versionName) || !sameSigners(installed.signatures, archive.signatures)) throw new IOException("安装包应用、版本或签名不匹配"); }
    private boolean sameSigners(Signature[] a, Signature[] b) throws Exception { if (a == null || b == null || a.length == 0 || a.length != b.length) return false; String[] left = new String[a.length], right = new String[b.length]; for (int i = 0; i < a.length; i++) { left[i] = hex(MessageDigest.getInstance("SHA-256").digest(a[i].toByteArray())); right[i] = hex(MessageDigest.getInstance("SHA-256").digest(b[i].toByteArray())); } java.util.Arrays.sort(left); java.util.Arrays.sort(right); return java.util.Arrays.equals(left, right); }
    private String hash(File value) throws Exception { MessageDigest digest = MessageDigest.getInstance("SHA-256"); try (InputStream input = new FileInputStream(value)) { byte[] buffer = new byte[32768]; int count; while ((count = input.read(buffer)) != -1) digest.update(buffer, 0, count); } return hex(digest.digest()); }
    private void launchInstaller(Manifest target) { if (!apk.isFile() || destroyed) return; if (Build.VERSION.SDK_INT >= 26 && !activity.getPackageManager().canRequestPackageInstalls()) { show(new AlertDialog.Builder(activity).setTitle("允许安装更新").setMessage("请在系统设置中允许明明音乐安装更新，然后返回继续安装。").setNegativeButton("稍后", null).setPositiveButton("去设置", (d, which) -> activity.startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.getPackageName())))).create()); return; } try { Intent install = new Intent(Intent.ACTION_VIEW); install.setDataAndType(Uri.parse("content://" + activity.getPackageName() + ".updates/apk"), "application/vnd.android.package-archive"); install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION); activity.startActivity(install); } catch (Exception failure) { showFailure("设备无法打开系统安装界面"); } }
    private void showFailure(String text) { if (dialog != null || destroyed || !host.foreground()) return; show(new AlertDialog.Builder(activity).setTitle("更新未完成").setMessage(text).setPositiveButton("知道了", null).create()); }
    private void cancelDownload() { generation.incrementAndGet(); HttpURLConnection active = connection; if (active != null) active.disconnect(); downloading = false; state = latest == null ? "idle" : "available"; message = "已取消下载"; publish(); }
    private void dismissDialog() { if (dialog != null) { AlertDialog old = dialog; dialog = null; old.dismiss(); } progress = null; progressText = null; }
    private boolean valid(int epoch) { return !destroyed && generation.get() == epoch; }
    private void ensureValid(int epoch) throws IOException { if (!valid(epoch)) throw new IOException("更新操作已取消"); }
    private String friendly(Exception value) { return value.getMessage() == null ? "网络或文件校验失败" : value.getMessage(); }
    private static String hex(byte[] bytes) { StringBuilder out = new StringBuilder(bytes.length * 2); for (byte value : bytes) out.append(String.format(Locale.ROOT, "%02x", value & 255)); return out.toString(); }
    private void publish() { try { JSONObject value = new JSONObject(); value.put("supported", !BuildConfig.DEBUG); value.put("current_version", BuildConfig.VERSION_NAME); value.put("current_code", BuildConfig.VERSION_CODE); value.put("state", state); value.put("message", message); value.put("latest_version", latest == null ? "" : latest.name); value.put("latest_code", latest == null ? 0 : latest.code); value.put("size", latest == null ? 0 : latest.bytes); snapshot = value.toString(); } catch (Exception ignored) {} }
    void resume() { if (!destroyed) publish(); }
    boolean back() { if (dialog == null || !dialog.isShowing()) return false; dialog.cancel(); return true; }
    void destroy() { destroyed = true; generation.incrementAndGet(); HttpURLConnection active = connection; if (active != null) active.disconnect(); dismissDialog(); worker.shutdownNow(); }
}
