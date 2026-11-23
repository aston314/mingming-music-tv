package com.aston.mingmingmusic;

import androidx.media3.common.PlaybackException;
import org.junit.Test;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

public final class PlaybackDiagnosticsTest {
    @Test public void retriesTransientNetworkAndSourceFailuresTwice() {
        assertTrue(PlaybackDiagnostics.isRetryable(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED));
        assertTrue(PlaybackDiagnostics.isRetryable(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT));
        assertTrue(PlaybackDiagnostics.isRetryable(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS));
        assertTrue(PlaybackDiagnostics.isRetryable(PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE));
        assertFalse(PlaybackDiagnostics.isRetryable(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED));
        assertEquals(2, PlaybackDiagnostics.MAX_SOURCE_RETRIES);
    }

    @Test public void classifiesFailuresWithoutIncludingSensitiveDetails() {
        assertEquals("network", PlaybackDiagnostics.kind(PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT));
        assertEquals("source", PlaybackDiagnostics.kind(PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS));
        assertEquals("decode", PlaybackDiagnostics.kind(PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED));
        assertEquals("unknown", PlaybackDiagnostics.kind(PlaybackException.ERROR_CODE_UNSPECIFIED));
    }
}
