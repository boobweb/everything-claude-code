#!/usr/bin/env bash
# Copies the fixture into the run's empty working directory (each run gets a fresh copy).
set -eu
cp -R "$(dirname "$0")/../fixtures/multi/." .
