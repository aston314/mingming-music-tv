package com.aston.mingmingmusic;

final class CoreEndpoint {
    final String url;
    final String instance;
    private CoreEndpoint(int port, String instance) { this.url = "http://127.0.0.1:" + port + "/"; this.instance = instance; }
    static CoreEndpoint parse(String line, String expected) {
        if (line == null || !line.startsWith("MINGMING_MUSIC_READY ")) return null;
        String[] p = line.substring("MINGMING_MUSIC_READY ".length()).trim().split(" ");
        if (p.length != 2 || !expected.equals(p[1])) return null;
        try { int port = Integer.parseInt(p[0]); return port > 0 && port < 65536 ? new CoreEndpoint(port, expected) : null; } catch (Exception e) { return null; }
    }
}
