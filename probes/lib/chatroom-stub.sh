#!/bin/sh
# Probe stand-in for the `chatroom` executable: only the `hook` subcommand exists.
exec "${CHATROOM_NODE:-node}" "$CHATROOM_PROBE_HOOK" "$@"
