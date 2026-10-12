package com.aston.mingmingmusic;

import org.junit.Test;
import static org.junit.Assert.*;

public class CoreEndpointTest {
    @Test public void acceptsReadySignalForThisInstance() {
        CoreEndpoint endpoint = CoreEndpoint.parse("MINGMING_MUSIC_READY 61509 test-instance", "test-instance");
        assertNotNull(endpoint);
        assertEquals("http://127.0.0.1:61509/", endpoint.url);
    }
    @Test public void rejectsOtherInstanceAndInvalidPorts() {
        assertNull(CoreEndpoint.parse("MINGMING_MUSIC_READY 1234 old-instance", "test-instance"));
        for (String port : new String[] {"0", "65536", "-1", "NaN"}) {
            assertNull(CoreEndpoint.parse("MINGMING_MUSIC_READY " + port + " test-instance", "test-instance"));
        }
        assertNull(CoreEndpoint.parse("starting", "test-instance"));
    }
}
