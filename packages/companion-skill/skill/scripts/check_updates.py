#!/usr/bin/env python3
"""Compatibility wrapper for the Companion bootstrap health check."""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import bootstrap  # noqa: E402


if __name__ == "__main__":
    bootstrap.main()
