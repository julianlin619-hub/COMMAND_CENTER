"""Custom exception hierarchy for COMMAND_CENTER."""


class CommandCenterError(Exception):
    """Base exception for all COMMAND_CENTER errors."""


class PlatformAuthError(CommandCenterError):
    """Authentication failed or token expired."""


class PlatformRateLimitError(CommandCenterError):
    """Rate limit exceeded. Includes retry_after if available."""

    def __init__(self, message: str, retry_after: float | None = None):
        super().__init__(message)
        self.retry_after = retry_after


class PlatformAPIError(CommandCenterError):
    """Generic platform API error."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


class MediaProcessingError(CommandCenterError):
    """Failed to process media (download, resize, transcode)."""
