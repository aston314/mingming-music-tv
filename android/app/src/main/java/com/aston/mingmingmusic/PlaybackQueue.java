package com.aston.mingmingmusic;

import java.util.List;
import java.util.Random;

/** Queue policy also runs when no Activity or WebView is alive. */
final class PlaybackQueue {
    private PlaybackQueue() {}
    static int next(List<String> ids, String current, String mode, int direction, boolean ended, Random random) {
        if (ids.isEmpty()) return -1;
        int index = ids.indexOf(current);
        // A deleted current track must never be reinserted or repeated.
        if (ended && "one".equals(mode) && index >= 0) return index;
        if (ended && "shuffle".equals(mode) && ids.size() > 1 && index >= 0) {
            int pick = random.nextInt(ids.size() - 1);
            return pick >= index ? pick + 1 : pick;
        }
        if (ended && "shuffle".equals(mode)) return random.nextInt(ids.size());
        if (index < 0) return direction > 0 ? 0 : ids.size() - 1;
        return (index + direction + ids.size()) % ids.size();
    }
}
