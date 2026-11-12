#!/bin/sh
# The image's entrypoint: hand every argument to the gaugeline CLI and become it (exec), so its
# exit code (0, 1, 2) and its signals reach docker unchanged. No arguments: the help.
set -eu
if [ "$#" -eq 0 ]; then
  set -- --help
fi
exec gaugeline "$@"
