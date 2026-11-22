package com.aston.mingmingmusic;

import android.content.Context;
import android.content.SharedPreferences;
import android.webkit.JavascriptInterface;

/** Persistent display preferences for the WebView UI. */
final class MingmingTVPreferences {
    private static final String STORE = "MingmingMusicPreferences";
    private final SharedPreferences preferences;

    MingmingTVPreferences(Context context) {
        preferences = context.getSharedPreferences(STORE, Context.MODE_PRIVATE);
    }

    @JavascriptInterface
    public String get(String key, String fallback) {
        if (!allowed(key)) return fallback == null ? "" : fallback;
        String value = preferences.getString(key, null);
        return value == null ? (fallback == null ? "" : fallback) : value;
    }

    @JavascriptInterface
    public void set(String key, String value) {
        if (!allowed(key)) return;
        preferences.edit().putString(key, value == null ? "" : value).apply();
    }

    private boolean allowed(String key) {
        return key != null && key.indexOf("mingming.") == 0 && key.length() < 96;
    }
}
