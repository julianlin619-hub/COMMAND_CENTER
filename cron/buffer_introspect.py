"""One-off Buffer GraphQL introspection diagnostic (manual, not scheduled).

Confirms the assumptions that core/buffer.py and cron/buffer_reconcile.py make
about Buffer's schema — without relying on Buffer's docs site, which blocks
automated fetching. Use it once against live Buffer (with your token set) to:

  - dump the exact `PostStatus` enum values, so
    cron/buffer_reconcile.py::_is_failure_status can match the real failure
    value(s) instead of substring-matching 'error'/'fail';
  - dump the `MutationError` interface's member types, so the inline fragments
    in core/buffer.py::send_to_buffer match the real createPost result types;
  - optionally print the live state of a given Buffer post id.

It also prints guidance for confirming the `RATE_LIMIT_EXCEEDED` error's
`extensions` shape that core/buffer.py::_graphql_rate_limited reads.

NOT registered in render.yaml — run manually:
    python -m cron.buffer_introspect [<buffer_post_id>]
"""

import os
import sys

# _buffer_request is module-private but this diagnostic lives in the same
# project and deliberately pokes at raw GraphQL, so importing it is intentional.
from core.buffer import _buffer_request, get_buffer_post_state


def _print_enum_values(type_name: str) -> None:
    """Print the enum values of a GraphQL type (or note it isn't an enum)."""
    data = _buffer_request(
        "query Introspect($n: String!) { __type(name: $n) { kind enumValues { name } } }",
        {"n": type_name},
    )
    t = data.get("__type")
    if not t:
        print(f"  {type_name}: not found in schema")
        return
    values = [v["name"] for v in (t.get("enumValues") or [])]
    print(f"  {type_name} (kind={t.get('kind')}): {values or '— no enum values —'}")


def _print_possible_types(type_name: str) -> None:
    """Print the concrete member types of a GraphQL union/interface."""
    data = _buffer_request(
        "query Introspect($n: String!) { __type(name: $n) { kind possibleTypes { name } } }",
        {"n": type_name},
    )
    t = data.get("__type")
    if not t:
        print(f"  {type_name}: not found in schema")
        return
    names = [p["name"] for p in (t.get("possibleTypes") or [])]
    print(f"  {type_name} (kind={t.get('kind')}): {names or '— no member types —'}")


def _print_channels() -> None:
    """Print all channels in the Buffer org, grouped by service."""
    org = os.environ.get("BUFFER_ORG_ID", "")
    if not org:
        print("  BUFFER_ORG_ID not set — cannot list channels")
        return
    data = _buffer_request(
        """
        query GetChannels($orgId: OrganizationId!) {
            channels(input: { organizationId: $orgId }) {
                id
                service
                name
            }
        }
        """,
        {"orgId": org},
    )
    channels = data.get("channels", [])
    if not channels:
        print("  No channels found (check BUFFER_ORG_ID and BUFFER_ACCESS_TOKEN)")
        return
    # Group by service so LinkedIn × 2 is obvious at a glance.
    by_service: dict[str, list[dict]] = {}
    for c in channels:
        by_service.setdefault(c.get("service", "unknown"), []).append(c)
    for service in sorted(by_service):
        for c in by_service[service]:
            print(f"  {service:12s}  name={c.get('name')!r:30s}  id={c.get('id')}")


def main() -> None:
    print("== Buffer schema introspection ==\n")

    print("PostStatus enum (tighten _is_failure_status to the real failure value):")
    _print_enum_values("PostStatus")

    print("\ncreatePost error types (should cover the fragments in send_to_buffer):")
    _print_possible_types("MutationError")

    print("\nBuffer channels (all orgs → all connected accounts):")
    _print_channels()

    # If a post id is supplied, show what get_buffer_post_state returns for a
    # real post — handy for eyeballing the actual `status` string in context.
    if len(sys.argv) > 1:
        post_id = sys.argv[1]
        print(f"\nLive state for Buffer post {post_id}:")
        print(f"  {get_buffer_post_state(post_id)}")

    print(
        "\nRate-limit shape: to confirm _graphql_rate_limited, trigger a "
        "RATE_LIMIT_EXCEEDED error (a burst of requests) and inspect the GraphQL "
        "error's `extensions` — verify the code is 'RATE_LIMIT_EXCEEDED' and note "
        "the wait-hint field name (we read extensions.retryAfter / retry_after)."
    )


if __name__ == "__main__":
    main()
