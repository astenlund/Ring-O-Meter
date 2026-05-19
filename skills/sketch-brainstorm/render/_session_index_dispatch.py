"""Subcommand dispatcher for update-session-index.sh.

The bash wrapper handles arg parsing, repo-root resolution, and venv
preparation, then delegates the actual session_index call here. Each
subcommand maps to one session_index function; SessionIndexError raised
by any of them is translated to a stderr message + exit 1. The caller
passes its own name via --caller-name so the error prefix tracks the
wrapper's filename without a hardcoded string literal here.

Stdlib-only (argparse / pathlib / sys) plus the sibling session_index
module; runs under the existing sketch-brainstorm venv that the caller
has already prepared. No pip dependencies.
"""

import argparse
import sys
from pathlib import Path

import session_index


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="_session_index_dispatch",
        description="Apply a session_index operation against an index file.",
    )
    parser.add_argument("--index-path", required=True, type=Path)
    parser.add_argument(
        "--caller-name",
        required=True,
        help="invoking script's basename; used as the stderr error prefix",
    )
    sub = parser.add_subparsers(dest="subcommand", required=True)

    add = sub.add_parser("add", help="register a new session and make it active")
    add.add_argument("--session-dir", required=True)
    add.add_argument("--slug", required=True)

    set_active = sub.add_parser("set-active", help="promote an existing session to active")
    set_active.add_argument("--session-dir", required=True)

    increment = sub.add_parser("increment-turn", help="advance the named session's turns counter")
    increment.add_argument("--session-dir", required=True)

    args = parser.parse_args(argv)

    try:
        if args.subcommand == "add":
            session_index.add_session(
                args.index_path,
                session_dir=args.session_dir,
                slug=args.slug,
            )
        elif args.subcommand == "set-active":
            session_index.set_active(
                args.index_path,
                session_dir=args.session_dir,
            )
        elif args.subcommand == "increment-turn":
            session_index.increment_turns(
                args.index_path,
                session_dir=args.session_dir,
            )
        else:
            # argparse's required=True on the subparser group makes this
            # unreachable in production; the assert exists so a future
            # subparser addition that forgets the matching elif fails
            # loudly instead of silently returning 0.
            raise AssertionError(f"unhandled subcommand: {args.subcommand!r}")
    except session_index.SessionIndexError as exc:
        print(f"{args.caller_name}: {exc}", file=sys.stderr)
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
