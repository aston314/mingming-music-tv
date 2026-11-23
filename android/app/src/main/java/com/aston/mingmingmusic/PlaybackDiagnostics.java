package com.aston.mingmingmusic;

import androidx.media3.common.PlaybackException;

/** Classifies player failures without exposing source URLs or resolver secrets. */
final class PlaybackDiagnostics {
    // Three resolver/player attempts absorb the occasional empty or expired
    // upstream result without making the user press Play again.
    static final int MAX_SOURCE_RETRIES = 2;

    private PlaybackDiagnostics() {}

    static boolean isRetryable(int errorCode) {
        return errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT
                || errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                || errorCode == PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE;
    }

    static String kind(int errorCode) {
        if (errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_FAILED
                || errorCode == PlaybackException.ERROR_CODE_IO_NETWORK_CONNECTION_TIMEOUT) {
            return "network";
        }
        if (errorCode == PlaybackException.ERROR_CODE_IO_BAD_HTTP_STATUS
                || errorCode == PlaybackException.ERROR_CODE_IO_INVALID_HTTP_CONTENT_TYPE) {
            return "source";
        }
        if (errorCode == PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED) {
            return "decode";
        }
        return "unknown";
    }
}
