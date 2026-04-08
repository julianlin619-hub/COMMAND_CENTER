"""Custom exception hierarchy for COMMAND_CENTER.

Why custom exceptions?
    Python's built-in exceptions (ValueError, RuntimeError, etc.) are too
    generic — if a platform API returns a 429 (rate limit), we want to handle
    that differently from a 401 (auth failure) or a file download error.

    By defining a hierarchy of custom exceptions, callers can catch exactly
    the error type they care about:

        try:
            platform.create_post(post)
        except PlatformRateLimitError:
            # wait and retry (see core/retry.py)
        except PlatformAuthError:
            # refresh the OAuth token and retry once
        except PlatformAPIError:
            # log and mark the post as failed

    All of them inherit from CommandCenterError, so you can also catch
    *everything* with a single `except CommandCenterError` when you just
    want a general safety net.
"""


class CommandCenterError(Exception):
    """Base exception for all COMMAND_CENTER errors.

    Every custom exception below inherits from this, so catching
    CommandCenterError will catch any error raised by this project.
    """


class PlatformAuthError(CommandCenterError):
    """Authentication failed or token expired.

    Raised when a platform returns 401/403, meaning the access token is
    invalid or expired. The caller should try refreshing the OAuth token
    (see core/auth.py) and retry the request once.
    """


class PlatformRateLimitError(CommandCenterError):
    """Rate limit exceeded. Includes retry_after if available.

    Raised when a platform returns 429 Too Many Requests.
    """

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        # retry_after is the number of seconds the platform told us to wait
        # before trying again. Some APIs include this in a "Retry-After"
        # header; others don't (in which case this will be None, and the
        # retry decorator falls back to exponential backoff).
        self.retry_after = retry_after


class PlatformAPIError(CommandCenterError):
    """Generic platform API error.

    Used for non-auth, non-rate-limit API failures (5xx server errors,
    unexpected response formats, etc.).
    """

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        # Storing the HTTP status code lets callers decide how to react —
        # e.g. a 500 might be worth retrying, but a 400 probably isn't.
        self.status_code = status_code


class MediaProcessingError(CommandCenterError):
    """Failed to process media (download, resize, transcode).

    Raised during the media pipeline — downloading from Supabase Storage,
    converting file formats, or uploading to the platform. Separate from
    PlatformAPIError because media issues are usually local (disk space,
    file corruption) rather than API problems.
    """
