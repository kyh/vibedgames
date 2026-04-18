#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json

from _fal_common import platform_get, platform_post, require_fal_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Query fal platform APIs for image models, pricing, usage, and request audit.")
    subparsers = parser.add_subparsers(dest="command", required=True)

    search = subparsers.add_parser("search", help="Search or fetch fal model metadata.")
    search.add_argument("--endpoint-id", action="append", default=None, help="Specific endpoint id. Repeatable.")
    search.add_argument("--query", default=None, help="Free-text model search.")
    search.add_argument("--category", default=None, help="Model category filter.")
    search.add_argument("--status", default=None, help="Model status filter.")
    search.add_argument("--expand", action="append", default=None, help="Expansion values such as openapi-3.0.")
    search.add_argument("--limit", type=int, default=20)

    pricing = subparsers.add_parser("pricing", help="Fetch pricing for one or more endpoints.")
    pricing.add_argument("--endpoint-id", action="append", required=True)

    estimate = subparsers.add_parser("estimate", help="Estimate unit-price cost for one or more endpoints.")
    estimate.add_argument("--endpoint-id", action="append", required=True)
    estimate.add_argument("--unit-quantity", type=float, default=1.0, help="Billing units per endpoint.")

    usage = subparsers.add_parser("usage", help="Fetch usage summaries.")
    usage.add_argument("--endpoint-id", action="append", default=None)
    usage.add_argument("--start", default=None)
    usage.add_argument("--end", default=None)
    usage.add_argument("--timeframe", default=None)
    usage.add_argument("--expand", action="append", default=["summary"])
    usage.add_argument("--limit", type=int, default=50)

    analytics = subparsers.add_parser("analytics", help="Fetch analytics summaries.")
    analytics.add_argument("--endpoint-id", action="append", default=None)
    analytics.add_argument("--start", default=None)
    analytics.add_argument("--end", default=None)
    analytics.add_argument("--timeframe", default=None)
    analytics.add_argument("--expand", action="append", default=["summary", "time_series", "request_count"])
    analytics.add_argument("--limit", type=int, default=50)

    requests = subparsers.add_parser("requests", help="Fetch request audit records by endpoint.")
    requests.add_argument("--endpoint-id", required=True)
    requests.add_argument("--request-id", default=None)
    requests.add_argument("--status", default=None)
    requests.add_argument("--start", default=None)
    requests.add_argument("--end", default=None)
    requests.add_argument("--expand", action="append", default=None)
    requests.add_argument("--limit", type=int, default=20)

    return parser.parse_args()


def main() -> None:
    args = parse_args()
    api_key = require_fal_key()

    if args.command == "search":
        response = platform_get(
            "/models",
            api_key,
            {
                "endpoint_id": args.endpoint_id,
                "q": args.query,
                "category": args.category,
                "status": args.status,
                "expand": args.expand,
                "limit": args.limit,
            },
        )
    elif args.command == "pricing":
        response = platform_get("/models/pricing", api_key, {"endpoint_id": args.endpoint_id})
    elif args.command == "estimate":
        endpoints = {endpoint_id: {"unit_quantity": args.unit_quantity} for endpoint_id in args.endpoint_id}
        response = platform_post("/models/pricing/estimate", api_key, {"estimate_type": "unit_price", "endpoints": endpoints})
    elif args.command == "usage":
        response = platform_get(
            "/models/usage",
            api_key,
            {
                "endpoint_id": args.endpoint_id,
                "start": args.start,
                "end": args.end,
                "timeframe": args.timeframe,
                "expand": args.expand,
                "limit": args.limit,
            },
        )
    elif args.command == "analytics":
        response = platform_get(
            "/models/analytics",
            api_key,
            {
                "endpoint_id": args.endpoint_id,
                "start": args.start,
                "end": args.end,
                "timeframe": args.timeframe,
                "expand": args.expand,
                "limit": args.limit,
            },
        )
    else:
        response = platform_get(
            "/models/requests/by-endpoint",
            api_key,
            {
                "endpoint_id": args.endpoint_id,
                "request_id": args.request_id,
                "status": args.status,
                "start": args.start,
                "end": args.end,
                "expand": args.expand,
                "limit": args.limit,
            },
        )

    print(json.dumps(response.payload, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()

