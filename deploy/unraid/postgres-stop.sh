#!/bin/sh
set -eu
docker stop --time 30 spotcheckmd-postgres
docker rm spotcheckmd-postgres
