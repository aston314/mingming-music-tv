package com.aston.mingmingmusic;

import org.junit.Test;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Random;
import static org.junit.Assert.*;

public final class PlaybackQueueTest {
    private final List<String> ids = Arrays.asList("a", "b", "c");
    @Test public void wrapsInBothDirections() {
        assertEquals(0, PlaybackQueue.next(ids, "c", "list", 1, true, new Random(1)));
        assertEquals(2, PlaybackQueue.next(ids, "a", "list", -1, false, new Random(1)));
    }
    @Test public void repeatOnlyAtAutomaticEndAndOnlyIfStillInQueue() {
        assertEquals(1, PlaybackQueue.next(ids, "b", "one", 1, true, new Random(1)));
        assertEquals(2, PlaybackQueue.next(ids, "b", "one", 1, false, new Random(1)));
        assertEquals(0, PlaybackQueue.next(ids, "deleted", "one", 1, true, new Random(1)));
    }
    @Test public void shuffleNeverRepeatsWhenThereAreAlternatives() {
        for (int seed = 0; seed < 100; seed++) assertNotEquals(1, PlaybackQueue.next(ids, "b", "shuffle", 1, true, new Random(seed)));
        assertEquals(0, PlaybackQueue.next(Collections.singletonList("b"), "b", "shuffle", 1, true, new Random(1)));
    }
    @Test public void emptyQueueStopsEvenWithRepeatEnabled() {
        assertEquals(-1, PlaybackQueue.next(Collections.<String>emptyList(), "b", "one", 1, true, new Random(1)));
    }
}
